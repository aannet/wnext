#!/usr/bin/env node
// Pile de développement locale : `npm run dev:stack [-- --reset] [-- --oidc] [-- --seed=dev|recette|vide]`.
//  * --seed=recette : jeu de données de recette (scripts/seed-recette.mjs, RT-044) sur un répertoire DÉDIÉ .dev-pg-recette/ ;
//    --seed=vide : un compte vide avec Alec owner (scripts/seed-vide.mjs), répertoire .dev-pg-vide/. Les données de .dev-pg/ ne sont jamais
//    touchées : le répertoire (WNEXT_DEV_PG_DIR compris) est validé AVANT toute suppression ou démarrage, la base AVANT toute écriture
//    (scripts/dev-profile.mjs). L'IdP local propose les comptes du profil. Sans l'option : jeu d'essai (scripts/dev-seed.mjs).
//  * --oidc : démarre aussi le fournisseur OIDC local (scripts/dev-idp.mjs, port WNEXT_DEV_IDP_PORT, défaut 3010) et lance
//    l'API en AUTH_MODE=oidc (OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URL pointant vers lui). Sans l'option : AUTH_MODE=dev.
//  * Postgres embarqué PERSISTANT dans .dev-pg/ (ignoré par git ; WNEXT_DEV_PG_DIR pour un autre dossier), port fixe (WNEXT_DEV_PG_PORT, défaut 54329).
//  * Migrations (scripts/migrate.mjs) puis jeu d'essai idempotent (scripts/dev-seed.mjs).
//  * API en AUTH_MODE=dev par défaut (port WNEXT_DEV_API_PORT, défaut 3000), connectée en superutilisateur avec DB_ROLE=app_user :
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
import { startDevIdp } from "./dev-idp.mjs";
import { DEV_IDS, DEV_USERS, seedDev } from "./dev-seed.mjs";
import { migrate } from "./migrate.mjs";
import { PROFILE_DIRS, ProfileError, checkDataDir, inspectDb, writeMarker } from "./dev-profile.mjs";
import { RECETTE_IDS, RECETTE_SPEC, RECETTE_USERS, seedRecette } from "./seed-recette.mjs";
import { VIDE_IDS, VIDE_SPEC, VIDE_USERS, seedVide } from "./seed-vide.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedArg = process.argv.find((a) => a.startsWith("--seed="))?.slice("--seed=".length) ?? "dev";
const profiles = {
  dev: { seed: seedDev, users: DEV_USERS, ids: DEV_IDS, label: "jeu d'essai" },
  recette: { seed: seedRecette, users: RECETTE_USERS, ids: RECETTE_IDS, spec: RECETTE_SPEC, label: "jeu de recette" },
  vide: { seed: seedVide, users: VIDE_USERS, ids: VIDE_IDS, spec: VIDE_SPEC, label: "compte vide" },
};
const profile = profiles[seedArg];
if (!profile) {
  console.error(`--seed=${seedArg} inconnu (dev, recette ou vide)`);
  process.exit(1);
}
let pgDir;
let markerMissing = false;
try {
  ({ pgDir, markerMissing } = checkDataDir({ root, profile: seedArg, env: process.env }));
} catch (err) {
  if (!(err instanceof ProfileError)) throw err;
  console.error(`démarrage impossible : ${err.message}`);
  process.exit(1);
}
const dataDir = join(pgDir, "data");
const pgPort = Number(process.env.WNEXT_DEV_PG_PORT ?? 54329);
const apiPort = Number(process.env.WNEXT_DEV_API_PORT ?? 3000);
const reset = process.argv.includes("--reset");
const oidc = process.argv.includes("--oidc");
const idpPort = Number(process.env.WNEXT_DEV_IDP_PORT ?? 3010);
// Durée des jetons d'accès (s) : 300 par défaut ; plus court pour observer le renouvellement.
const idpTtl = process.env.WNEXT_DEV_IDP_TOKEN_TTL ? Number(process.env.WNEXT_DEV_IDP_TOKEN_TTL) : undefined;
let idp = null;
const url = `postgres://postgres:postgres@127.0.0.1:${pgPort}/wnext`;

