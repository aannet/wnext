/**
 * Run factice sans LLM (critère de sortie P0, strategy.md §1) : une ligne fictive complète
 * spec -> tests -> impl -> ci (échec) -> retry impl -> ci -> review -> merge, plus une seconde ligne tuée par le kill-switch.
 *
 * Usage : npm run dry-run                      # store en mémoire, vérifie par requêtes SQL, exit 1 si écart
 *         npm run dry-run -- --url http://localhost:3100   # POST vers un dashboard déjà lancé, vérifie via /api/summary
 * Ne lance aucun serveur.
 */
import { fileURLToPath } from "node:url";
import pricesJson from "../config/prices.json";
import { Store } from "../src/lib/store";
import { loadBudgets } from "../src/lib/config";
import { ulid } from "../src/lib/ulid";
import type { FactoryEvent } from "../src/lib/types";

const PRICES = pricesJson as unknown as Record<string, [number, number, number, number]>;
const H = "claude-haiku-5-5", S = "claude-sonnet-5-5";
export const DRY_LINE = "P0-900";
export const DRY_KILL_LINE = "P0-901";
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

const costOf = (m: string, tin: number, tout: number) => {
  const p = PRICES[m];
  return p ? Math.round(((tin * p[0] + tout * p[1]) / 1e6) * 1e6) / 1e6 : 0;
};

/** Suite déterministe (ts, run_id fixes) : rejouable sans doublon. */
export function buildDryRun(): FactoryEvent[] {
  const run = ulid(T0, () => 0.25), killRun = ulid(T0, () => 0.75);
  let i = 0;
  const e = (r: string, line: string, agent: string, model: string, action: string, o: Partial<FactoryEvent> = {}): FactoryEvent => {
    const tin = o.tokens_in ?? 0, tout = o.tokens_out ?? 0;
    return { ts: new Date(T0 + 1000 * i++).toISOString(), run_id: r, line, phase: "P0", agent, model, action,
      tokens_in: tin, tokens_out: tout, cost: costOf(model, tin, tout), duration_ms: 500, status: "ok", ...o };
  };
  const L = DRY_LINE;
  return [
    e(run, L, "specifieur", S, "llm.call", { tokens_in: 8000, tokens_out: 1500 }),
    e(run, L, "testeur", S, "llm.call", { tokens_in: 9000, tokens_out: 2500 }),
    e(run, L, "implementeur", H, "llm.call", { tokens_in: 12000, tokens_out: 3000, attempt: 1 }),
    e(run, L, "sentinelle", "none", "ci.result", { status: "error", detail: { stage: "unit" } }),
    e(run, L, "implementeur", H, "retry.start", { status: "retry", attempt: 2 }),
    e(run, L, "implementeur", H, "llm.call", { tokens_in: 14000, tokens_out: 2000, attempt: 2 }),
    e(run, L, "sentinelle", "none", "ci.result", { detail: { stage: "unit" } }),
    e(run, L, "reviseur", S, "review.verdict", { tokens_in: 7000, tokens_out: 800, detail: { verdict: "approve" } }),
    e(run, L, "integrateur", "none", "merge.done"),
    e(killRun, DRY_KILL_LINE, "implementeur", H, "llm.call", { tokens_in: 3000, tokens_out: 500, attempt: 1 }),
    e(killRun, DRY_KILL_LINE, "orchestrateur", "none", "kill.triggered", { status: "killed", detail: { source: "dry-run" } }),
  ];
}

export function runDryRun(store: Store) {
  const events = buildDryRun();
  const out = store.ingest(events);
  return { ...out, line: DRY_LINE, killLine: DRY_KILL_LINE, expectedCost: Math.round(events.reduce((a, x) => a + x.cost, 0) * 1e6) / 1e6 };
}

async function main() {
  const url = process.argv[process.argv.indexOf("--url") + 1];
  const events = buildDryRun();
  const expected = Math.round(events.reduce((a, x) => a + x.cost, 0) * 1e6) / 1e6;
  if (process.argv.includes("--url")) {
    const res = await fetch(`${url}/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(events) });
    console.log("POST /api/events", res.status, await res.text());
    const s = (await (await fetch(`${url}/api/summary`)).json()) as { lines: { line: string; state: string; cost: number }[] };
    const mine = s.lines.filter((l) => l.line === DRY_LINE || l.line === DRY_KILL_LINE);
    console.log(mine.map((l) => `${l.line}: ${l.state}, ${l.cost} USD`).join("\n"));
    const ok = mine.some((l) => l.line === DRY_LINE && l.state === "merged") && mine.some((l) => l.line === DRY_KILL_LINE && l.state === "killed");
    process.exit(ok ? 0 : 1);
  }
  const store = new Store(":memory:", loadBudgets("config/budgets.json"));
  const r = runDryRun(store);
  const got = (store.db.prepare("SELECT ROUND(SUM(cost),6) AS c, COUNT(*) AS n FROM events").get() as { c: number; n: number });
  console.log(`événements acceptés ${r.accepted}/${events.length}, en base ${got.n}, coût cumulé ${got.c} USD (attendu ${expected})`);
  process.exit(got.n === events.length && Math.abs(got.c - expected) < 1e-6 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
