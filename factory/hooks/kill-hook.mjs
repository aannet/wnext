#!/usr/bin/env node
/**
 * Hook PreToolUse : refuse tout appel d'outil (exit 2) si `factory/KILL` existe et émet `kill.triggered`.
 * Sans KILL : exit 0 sans sortie. L'émission est au mieux (POST OBS_URL/api/events, et JSONL si OBS_EVENTS_FILE) :
 * un échec d'émission ne change jamais la décision (le refus est prioritaire).
 * Contexte : mêmes variables OBS_* que obs-hook.mjs ; FACTORY_KILL_FILE pour les tests.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isKilled } from "../lib/kill.mjs";
import { ulidFrom } from "../observability/hooks/obs-hook.mjs";

export function buildKillEvent(p, env, now = new Date()) {
  const line = /^(P[0-5]-\d{3}|_phase|_global)$/.test(env.OBS_LINE ?? "") ? env.OBS_LINE : "_global";
  const sid = String(p.session_id ?? "inconnue").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return {
    ts: now.toISOString(),
    run_id: /^[0-9A-HJKMNP-TV-Z]{26}$/.test(env.OBS_RUN_ID ?? "") ? env.OBS_RUN_ID : ulidFrom(p.session_id ?? "inconnue"),
    line, phase: /^P[0-5]$/.test(env.OBS_PHASE ?? "") ? env.OBS_PHASE : "P0",
    agent: env.OBS_AGENT || "implementeur", model: env.OBS_MODEL || "none",
    action: "kill.triggered", tokens_in: 0, tokens_out: 0, cost: 0, duration_ms: 0, status: "killed",
    instance_id: sid, detail: { tool: String(p.tool_name ?? "?").slice(0, 60) },
  };
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (!isKilled()) return 0;
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* payload illisible : on refuse quand même */ }
  const e = buildKillEvent(payload, process.env);
  if (process.env.OBS_EVENTS_FILE) { try { appendFileSync(process.env.OBS_EVENTS_FILE, JSON.stringify(e) + "\n"); } catch { /* au mieux */ } }
  if (process.env.OBS_URL) {
    try { await fetch(`${process.env.OBS_URL}/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(1500) }); } catch { /* au mieux */ }
  }
  process.stderr.write("KILL switch actif : appel d'outil refusé (seul un humain peut lever le kill-switch)\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => 2).then((c) => process.exit(c));
}
