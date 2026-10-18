import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Db, RequestContext } from "./db";
import { createHttpServer } from "./http";
import { attachRealtime } from "./ws";

export interface StartOptions {
  db: Db;
  authenticate: (headers: IncomingHttpHeaders) => Promise<RequestContext | null>;
  host?: string;
  port?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
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
  const server = createHttpServer({ db: opts.db, authenticate: opts.authenticate, newRequestId: randomUUID, onError });
  const realtime = attachRealtime(server, { db: opts.db, authenticate: opts.authenticate, pollIntervalMs: opts.pollIntervalMs, heartbeatMs: opts.heartbeatMs, onError });
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
