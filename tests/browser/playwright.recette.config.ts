// Pré-recette automatisée (RT-044, L-R2), hors `make check` et hors `npm run test:browser` : `npm run test:recette` à la racine.
// Rejoue en navigateur les scénarios de docs/05-project/recette/scenarios.md contre la VRAIE pile avec le seed de recette en OIDC :
// `dev-stack --seed=recette --oidc --reset` (Postgres embarqué, API en AUTH_MODE=oidc, IdP local) puis Vite en VITE_AUTH_MODE=oidc.
// Ports dédiés (distincts des défauts 54329 / 3000 / 3010 / 5173 et de la config OIDC 5185 / 3100 / 3110 / 54339) et répertoire de
// données TEMPORAIRE dédié (WNEXT_RECETTE_PG_DIR, défaut <tmp>/wnext-pw-recette) : jamais .dev-pg/ ni .dev-pg-recette/. Les garde-fous
// de scripts/dev-profile.mjs s'appliquent (répertoire absent, vide ou marqué « recette » ; chevauchement de .dev-pg/ refusé) et `--reset`
// ne supprime que ce répertoire. Mémoire : Postgres + API + IdP + Vite + Chromium, ~1,5 Go ; jamais pendant un `make check`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const RECETTE_PORTS = {
  web: Number(process.env.WNEXT_BROWSER_PORT ?? 5186),
  api: Number(process.env.WNEXT_RECETTE_API_PORT ?? 3200),
  idp: Number(process.env.WNEXT_RECETTE_IDP_PORT ?? 3210),
  pg: Number(process.env.WNEXT_RECETTE_PG_PORT ?? 54349),
};
// WNEXT_RECETTE_REUSE=1 : réutilise une pile déjà lancée à la main sur ces ports (mise au point d'un scénario ; les données ne sont alors pas remises à zéro).
const reuse = !!process.env.WNEXT_RECETTE_REUSE;
const pgDir = process.env.WNEXT_RECETTE_PG_DIR ?? join(tmpdir(), "wnext-pw-recette");

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "recette.spec.ts",
  outputDir: fileURLToPath(new URL("./out/results-recette", import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${RECETTE_PORTS.web}`, viewport: { width: 1600, height: 900 }, headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "node scripts/dev-stack.mjs --seed=recette --oidc --reset",
      cwd: root,
      env: {
        WNEXT_DEV_PG_DIR: pgDir, WNEXT_DEV_PG_PORT: String(RECETTE_PORTS.pg), WNEXT_DEV_API_PORT: String(RECETTE_PORTS.api),
        WNEXT_DEV_IDP_PORT: String(RECETTE_PORTS.idp),
      },
      url: `http://127.0.0.1:${RECETTE_PORTS.api}/api/v1/health`,
      reuseExistingServer: reuse,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    },
    {
      command: `npm run dev -w @wnext/web -- --host 127.0.0.1 --port ${RECETTE_PORTS.web} --strictPort`,
      cwd: root,
      env: { VITE_AUTH_MODE: "oidc", VITE_OIDC_ISSUER: `http://127.0.0.1:${RECETTE_PORTS.idp}`, WNEXT_API_URL: `http://127.0.0.1:${RECETTE_PORTS.api}` },
      url: `http://127.0.0.1:${RECETTE_PORTS.web}/`,
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
  ],
});
