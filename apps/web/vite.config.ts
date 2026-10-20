// Build de l'écran (ADR-005 : React + DOM virtualisé). `npm run dev -w @wnext/web` : écran branché sur l'API locale
// (`npm run dev:stack` à la racine), `?demo=1` pour la démo sans API (src/demo.ts).
// Proxy de développement : /api (REST et WebSocket du temps réel) vers l'API sur 127.0.0.1:3000 ; même origine pour le
// navigateur, donc ni CORS côté API ni URL d'API dans le code de l'écran. Cible surchargeable par WNEXT_API_URL.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.WNEXT_API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": { target: api, ws: true } } },
});
