#!/usr/bin/env node
/**
 * Hook Claude Code -> événements d'observabilité (POST /api/events).
 * Branché sur SessionStart, SubagentStart, PostToolUse, SubagentStop, SessionEnd (voir README).
 * Ne bloque jamais la session : toute erreur est avalée, code de sortie 0.
 *
 * Instances : session = `session_id` ; sous-agent = `agent_id`, parent = la session.
 * Contexte (posé par l'orchestrateur dans l'environnement du `claude -p`) :
 *   OBS_URL (http://localhost:3100)  OBS_RUN_ID (ULID)  OBS_LINE  OBS_PHASE  OBS_AGENT (rôle)
 *   OBS_PARENT_INSTANCE (instance de l'orchestrateur qui a lancé la session)  OBS_MODEL (repli)
 * Sans OBS_RUN_ID, le run_id est dérivé du session_id : une session ordinaire apparaît sous `_global`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PRICES_URL = new URL("../config/prices.json", import.meta.url);

/** ULID stable dérivé d'une chaîne (26 car. Crockford). */
export function ulidFrom(seed) {
  const h = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += ALPHABET[h[i] % 32];
  return out;
}

/** Somme les usages d'un transcript JSONL (dédoublonnés par message.id). */
export function sumTranscript(text) {
  const seen = new Set();
  const t = { tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, model: null };
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o?.message;
    if (o?.type !== "assistant" || !m?.usage || (m.id && seen.has(m.id))) continue;
    if (m.id) seen.add(m.id);
    t.tokens_in += m.usage.input_tokens ?? 0;
    t.tokens_out += m.usage.output_tokens ?? 0;
    t.tokens_cache_read += m.usage.cache_read_input_tokens ?? 0;
    t.tokens_cache_write += m.usage.cache_creation_input_tokens ?? 0;
    if (m.model) t.model = m.model;
  }
  return t;
}

export function costOf(model, t, prices) {
  const p = prices?.[model];
  if (!Array.isArray(p)) return 0;
  const usd = (t.tokens_in * p[0] + t.tokens_out * p[1] + t.tokens_cache_read * p[2] + t.tokens_cache_write * p[3]) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeId = (s) => (typeof s === "string" && ID.test(s) ? s : typeof s === "string" ? s.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || undefined : undefined);

/**
 * Charge utile de hook -> 0 ou 1 événement. Pur (lectures injectées) pour être testable.
 * @param {Record<string, any>} p  payload JSON du hook
 * @param {Record<string, string | undefined>} env
 * @param {{ now?: Date, readFile?: (path: string) => string | null, prices?: Record<string, number[]> }} [io]
 */
export function buildEvent(p, env, io = {}) {
  const now = io.now ?? new Date();
  const readFile = io.readFile ?? ((f) => { try { return readFileSync(f, "utf8"); } catch { return null; } });
  const sid = p.session_id;
  const kind = p.hook_event_name;
  if (!sid || !kind) return null;

  const isSub = !!p.agent_id;
  const phase = /^P[0-5]$/.test(env.OBS_PHASE ?? "") ? env.OBS_PHASE : "P0";
  const line = /^(P[0-5]-\d{3}|_phase|_global)$/.test(env.OBS_LINE ?? "") ? env.OBS_LINE : "_global";
  const base = {
    ts: now.toISOString(),
    run_id: /^[0-9A-HJKMNP-TV-Z]{26}$/.test(env.OBS_RUN_ID ?? "") ? env.OBS_RUN_ID : ulidFrom(sid),
    line, phase,
    agent: env.OBS_AGENT || "implementeur",
    model: env.OBS_MODEL || "none",
    tokens_in: 0, tokens_out: 0, cost: 0, duration_ms: 0, status: "ok",
  };
  const inst = (id, parent) => ({ instance_id: safeId(id), ...(parent ? { parent_instance_id: safeId(parent) } : {}) });
  const sessionInst = inst(sid, env.OBS_PARENT_INSTANCE);
  const subInst = isSub ? inst(p.agent_id, sid) : null;

  const withUsage = (e, file) => {
    const text = file ? readFile(file) : null;
    if (text == null) return e;
    const t = sumTranscript(text);
    const model = t.model ?? e.model;
    const out = { ...e, model, tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost: costOf(model, t, io.prices) };
    if (t.tokens_cache_read) out.tokens_cache_read = t.tokens_cache_read;
    if (t.tokens_cache_write) out.tokens_cache_write = t.tokens_cache_write;
    return out;
  };

  switch (kind) {
    case "SessionStart":
      return { ...base, ...sessionInst, action: "agent.start", detail: { source: String(p.source ?? "startup").slice(0, 40) } };
    case "SubagentStart":
      return { ...base, ...subInst, action: "agent.start", detail: { subagent_type: String(p.agent_type ?? "inconnu").slice(0, 60) } };
    case "PostToolUse":
      return { ...base, ...(subInst ?? sessionInst), action: "tool.exec", duration_ms: Math.max(0, Math.round(p.duration_ms ?? 0)), detail: { tool: String(p.tool_name ?? "?").slice(0, 60) } };
    case "SubagentStop":
      return withUsage({ ...base, ...subInst, action: "agent.stop", detail: { subagent_type: String(p.agent_type ?? "inconnu").slice(0, 60) } }, p.agent_transcript_path);
    case "SessionEnd":
      return withUsage({ ...base, ...sessionInst, action: "agent.stop", detail: { reason: String(p.reason ?? "?").slice(0, 60) } }, p.transcript_path);
    default:
      return null;
  }
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  let prices;
  try { prices = JSON.parse(readFileSync(PRICES_URL, "utf8")); } catch { /* coût à 0 */ }
  const e = buildEvent(payload, process.env, { prices });
  if (!e) return;
  const url = `${process.env.OBS_URL ?? "http://localhost:3100"}/api/events`;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(1500) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {}).finally(() => process.exit(0));
}
