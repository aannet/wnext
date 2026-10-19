import type { IncomingHttpHeaders, Server } from "node:http";
import { REALTIME_PATH, REALTIME_RETRY_AFTER_SECONDS, REALTIME_TICKET_PARAM, REALTIME_UPGRADE_STATUS, type RealtimeServerMessage } from "@wnext/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { createChangeHub, type ChangeNotifier } from "./change-hub";
import type { Db, RequestContext } from "./db";
import { createRealtimeSession } from "./realtime";
import type { RateLimiter } from "./rate-limit";
import type { TicketService } from "./tickets";

// Adaptateur WebSocket de la session temps réel (contrat : packages/contracts/src/realtime.ts). Il ne fait que du transport :
// authentification à l'upgrade (le compte vient de la session, jamais d'un message), texte -> session.receive,
// messages de la session -> texte JSON, battement de cœur, fermeture propre.

export interface RealtimeAttachOptions {
  db: Db;
  authenticate: (headers: IncomingHttpHeaders) => Promise<RequestContext | null>;
  pollIntervalMs?: number;
  /** Réveil par LISTEN/NOTIFY ; le sondage ne sert alors que de filet (voir ChangeHub). */
  notifier?: ChangeNotifier;
  /** Période des ping ; une connexion qui ne répond pas avant le suivant est coupée. */
  heartbeatMs?: number;
  /** Connexions simultanées par compte (défaut 200) ; au-delà, l'upgrade est refusé en 429 avec Retry-After (contrat realtime). */
  maxPerAccount?: number;
  /** Tickets d'upgrade (`?ticket=`) pour les clients sans en-tête ; absent = seuls les en-têtes authentifient. */
  tickets?: Pick<TicketService, "redeem">;
  /** Limite de débit des tentatives de connexion authentifiées, par compte ; refus en 429 avec Retry-After. Absent = pas de limite. */
  upgradeLimiter?: RateLimiter;
  onError?: (err: unknown) => void;
}

export const DEFAULT_MAX_PER_ACCOUNT = 200;
const MAX_MESSAGE_BYTES = 4096; // le seul message client (subscribe) tient en une centaine d'octets

export function attachRealtime(server: Server, opts: RealtimeAttachOptions): { close(): void } {
  // Un seul sondage pour toutes les sessions (sans période, pas de flux direct : les tests appellent poll à la main).
  const hub = opts.pollIntervalMs ? createChangeHub({ db: opts.db, intervalMs: opts.pollIntervalMs, notifier: opts.notifier, onError: opts.onError }) : undefined;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const reject = (socket: import("node:stream").Duplex, status: string, extra = "") => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  // Plafond par compte : une place est réservée dès l'authentification (avant tout await) et rendue à la fermeture de la socket,
  // y compris si l'upgrade échoue ; des upgrades simultanés ne peuvent donc pas dépasser le plafond.
  const max = opts.maxPerAccount ?? DEFAULT_MAX_PER_ACCOUNT;
  const open = new Map<string, number>();
  const reserve = (accountId: string): (() => void) | null => {
    const n = open.get(accountId) ?? 0;
    if (n >= max) return null;
    open.set(accountId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (open.get(accountId) ?? 1) - 1;
      if (left <= 0) open.delete(accountId); else open.set(accountId, left);
    };
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== REALTIME_PATH) return reject(socket, "404 Not Found");
    // Avec `?ticket=`, le ticket est la seule preuve : il ne se combine pas avec les en-têtes, et un paramètre répété est refusé.
    const tickets = url.searchParams.getAll(REALTIME_TICKET_PARAM);
    const identity = tickets.length === 0 || !opts.tickets
      ? opts.authenticate(req.headers)
      : Promise.resolve(tickets.length === 1 ? opts.tickets.redeem(tickets[0]!) : null);
    identity.then(
      (ctx) => {
        if (!ctx) return reject(socket, `${REALTIME_UPGRADE_STATUS.unauthenticated} Unauthorized`);
        // Après l'authentification (un anonyme ne consomme rien) et avant la réservation d'une place : un refus ne retient pas de connexion.
        const wait = opts.upgradeLimiter?.hit(ctx.accountId) ?? 0;
        if (wait > 0) return reject(socket, `${REALTIME_UPGRADE_STATUS.tooManyConnections} Too Many Requests`, `Retry-After: ${Math.max(wait, REALTIME_RETRY_AFTER_SECONDS)}\r\n`);
        const release = reserve(ctx.accountId);
        if (!release) return reject(socket, `${REALTIME_UPGRADE_STATUS.tooManyConnections} Too Many Requests`, `Retry-After: ${REALTIME_RETRY_AFTER_SECONDS}\r\n`);
        socket.once("close", release);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, ctx));
      },
      (err) => { opts.onError?.(err); reject(socket, "500 Internal Server Error"); },
    );
  });

  wss.on("connection", (ws: WebSocket, ctx: RequestContext) => {
    const session = createRealtimeSession({
      db: opts.db,
      ctx,
      hub,
      send: (m: RealtimeServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
      onEnd: () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); },
    });
    ws.on("message", (data, isBinary) => {
      const raw = isBinary ? "\u0000" : data.toString("utf8"); // binaire : refusé comme illisible
      session.receive(raw).catch((err) => { opts.onError?.(err); ws.terminate(); });
    });
    ws.on("close", () => session.close());
    // Erreurs de protocole du client (WS_ERR_*, ex. message > maxPayload) : `ws` ferme déjà la connexion (1002, 1009) ;
    // ce n'est pas une erreur interne, et la journaliser laisserait un client inonder les journaux.
    ws.on("error", (err) => {
      if (!String((err as { code?: unknown }).code ?? "").startsWith("WS_ERR_")) opts.onError?.(err);
      session.close();
    });
  });

  const beat = opts.heartbeatMs ?? 30_000;
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (ws) => { alive.add(ws); ws.on("pong", () => alive.add(ws)); });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  }, beat);
  timer.unref();

  return {
    close() {
      clearInterval(timer);
      hub?.close();
      for (const ws of wss.clients) ws.close(1001); // going away
      wss.close();
    },
  };
}
