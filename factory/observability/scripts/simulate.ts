/**
 * Émetteur d'événements factices réalistes pour la démo (strategy.md §5).
 * Scénario : 2 lignes P0 saines + 1 ligne P0 en boucle (dépassement de budget jusqu'au plafond dur et kill-switch) + 1 ligne P0 stagnante interrompue puis relancée par le Superviseur,
 * 3 lignes P1 (retries, escalade de modèle, ligne bloquée en attente d'approbation humaine),
 * 1 doublon et 2 événements invalides (pour le taux d'invalides).
 *
 * Usage : npm run simulate -- [--url http://localhost:3100] [--delay 120] [--seed 7] [--batch 4]
 */
import { ulid } from "../src/lib/ulid";
import type { FactoryEvent } from "../src/lib/types";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const URL_BASE = args.get("url") ?? process.env.OBS_URL ?? "http://localhost:3100";
const DELAY = Number(args.get("delay") ?? 120);
const BATCH = Number(args.get("batch") ?? 4);
let seed = Number(args.get("seed") ?? 7);
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => Math.round(a + rand() * (b - a));

// Grille de prix versionnée (USD / M tokens) : in, out, cache_read, cache_write. Valeurs de démo.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
const O = "claude-opus-5-5", S = "claude-sonnet-5-5", H = "claude-haiku-5-5", F = "claude-fable-5-1";

type Draft = Omit<FactoryEvent, "ts" | "run_id"> & { _run: string };

function mk(run: string, line: string, phase: FactoryEvent["phase"], agent: string, model: string, action: string,
  o: Partial<FactoryEvent> & { cr?: number } = {}): Draft {
  const tin = o.tokens_in ?? 0, tout = o.tokens_out ?? 0, cr = o.tokens_cache_read ?? o.cr ?? 0, cw = o.tokens_cache_write ?? 0;
  const p = PRICES[model];
  const cost = p ? (tin * p[0] + tout * p[1] + cr * p[2] + cw * p[3]) / 1e6 : 0;
  const d: Draft = {
    _run: run, line, phase, agent, model, action,
    tokens_in: tin, tokens_out: tout, cost: Math.round(cost * 1e6) / 1e6,
    duration_ms: o.duration_ms ?? between(40, 900), status: o.status ?? "ok",
  };
  if (o.attempt) d.attempt = o.attempt;
  if (cr) d.tokens_cache_read = cr;
  if (cw) d.tokens_cache_write = cw;
  if (o.detail) d.detail = o.detail;
  if (o.instance_id) d.instance_id = o.instance_id;
  if (o.parent_instance_id) d.parent_instance_id = o.parent_instance_id;
  return d;
}

const llm = (run: string, line: string, ph: FactoryEvent["phase"], agent: string, model: string, attempt: number, scale = 1) =>
  mk(run, line, ph, agent, model, "llm.call", {
    attempt, tokens_in: between(6000, 20000) * scale, tokens_out: between(900, 6000) * scale,
    cr: between(20000, 90000) * scale, tokens_cache_write: between(0, 8000) * scale, duration_ms: between(4000, 25000),
  });

function healthyLine(line: string, phase: FactoryEvent["phase"], opts: { retries?: number; escalate?: boolean; blockAtEnd?: boolean } = {}): Draft[] {
  const run = ulid(Date.now(), rand);
  const ev: Draft[] = [];
  ev.push(mk(run, line, phase, "orchestrateur", "none", "session.start", { duration_ms: 12 }));
  ev.push(mk(run, line, phase, "specifieur", S, "llm.call", { tokens_in: between(8000, 15000), tokens_out: between(1500, 4000), cr: 30000, duration_ms: 9000 }));
  ev.push(mk(run, line, phase, "testeur", S, "llm.call", { tokens_in: between(10000, 18000), tokens_out: between(2000, 5000), cr: 45000, duration_ms: 12000 }));
  ev.push(mk(run, line, phase, "testeur", "none", "git.commit", { detail: { files: 3 } }));
  let model = S;
  const retries = opts.retries ?? 0;
  for (let a = 1; a <= retries + 1; a++) {
    ev.push(llm(run, line, phase, "implementeur", model, a));
    ev.push(mk(run, line, phase, "implementeur", "none", "git.commit", { attempt: a, detail: { files: between(1, 5) } }));
    const fail = a <= retries;
    ev.push(mk(run, line, phase, "sentinelle", "none", "ci.result", {
      attempt: a, status: fail ? "error" : "ok", duration_ms: between(60000, 170000),
      detail: fail ? { failed_tests: between(1, 3), error_sig: `E${between(100, 999)}` } : { failed_tests: 0 },
    }));
    if (fail) {
      ev.push(mk(run, line, phase, "orchestrateur", "none", "retry.start", { attempt: a + 1, status: "retry", duration_ms: 5 }));
      if (opts.escalate && a === retries) {
        ev.push(mk(run, line, phase, "router", "none", "escalate.model", { attempt: a + 1, status: "escalated", detail: { from: S, to: O } }));
        model = O;
      }
    }
  }
  ev.push(llm(run, line, phase, "reviseur", O, 1));
  ev.push(mk(run, line, phase, "reviseur", O, "review.verdict", { tokens_in: 4000, tokens_out: 600, cr: 20000, detail: { verdict: "approve" } }));
  if (opts.blockAtEnd) {
    ev.push(mk(run, line, phase, "integrateur", "none", "approval.wait", { status: "blocked", detail: { reason: "CODEOWNERS", path: "db/" } }));
  } else {
    ev.push(mk(run, line, phase, "integrateur", "none", "merge.done", { duration_ms: 800 }));
  }
  return ev;
}

