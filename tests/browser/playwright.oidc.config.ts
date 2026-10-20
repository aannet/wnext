// Parcours de connexion OIDC réel (hors `make check` et hors `npm run test:browser`) : `npm run test:browser:oidc` à la racine.
// Lance la pile `dev:stack --oidc` (Postgres embarqué persistant .dev-pg/, fournisseur local, API en AUTH_MODE=oidc) puis
// Vite en VITE_AUTH_MODE=oidc, sur des ports dédiés pour ne pas heurter une pile de développement déjà lancée.
// Jetons d'accès de 20 s : le renouvellement par refresh_token est observé pendant le test. Mémoire : Postgres + API + Vite +
// Chromium, ~1,5 Go ; ne pas lancer pendant un `make check`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const OIDC_PORTS = {
  web: Number(process.env.WNEXT_OIDC_WEB_PORT ?? 5185),
  api: Number(process.env.WNEXT_OIDC_API_PORT ?? 3100),
  idp: Number(process.env.WNEXT_OIDC_IDP_PORT ?? 3110),
  pg: Number(process.env.WNEXT_OIDC_PG_PORT ?? 54339),
};
export const TOKEN_TTL_SEC = 20;

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "*.oidc.ts",
  outputDir: fileURLToPath(new URL("./out/results-oidc", import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${OIDC_PORTS.web}`, viewport: { width: 1600, height: 900 }, headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "node scripts/dev-stack.mjs --oidc",
      cwd: root,
      env: {
        WNEXT_DEV_PG_PORT: String(OIDC_PORTS.pg), WNEXT_DEV_API_PORT: String(OIDC_PORTS.api), WNEXT_DEV_IDP_PORT: String(OIDC_PORTS.idp),
        WNEXT_DEV_IDP_TOKEN_TTL: String(TOKEN_TTL_SEC),
      },
      url: `http://127.0.0.1:${OIDC_PORTS.api}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    },
    {
      command: `npm run dev -w @wnext/web -- --host 127.0.0.1 --port ${OIDC_PORTS.web} --strictPort`,
      cwd: root,
      env: { VITE_AUTH_MODE: "oidc", VITE_OIDC_ISSUER: `http://127.0.0.1:${OIDC_PORTS.idp}`, WNEXT_API_URL: `http://127.0.0.1:${OIDC_PORTS.api}` },
      url: `http://127.0.0.1:${OIDC_PORTS.web}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
