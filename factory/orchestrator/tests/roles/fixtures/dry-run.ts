/**
 * Jeu d'événements réaliste reprenant le run factice de factory/observability/scripts/dry-run.ts :
 * P0-900 (spec, tests, impl, CI en échec, retry impl, CI verte, review, merge) et P0-901 (tuée par le kill-switch).
 * Différences volontaires avec le script : `ci.result` porte `tests_green` et `error_signature` (convention
 * `detail` de factory/orchestrator/README.md) ; le script ne les émet pas encore (écart signalé).
 * Même ordre et mêmes tokens que le script ; ts = T0 + 1 s par événement, comme le script.
 */
import { readFileSync } from "node:fs";
import type { FactoryEvent } from "../../../src/types";

const PRICES = JSON.parse(
  readFileSync(new URL("../../../../observability/config/prices.json", import.meta.url), "utf8"),
) as Record<string, [number, number, number, number]>;

export const DRY_PHASE = "P0";
export const DRY_LINE = "P0-900";
export const DRY_KILL_LINE = "P0-901";
const H = "claude-haiku-5-5", S = "claude-sonnet-5-5";
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

const costOf = (m: string, tin: number, tout: number) => {
  const p = PRICES[m];
  return p ? Math.round(((tin * p[0] + tout * p[1]) / 1e6) * 1e6) / 1e6 : 0;
};

export function dryRunEvents(): FactoryEvent[] {
  let i = 0;
  const run = "01DRYRUN0000000000000000A", killRun = "01DRYRUN0000000000000000B";
  const e = (r: string, line: string, agent: string, model: string, action: string, o: Partial<FactoryEvent> = {}): FactoryEvent => {
    const tin = o.tokens_in ?? 0, tout = o.tokens_out ?? 0;
    return {
      ts: new Date(T0 + 1000 * i++).toISOString(), run_id: r, line, phase: "P0", agent, model, action,
      tokens_in: tin, tokens_out: tout, cost: costOf(model, tin, tout), duration_ms: 500, status: "ok", ...o,
    };
  };
  const L = DRY_LINE;
  return [
    e(run, L, "specifieur", S, "llm.call", { tokens_in: 8000, tokens_out: 1500 }),
    e(run, L, "testeur", S, "llm.call", { tokens_in: 9000, tokens_out: 2500 }),
    e(run, L, "implementeur", H, "llm.call", { tokens_in: 12000, tokens_out: 3000, attempt: 1 }),
    e(run, L, "sentinelle", "none", "ci.result", {
      status: "error", detail: { stage: "unit", tests_green: false, error_signature: "unit: expected 3 to equal 4" },
    }),
    e(run, L, "implementeur", H, "retry.start", { status: "retry", attempt: 2 }),
    e(run, L, "implementeur", H, "llm.call", { tokens_in: 14000, tokens_out: 2000, attempt: 2 }),
    e(run, L, "sentinelle", "none", "ci.result", { detail: { stage: "unit", tests_green: true } }),
    e(run, L, "reviseur", S, "review.verdict", { tokens_in: 7000, tokens_out: 800, detail: { verdict: "approve" } }),
    e(run, L, "integrateur", "none", "merge.done"),
    e(killRun, DRY_KILL_LINE, "implementeur", H, "llm.call", { tokens_in: 3000, tokens_out: 500, attempt: 1 }),
    e(killRun, DRY_KILL_LINE, "orchestrateur", "none", "kill.triggered", { status: "killed", detail: { source: "dry-run" } }),
  ];
}