/** Ligne en boucle : même signature d'échec, contexte énorme relu à chaque appel -> dépassement jusqu'au plafond dur. */
function loopingLine(line: string, phase: FactoryEvent["phase"]): Draft[] {
  const run = ulid(Date.now(), rand);
  const ev: Draft[] = [mk(run, line, phase, "orchestrateur", "none", "session.start", { duration_ms: 9 })];
  for (let a = 1; a <= 40; a++) {
    ev.push(mk(run, line, phase, "implementeur", O, "llm.call", {
      attempt: a, tokens_in: 55000, tokens_out: between(3000, 6000), cr: 800000, duration_ms: between(15000, 40000),
    }));
    ev.push(mk(run, line, phase, "sentinelle", "none", "ci.result", { attempt: a, status: "error", detail: { error_sig: "E417", diff_hash: "a1b2c3" } }));
    if (a === 9) {
      ev.push(mk(run, line, phase, "orchestrateur", "none", "loop.detected", { attempt: a, status: "looping", detail: { same_error_sig: "E417", repeats: 5 } }));
      ev.push(mk(run, line, phase, "depanneur", O, "llm.call", { attempt: a, tokens_in: 20000, tokens_out: 3000, cr: 60000, duration_ms: 18000 }));
    }
  }
  ev.push(mk(run, line, phase, "orchestrateur", "none", "kill.triggered", { status: "killed", detail: { reason: "plafond dur de phase" } }));
  return ev;
}

/** Ligne qui stagne : le Superviseur signale, fait évaluer, interrompt puis relance avec un contexte réduit (ADR-006), la ligne aboutit. */
function supervisedLine(line: string, phase: FactoryEvent["phase"]): Draft[] {
  const run = ulid(Date.now(), rand);
  const sup = (action: string, o: Partial<FactoryEvent> = {}) => mk(run, line, phase, "superviseur", "none", action, { duration_ms: 8, ...o });
  const ev: Draft[] = [mk(run, line, phase, "orchestrateur", "none", "session.start", { duration_ms: 9 }), sup("supervisor.tick")];
  for (let a = 1; a <= 4; a++) ev.push(llm(run, line, phase, "implementeur", S, a, 2));
  ev.push(sup("supervisor.warn", { status: "skipped", detail: { signal: "tools_without_commit", count: 21 } }));
  ev.push(llm(run, line, phase, "implementeur", S, 5, 2));
  ev.push(sup("supervisor.assess", { detail: { verdict: "restart", cause: "meme_erreur_non_resolue" } }));
  ev.push(mk(run, line, phase, "depanneur", O, "llm.call", { attempt: 5, tokens_in: 12000, tokens_out: 1500, cr: 40000, duration_ms: 12000 }));
  ev.push(sup("supervisor.interrupt", { status: "killed", detail: { agent: "implementeur", minutes_no_progress: 46 } }));
  ev.push(sup("supervisor.restart", { status: "retry", detail: { change: "contexte_reduit" } }));
  ev.push(llm(run, line, phase, "implementeur", S, 6));
  ev.push(mk(run, line, phase, "implementeur", "none", "git.commit", { attempt: 6, detail: { files: 2 } }));
  ev.push(mk(run, line, phase, "sentinelle", "none", "ci.result", { attempt: 6, detail: { failed_tests: 0 } }));
  ev.push(llm(run, line, phase, "reviseur", O, 1));
  ev.push(mk(run, line, phase, "reviseur", O, "review.verdict", { tokens_in: 4000, tokens_out: 600, cr: 20000, detail: { verdict: "approve" } }));
  ev.push(mk(run, line, phase, "integrateur", "none", "merge.done", { duration_ms: 800 }));
  ev.push(mk(run, line, phase, "introspecteur", S, "retro.done", { tokens_in: 9000, tokens_out: 1200, cr: 20000, duration_ms: 9000, detail: { findings: 1, recommendations: 1 } }));
  return ev;
}

/**
 * Ligne pilotée par un orchestrateur qui lance des agents, dont certains lancent eux-mêmes des sous-agents
 * (instance_id / parent_instance_id). Les sous-agents d'exploration tournent en parallèle ; le dernier reste ouvert.
 */
