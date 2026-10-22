// Tests navigateur de l'écran Schedule (hors `make check`) : `npm run test:browser` à la racine.
// Chromium headless, un seul worker (mémoire : la VM de dev a déjà fait des OOM), Vite lancé sur la démo (?demo=1).
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const PORT = Number(process.env.WNEXT_BROWSER_PORT ?? 5183);

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "*.spec.ts",
  testIgnore: "recette.spec.ts", // la pré-recette vise la vraie pile : playwright.recette.config.ts
  outputDir: fileURLToPath(new URL("./out/results", import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1600, height: 900 }, headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `npm run dev -w @wnext/web -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: root,
    url: `http://127.0.0.1:${PORT}/?demo=1`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
