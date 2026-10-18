// Point d'entrée exécutable : `npm run start -w @wnext/api` (voir README). Variables : voir config.ts.
import pg from "pg";
import { devAuthenticate } from "./auth-dev";
import { createJwtVerifier, oidcAuthenticate, remoteJwks } from "./auth-oidc";
import { loadConfig } from "./config";
import { pgDb } from "./pg-db";
import { pgNotifier } from "./pg-listen";
import { startServer } from "./server";

async function main() {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", source: "pool", error: err.message }))); // connexion inactive perdue : ne pas planter
  const db = pgDb(pool, { role: config.dbRole });
  const authenticate = config.oidc
    ? oidcAuthenticate({ db, verifier: createJwtVerifier({ issuer: config.oidc.issuer, audience: config.oidc.audience, keys: remoteJwks({ url: config.oidc.jwksUrl }) }) })
    : devAuthenticate;
  const running = await startServer({
    db,
    authenticate,
    host: config.host,
    port: config.port,
    pollIntervalMs: config.pollIntervalMs,
    maxPerAccount: config.wsMaxPerAccount,
    ticketSecret: config.wsTicketSecret,
    rateLimits: config.rateLimits,
    notifier: pgNotifier({
      createClient: () => new pg.Client({ connectionString: config.databaseUrl }),
      onError: (err) => console.error(JSON.stringify({ level: "error", source: "listen", error: err instanceof Error ? err.message : String(err) })),
    }),
  });
  console.log(JSON.stringify({ level: "info", msg: "api démarrée", host: config.host, port: running.port, authMode: config.authMode }));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: "info", msg: "arrêt", signal }));
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await running.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "arrêt en échec", error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
