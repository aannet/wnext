import type { IncomingHttpHeaders, Server } from "node:http";
import { REALTIME_PATH, type RealtimeServerMessage } from "@wnext/contracts";
import { WebSocket, WebSocketServer } from "ws";
import type { Db, RequestContext } from "./db";
import { createRealtimeSession } from "./realtime";

// Adaptateur WebSocket de la session temps réel (contrat : packages/contracts/src/realtime.ts). Il ne fait que du transport :
// authentification à l'upgrade (le compte vient de la session, jamais d'un message), texte -> session.receive,
// messages de la session -> texte JSON, battement de cœur, fermeture propre.

export interface RealtimeAttachOptions {
  db: Db;
  authenticate: (headers: IncomingHttpHeaders) => Promise<RequestContext | null>;
  pollIntervalMs?: number;
  /** Période des ping ; une connexion qui ne répond pas avant le suivant est coupée. */
  heartbeatMs?: number;
  onError?: (err: unknown) => void;
}

const MAX_MESSAGE_BYTES = 4096; // le seul message client (subscribe) tient en une centaine d'octets

export function attachRealtime(server: Server, opts: RealtimeAttachOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const reject = (socket: import("node:stream").Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== REALTIME_PATH) return reject(socket, "404 Not Found");
    opts.authenticate(req.headers).then(
      (ctx) => {
        if (!ctx) return reject(socket, "401 Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, ctx));
      },
      (err) => { opts.onError?.(err); reject(socket, "500 Internal Server Error"); },
    );
  });

  wss.on("connection", (ws: WebSocket, ctx: RequestContext) => {
    const session = createRealtimeSession({
      db: opts.db,
      ctx,
      pollIntervalMs: opts.pollIntervalMs,
      send: (m: RealtimeServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
      onEnd: () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); },
    });
    ws.on("message", (data, isBinary) => {
      const raw = isBinary ? "\u0000" : data.toString("utf8"); // binaire : refusé comme illisible
      session.receive(raw).catch((err) => { opts.onError?.(err); ws.terminate(); });
    });
    ws.on("close", () => session.close());
    ws.on("error", (err) => { opts.onError?.(err); session.close(); });
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
      for (const ws of wss.clients) ws.close(1001); // going away
      wss.close();
    },
  };
}
