import { describe, expect, it } from "vitest";
import { buildDryRun, runDryRun } from "../scripts/dry-run";
import { buildSummary } from "@/lib/summary";
import { memStore } from "./helpers";

describe("run factice de bout en bout (sans LLM)", () => {
  it("les événements d'une ligne fictive arrivent dans le store, coût cumulé exact", () => {
    const store = memStore();
    const r = runDryRun(store);
    expect(r.invalid).toBe(0);
    expect(r.accepted).toBe(buildDryRun().length);

    const rows = store.db.prepare("SELECT action, status, agent FROM events WHERE line = ? ORDER BY id").all(r.line) as { action: string; status: string; agent: string }[];
    expect(rows.map((x) => x.agent).filter((a, i, all) => a !== all[i - 1])).toEqual(["specifieur", "testeur", "implementeur", "sentinelle", "implementeur", "sentinelle", "reviseur", "integrateur"]);
    expect(rows.some((x) => x.status === "retry")).toBe(true);
    expect(rows.at(-1)).toMatchObject({ action: "merge.done" });

    const cost = (store.db.prepare("SELECT cost FROM v_cost_by_line WHERE line = ?").get(r.line) as { cost: number }).cost;
    const killCost = (store.db.prepare("SELECT cost FROM v_cost_by_line WHERE line = ?").get(r.killLine) as { cost: number }).cost;
    expect(cost + killCost).toBeCloseTo(r.expectedCost, 6);
    expect(cost).toBeGreaterThan(killCost);
    expect(r.expectedCost).toBeLessThan(1);

    const kill = store.db.prepare("SELECT status FROM events WHERE action = 'kill.triggered' AND line = ?").get(r.killLine) as { status: string };
    expect(kill.status).toBe("killed");
    const s = buildSummary(store);
    expect(s.line_counts.killed).toBe(1);
    expect(s.line_counts.merged).toBe(1);
    expect(s.totals.cost).toBeCloseTo(r.expectedCost, 6);
  });

  it("rejouer est idempotent", () => {
    const store = memStore();
    runDryRun(store);
    expect(runDryRun(store).accepted).toBe(0);
  });
});
