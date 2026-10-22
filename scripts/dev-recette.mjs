#!/usr/bin/env node
// Recette avec connexion en une commande (RT-035) : `npm run dev:recette [-- --reset]`.
// Avec le jeu de données de recette (RT-044) : `npm run dev:recette:seed [-- --reset]` (= `--seed=recette`, base dédiée .dev-pg-recette/).
// Lance `dev:stack --oidc` (Postgres, migrations, jeu d'essai, fournisseur OIDC local, API en AUTH_MODE=oidc), attend que
// l'API réponde, puis Vite en VITE_AUTH_MODE=oidc avec l'issuer et l'URL d'API alignés sur les ports de la pile
// (WNEXT_DEV_API_PORT, WNEXT_DEV_IDP_PORT). Sans cela, `npm run dev -w @wnext/web` garde VITE_AUTH_MODE=dev
// (apps/web/.env.development) et l'API en OIDC répond 401 : « Session expirée ». Ctrl-C arrête l'écran puis la pile.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Commandes et variables de la recette, sans effet de bord (testé dans tests/guardrails/dev-recette.test.ts). */
export function recettePlan(env, argv) {
  const apiPort = Number(env.WNEXT_DEV_API_PORT ?? 3000);
  const idpPort = Number(env.WNEXT_DEV_IDP_PORT ?? 3010);
  const api = `http://127.0.0.1:${apiPort}`;
  return {
    stack: { args: ["scripts/dev-stack.mjs", "--oidc", ...(argv.includes("--reset") ? ["--reset"] : []), ...argv.filter((a) => a.startsWith("--seed="))] },
    web: { env: { VITE_AUTH_MODE: "oidc", VITE_OIDC_ISSUER: `http://127.0.0.1:${idpPort}`, WNEXT_API_URL: api } },
    healthUrl: `${api}/api/v1/health`,
  };
}

async function main() {
  const plan = recettePlan(process.env, process.argv.slice(2));
  const stack = spawn(process.execPath, plan.stack.args, { cwd: root, stdio: "inherit", env: process.env });
  let web = null;
  let stopping = false;

  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    if (web && web.exitCode === null) web.kill("SIGTERM");
    if (stack.exitCode === null) {
      stack.kill("SIGTERM");
      await new Promise((res) => stack.once("exit", res));
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  stack.on("exit", (code) => { if (!stopping) { console.error(`la pile s'est arrêtée (code ${code})`); void stop(code || 1); } });

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (stopping) return;
    const ok = await fetch(plan.healthUrl).then((r) => r.status < 500, () => false);
    if (ok) break;
    if (Date.now() > deadline) { console.error(`l'API ne répond pas sur ${plan.healthUrl}`); return stop(1); }
    await new Promise((res) => setTimeout(res, 500));
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  web = spawn(npm, ["run", "dev", "-w", "@wnext/web"], { cwd: root, stdio: "inherit", env: { ...process.env, ...plan.web.env } });
  web.on("exit", (code) => { if (!stopping) { console.error(`l'écran s'est arrêté (code ${code})`); void stop(code || 1); } });
  console.log("\nRecette : ouvrir l'URL « Local » affichée par Vite (http://localhost:5173/ si le port est libre), « Se connecter », compte Alec. Ctrl-C arrête tout.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
