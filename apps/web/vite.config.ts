// Build de l'écran (ADR-005 : React + DOM virtualisé). `npm run dev -w @wnext/web` ouvre la démo locale (src/demo.ts).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react()] });
