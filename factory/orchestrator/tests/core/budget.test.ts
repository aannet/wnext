import { describe, expect, it } from "vitest";
import { InMemoryBudgetMeter } from "../../src/core/budget";

const usage = (i: number, o = 0, cr = 0, cw = 0) => ({ tokens_in: i, tokens_out: o, tokens_cache_read: cr, tokens_cache_write: cw, cost_usd: 0 });
const meter = () => new InMemoryBudgetMeter({ alert_ratio: 0.8, phase_ceiling_factor: 1.3 });

describe("InMemoryBudgetMeter", () => {
  it("cumule entrée + sortie + cache par ligne et par phase", () => {
    const m = meter(); m.setLineBudget("L1", 1000);
    m.record("L1", "P0", usage(100, 50, 10, 5));
    m.record("L1", "P0", usage(10));
    expect(m.line("L1").used).toBe(175);
    expect(m.phase("P0").used).toBe(175);
  });
  it("alerte à 80 % puis dépassement au plafond dur (ligne = budget)", () => {
    const m = meter(); m.setLineBudget("L1", 1000);
    m.record("L1", "P0", usage(799));
    expect(m.line("L1").level).toBe("ok");
    m.record("L1", "P0", usage(1));
    expect(m.line("L1")).toMatchObject({ level: "alert", ratio: 0.8, hard_ceiling: 1000 });
    m.record("L1", "P0", usage(200));
    expect(m.line("L1").level).toBe("exceeded");
  });
  it("phase : alerte à 0,8 x budget, plafond dur à 1,3 x", () => {
    const m = meter(); m.setPhaseBudget("P0", 1000);
    m.record("L1", "P0", usage(800));
    expect(m.phase("P0").level).toBe("alert");
    m.record("L2", "P0", usage(499));
    expect(m.phase("P0")).toMatchObject({ level: "alert", hard_ceiling: 1300 });
    m.record("L2", "P0", usage(1));
    expect(m.phase("P0").level).toBe("exceeded");
  });
  it("sans budget défini : ok et ratio 0 ; phases indépendantes", () => {
    const m = meter();
    m.record("L1", "P0", usage(5000));
    expect(m.line("L1")).toMatchObject({ level: "ok", ratio: 0, budget: 0 });
    expect(m.phase("P1").used).toBe(0);
  });
});
