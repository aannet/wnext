// Build de l'écran (ADR-005 : React + DOM virtualisé). `npm run dev -w @wnext/web` : écran branché sur l'API locale
// (`npm run dev:stack` à la racine), `?demo=1` pour la démo sans API (src/demo.ts).
// Proxy de développement : /api (REST et WebSocket du temps réel) vers l'API sur 127.0.0.1:3000 ; même origine pour le
// navigateur, donc ni CORS côté API ni URL d'API dans le code de l'écran. Cible surchargeable par WNEXT_API_URL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.WNEXT_API_URL ?? "http://127.0.0.1:3000";
// Version du produit (package.json, recopiée de la racine par npm run version:set) et commit court, figés au build : pied de
// l'aide des raccourcis (shell/shortcuts-help). Hors dépôt git, le commit est vide.
const version: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
let commit = "";
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* hors dépôt */ }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __WNEXT_VERSION__: JSON.stringify(version), __WNEXT_COMMIT__: JSON.stringify(commit) },
  server: { proxy: { "/api": { target: api, ws: true } } },
});
