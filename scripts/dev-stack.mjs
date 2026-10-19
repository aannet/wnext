#!/usr/bin/env node
// Pile de développement locale : `npm run dev:stack [-- --reset]`.
//  * Postgres embarqué PERSISTANT dans .dev-pg/ (ignoré par git), port fixe (WNEXT_DEV_PG_PORT, défaut 54329).
//  * Migrations (scripts/migrate.mjs) puis jeu d'essai idempotent (scripts/dev-seed.mjs).
//  * API en AUTH_MODE=dev (port WNEXT_DEV_API_PORT, défaut 3000), connectée en superutilisateur avec DB_ROLE=app_user :
//    la RLS s'applique comme en production (SET LOCAL ROLE par transaction).
//  * Affiche les valeurs VITE_DEV_* ; Ctrl-C / SIGTERM arrête l'API puis Postgres. --reset repart d'une base vide.
// Écran : `npm run dev -w @wnext/web` (proxy /api vers l'API ; apps/web/.env.development porte les ids du jeu d'essai).
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { DEV_IDS, seedDev } from "./dev-seed.mjs";
import { migrate } from "./migrate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pgDir = join(root, ".dev-pg");
const dataDir = join(pgDir, "data");
const pgPort = Number(process.env.WNEXT_DEV_PG_PORT ?? 54329);
const apiPort = Number(process.env.WNEXT_DEV_API_PORT ?? 3000);
const reset = process.argv.includes("--reset");
const url = `postgres://postgres:postgres@127.0.0.1:${pgPort}/wnext`;

// Une seconde pile sur les mêmes ports (et surtout un --reset sous un Postgres vivant) corromprait la première.
const busy = (port) => new Promise((res) => {
  const s = connect({ host: "127.0.0.1", port });
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
});
for (const [name, port] of [["Postgres", pgPort], ["API", apiPort]]) {
  if (await busy(port)) {
    console.error(`le port ${port} (${name}) est déjà utilisé : une pile tourne peut-être déjà (WNEXT_DEV_PG_PORT / WNEXT_DEV_API_PORT pour changer)`);
    process.exit(1);
  }
}

if (reset) rmSync(pgDir, { recursive: true, force: true });

const server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });
let api = null;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log("\narrêt de la pile...");
  if (api && api.exitCode === null) {
    api.kill("SIGTERM");
    await new Promise((res) => {
      const t = setTimeout(() => { api.kill("SIGKILL"); res(); }, 12_000);
      api.once("exit", () => { clearTimeout(t); res(); });
    });
  }
  await server.stop().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  if (!existsSync(join(dataDir, "PG_VERSION"))) await server.initialise();
  await server.start();
  const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres` });
  await admin.connect();
  const has = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'wnext'");
  await admin.end();
  if (has.rowCount === 0) await server.createDatabase("wnext");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS citext;");
  await migrate(client, { root, log: (m) => console.log(`migration : ${m}`) });
  const seeded = await seedDev(client);
  console.log(seeded ? "jeu d'essai : semé" : "jeu d'essai : déjà présent");
  await client.end();
} catch (err) {
  console.error(`démarrage impossible : ${err instanceof Error ? err.message : err}`);
  await stop(1);
}

if (!stopping) {
  // TZ=UTC : schedule.ts / write.ts lisent les DATE pg en Date locale puis toISOString() ; hors UTC (ex. Europe/Paris) les dates reculent d un jour.
  api = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(root, "apps", "api"),
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DB_ROLE: "app_user", HOST: "127.0.0.1", PORT: String(apiPort), AUTH_MODE: "dev", TZ: "UTC", WS_TICKET_SECRET: process.env.WS_TICKET_SECRET ?? "dev-only-secret-dev-only-secret-0123456789" },
  });
  api.on("exit", (code) => { if (!stopping) { console.error(`l'API s'est arrêtée (code ${code})`); void stop(1); } });
  console.log(`
Pile prête : Postgres :${pgPort} (.dev-pg/), API http://127.0.0.1:${apiPort} (AUTH_MODE=dev).
Valeurs VITE_DEV_* (déjà dans apps/web/.env.development) :
  VITE_DEV_ACCOUNT_ID=${DEV_IDS.accountId}
  VITE_DEV_USER_ID=${DEV_IDS.userId}
  VITE_DEV_ROLE=${DEV_IDS.role}
Écran : npm run dev -w @wnext/web   |   Ctrl-C pour tout arrêter.`);
}