function orchestratedLine(line: string, phase: FactoryEvent["phase"]): Draft[] {
  const run = ulid(Date.now(), rand);
  const id = (n: string) => `${line}.${n}`;
  const inst = (name: string, parent?: string) => ({ instance_id: id(name), ...(parent ? { parent_instance_id: id(parent) } : {}) });
  const start = (agent: string, model: string, name: string, parent?: string, subagent_type?: string) =>
    mk(run, line, phase, agent, model, "agent.start", { duration_ms: 5, ...inst(name, parent), ...(subagent_type ? { detail: { subagent_type } } : {}) });
  const stop = (agent: string, model: string, name: string, parent?: string) =>
    mk(run, line, phase, agent, model, "agent.stop", { duration_ms: 5, ...inst(name, parent) });
  const call = (agent: string, model: string, name: string, parent?: string, scale = 1) => ({ ...llm(run, line, phase, agent, model, 1, scale), ...inst(name, parent) });
  return [
    start("orchestrateur", "none", "orch"),
    start("implementeur", S, "impl", "orch"),
    start("implementeur", H, "explore-1", "impl", "Explore"),
    start("implementeur", H, "explore-2", "impl", "Explore"),
    call("implementeur", S, "impl", "orch"),
    call("implementeur", H, "explore-1", "impl", 0.3),
    call("implementeur", H, "explore-2", "impl", 0.3),
    stop("implementeur", H, "explore-1", "impl"),
    start("implementeur", S, "tests-sub", "impl", "general-purpose"),
    call("implementeur", S, "tests-sub", "impl", 0.5),
    stop("implementeur", H, "explore-2", "impl"),
    call("implementeur", S, "impl", "orch"),
    stop("implementeur", S, "tests-sub", "impl"),
    stop("implementeur", S, "impl", "orch"),
    start("reviseur", O, "review", "orch"),
    call("reviseur", O, "review", "orch"),
  ];
}

/** Événements hors ligne : plan de phase (architecte) et rapport de gate (scribe). */
function phaseLine(phase: FactoryEvent["phase"], agent: "architecte" | "scribe", model: string, action: string): Draft[] {
  const run = ulid(Date.now(), rand);
  return [mk(run, "_phase", phase, agent, model, action, { tokens_in: between(6000, 12000), tokens_out: between(1500, 4000), cr: 20000, duration_ms: between(8000, 20000) })];
}

const scripts: Draft[][] = [
  phaseLine("P0", "architecte", F, "llm.call"),
  phaseLine("P1", "architecte", F, "llm.call"),
  healthyLine("P0-001", "P0"),
  healthyLine("P0-002", "P0", { retries: 1 }),
  loopingLine("P0-003", "P0"),
  supervisedLine("P0-004", "P0"),
  healthyLine("P1-001", "P1", { retries: 2, escalate: true }),
  healthyLine("P1-002", "P1"),
  healthyLine("P1-003", "P1", { blockAtEnd: true }),
  orchestratedLine("P1-004", "P1"),
  phaseLine("P0", "scribe", H, "gate.report"),
];

// Entrelacement round-robin (les lignes sont parallèles).
const queue: Draft[] = [];
for (let i = 0; scripts.some((s) => i < s.length); i++) for (const s of scripts) if (i < s.length) queue.push(s[i]);

let lastTs = 0;
function finalize(d: Draft): FactoryEvent {
  lastTs = Math.max(Date.now(), lastTs + 1);
  const { _run, ...rest } = d;
  return { ts: new Date(lastTs).toISOString(), run_id: _run, ...rest } as FactoryEvent;
}

async function post(lines: unknown[]) {
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  const r = await fetch(`${URL_BASE}/api/events`, { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body });
  const j = (await r.json()) as { accepted: number; duplicates: number; invalid: number };
  return j;
}

async function main() {
  const t = { accepted: 0, duplicates: 0, invalid: 0 };
  let n = 0, prev: FactoryEvent | undefined;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  console.log(`Simulation : ${queue.length} événements vers ${URL_BASE} (delay ${DELAY} ms, batch ${BATCH})`);
  for (let i = 0; i < queue.length; i += BATCH) {
    const out: unknown[] = queue.slice(i, i + BATCH).map(finalize);
    prev = out[out.length - 1] as FactoryEvent;
    n += out.length;
    // Anomalies volontaires : at-least-once (doublon) et événements invalides (rejetés et comptés).
    if (i === BATCH * 6) out.push(prev);
    if (i === BATCH * 10) out.push({ ...(prev as object), ts: "hier", run_id: "pas-un-ulid" });
    if (i === BATCH * 14) out.push('{"ligne": illisible');
    const r = await post(out);
    t.accepted += r.accepted; t.duplicates += r.duplicates; t.invalid += r.invalid;
    if (DELAY) await sleep(DELAY);
  }
  console.log(`Terminé : ${n} émis, acceptés=${t.accepted} doublons=${t.duplicates} invalides=${t.invalid}`);
}

main().catch((e) => { console.error("Échec de la simulation :", e.message); process.exit(1); });