// Une seconde pile sur les mêmes ports (et surtout un --reset sous un Postgres vivant) corromprait la première.
const busy = (port) => new Promise((res) => {
  const s = connect({ host: "127.0.0.1", port });
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
});
for (const [name, port] of [["Postgres", pgPort], ["API", apiPort], ...(oidc ? [["fournisseur OIDC", idpPort]] : [])]) {
  if (await busy(port)) {
    console.error(`le port ${port} (${name}) est déjà utilisé : une pile tourne peut-être déjà (WNEXT_DEV_PG_PORT / WNEXT_DEV_API_PORT pour changer)`);
    process.exit(1);
  }
}

if (reset) rmSync(pgDir, { recursive: true, force: true });
// Profils dédiés : le marqueur est posé à la création du répertoire (réinitialisé par --reset), jamais sur un répertoire existant.
if (seedArg !== "dev" && (markerMissing || reset)) writeMarker(pgDir, seedArg);

const server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });
let api = null;
let client = null;
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
  await client?.end().catch(() => {}); // sinon l'arrêt de Postgres coupe la connexion : « terminating connection » non géré
  await idp?.close().catch(() => {});
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

  client = new pg.Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  if (profile.spec) await inspectDb(client, profile.spec, seedArg); // lecture seule, avant extensions et migrations
  await client.query("CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS citext;");
  await migrate(client, { root, log: (m) => console.log(`migration : ${m}`) });
  const seeded = await profile.seed(client);
  console.log(seeded ? `${profile.label} : semé` : `${profile.label} : déjà présent`);
  await client.end();
  client = null;
} catch (err) {
  console.error(`démarrage impossible : ${err instanceof Error ? err.message : err}`);
  await stop(1);
}

if (!stopping && oidc) {
  try {
    idp = await startDevIdp({ port: idpPort, tokenTtlSec: idpTtl, users: profile.users });
  } catch (err) {
    console.error(`fournisseur OIDC impossible à démarrer : ${err instanceof Error ? err.message : err}`);
    await stop(1);
  }
}

if (!stopping) {
  const auth = oidc
    ? { AUTH_MODE: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: idp.audience, OIDC_JWKS_URL: `${idp.issuer}/jwks` }
    : { AUTH_MODE: "dev" };
  api = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(root, "apps", "api"),
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DB_ROLE: "app_user", HOST: "127.0.0.1", PORT: String(apiPort), ...auth, WS_TICKET_SECRET: process.env.WS_TICKET_SECRET ?? "dev-only-secret-dev-only-secret-0123456789" },
  });
  api.on("exit", (code) => { if (!stopping) { console.error(`l'API s'est arrêtée (code ${code})`); void stop(1); } });
  const identity = oidc
    ? `Fournisseur OIDC : ${idp.issuer} (client ${idp.clientId}, audience ${idp.audience}, utilisateurs : ${profile.users.map((u) => u.subject).join(", ")}).
Écran en OIDC : VITE_AUTH_MODE=oidc VITE_OIDC_ISSUER=${idp.issuer} npm run dev -w @wnext/web (ou tout en une commande : npm run dev:recette)`
    : `Valeurs VITE_DEV_* (déjà dans apps/web/.env.development) :
  VITE_DEV_ACCOUNT_ID=${profile.ids.accountId}
  VITE_DEV_USER_ID=${profile.ids.userId}
  VITE_DEV_ROLE=${profile.ids.role}
Écran : npm run dev -w @wnext/web`;
  console.log(`
Pile prête : Postgres :${pgPort} (${pgDir === join(root, PROFILE_DIRS[seedArg]) ? `${PROFILE_DIRS[seedArg]}/` : pgDir}), API http://127.0.0.1:${apiPort} (AUTH_MODE=${auth.AUTH_MODE}).
${identity}   |   Ctrl-C pour tout arrêter.`);
}
