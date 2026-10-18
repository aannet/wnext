import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ChangeNotifier } from "./change-hub";
import type { Db, RequestContext } from "./db";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from "./config";
import { createHttpServer } from "./http";
import { createRateLimiter } from "./rate-limit";
import { createTicketService } from "./tickets";
import { attachRealtime } from "./ws";

export interface StartOptions {
  db: Db;
  authenticate: (headers: IncomingHttpHeaders) => Promise<RequestContext | null>;
  host?: string;
  port?: number;
  pollIntervalMs?: number;
  notifier?: ChangeNotifier;
  heartbeatMs?: number;
  maxPerAccount?: number;
  /** Secret de signature des tickets d'upgrade (32 octets au moins), partagé par les instances ; absent = aléatoire, propre à ce processus. */
  ticketSecret?: Buffer | string;
  /** Limites de débit (tickets, tentatives de connexion) ; absent = DEFAULT_RATE_LIMITS. */
  rateLimits?: RateLimitConfig;
  /** Journal des erreurs internes : identifiant de requête et erreur, jamais le corps ni les en-têtes. */
  onError?: (err: unknown, requestId?: string) => void;
}

export interface RunningServer {
  server: Server;
  port: number;
  /** Arrêt propre : refuse les nouvelles connexions, ferme les WebSocket, attend les requêtes en cours. */
  close(): Promise<void>;
}

/** HTTP (REST) + WebSocket sur le même port. N'ouvre aucune connexion à la base : `db` est injectée. */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const onError = opts.onError ?? ((err, requestId) => console.error(JSON.stringify({ level: "error", requestId, error: err instanceof Error ? err.message : String(err) })));
  const tickets = createTicketService({ secret: opts.ticketSecret ?? randomBytes(32) });
  const limits = opts.rateLimits ?? DEFAULT_RATE_LIMITS;
  const windowMs = limits.windowSeconds * 1000;
  const ticketLimits = { perUser: createRateLimiter({ limit: limits.ticketsPerUser, windowMs }), perAccount: createRateLimiter({ limit: limits.ticketsPerAccount, windowMs }) };
  const upgradeLimiter = createRateLimiter({ limit: limits.upgradesPerAccount, windowMs });
  const server = createHttpServer({ db: opts.db, authenticate: opts.authenticate, tickets, ticketLimits, newRequestId: randomUUID, onError });
  const realtime = attachRealtime(server, { db: opts.db, authenticate: opts.authenticate, pollIntervalMs: opts.pollIntervalMs, notifier: opts.notifier, heartbeatMs: opts.heartbeatMs, maxPerAccount: opts.maxPerAccount, tickets, upgradeLimiter, onError });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => {
      realtime.close();
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeIdleConnections();
    }),
  };
}
