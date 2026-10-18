import { describe, expect, it } from "vitest";
import { ingestBody } from "@/lib/ingest";
import { buildSummary } from "@/lib/summary";
import { ev, evs, memStore } from "./helpers";

describe("idempotence et append-only", () => {
  it("ignore un doublon sur (run_id, ts, action, agent)", () => {
    const s = memStore();
    const e = ev();
    expect(s.ingest([e]).accepted).toBe(1);
    const again = s.ingest([e, { ...e, tokens_in: 999 }]); // même clé, contenu différent : ignoré aussi
    expect(again).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(s.db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    expect(s.counters().events_duplicate_total).toBe(2);
  });
  it("accepte une clé différente (action ou agent)", () => {
    const s = memStore();
    expect(s.ingest([ev(), ev({ action: "tool.exec" }), ev({ agent: "reviseur" })]).accepted).toBe(3);
  });
  it("interdit UPDATE et DELETE", () => {
    const s = memStore();
    s.ingest([ev()]);
    expect(() => s.db.prepare("UPDATE events SET cost = 0").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });
  it("compte et rejette les invalides sans les stocker", () => {
    const s = memStore();
    const r = s.ingest([ev(), { ...ev(), ts: "bad" }, 42]);
    expect(r).toMatchObject({ accepted: 1, invalid: 2 });
    expect(s.counters()).toMatchObject({ events_invalid_total: 2, events_received_total: 3 });
    expect(s.recentInvalid().length).toBe(2);
  });
  it("ingère un lot JSONL, compte les lignes illisibles", () => {
    const s = memStore();
    const body = [...evs(3).map((e) => JSON.stringify(e)), "{pas du json", ""].join("\n");
    const r = ingestBody(s, body, "application/x-ndjson");
    expect(r).toMatchObject({ accepted: 3, invalid: 1 });
    expect(s.counters().events_invalid_total).toBe(1);
  });
  it("ingère un JSON objet ou tableau", () => {
    const s = memStore();
    expect(ingestBody(s, JSON.stringify(ev()), "application/json").accepted).toBe(1);
    expect(ingestBody(s, JSON.stringify(evs(2, { action: "tool.exec" })), "application/json").accepted).toBe(2);
  });
});

describe("agrégats", () => {
  const seed = () => {
    const s = memStore();
    s.ingest([
      ev({ ts: "2026-10-18T09:00:00.000Z", phase: "P1", line: "P1-001", agent: "implementeur", model: "claude-sonnet-5-5", tokens_in: 1000, tokens_out: 500, tokens_cache_read: 500, cost: 0.1 }),
      ev({ ts: "2026-10-18T09:00:01.000Z", phase: "P1", line: "P1-001", agent: "reviseur", model: "claude-opus-5-5", tokens_in: 2000, tokens_out: 0, cost: 0.2 }),
      ev({ ts: "2026-10-18T09:00:02.000Z", phase: "P1", line: "P1-002", agent: "implementeur", model: "claude-sonnet-5-5", tokens_in: 100, tokens_out: 100, cost: 0.01, action: "retry.start", status: "retry" }),
      ev({ ts: "2026-10-18T09:00:03.000Z", phase: "P0", line: "P0-001", agent: "orchestrateur", model: "none", tokens_in: 0, tokens_out: 0, cost: 0, action: "merge.done" }),
    ]);
    return s;
  };
  it("coût et tokens par agent / ligne / phase / modèle (cache compris)", () => {
    const s = seed();
    const get = (sql: string) => s.db.prepare(sql).all() as any[];
    expect(get("SELECT * FROM v_cost_by_agent WHERE agent='implementeur'")[0]).toMatchObject({ tokens_total: 2200, cost: 0.11 });
    expect(get("SELECT * FROM v_cost_by_line WHERE line='P1-001'")[0]).toMatchObject({ tokens_total: 4000, cost: 0.3 });
    expect(get("SELECT * FROM v_cost_by_phase WHERE phase='P1'")[0].tokens_total).toBe(4200);
    expect(get("SELECT * FROM v_cost_by_model WHERE model='claude-sonnet-5-5'")[0]).toMatchObject({ events: 2, tokens_total: 2200 });
  });
  it("lignes actives / mergées, retries", () => {
    const s = seed();
    const sum = buildSummary(s, { now: new Date("2026-10-18T09:00:10.000Z") });
    expect(sum.lines.find((l) => l.line === "P0-001")!.state).toBe("merged");
    expect(sum.lines.find((l) => l.line === "P1-002")!.retries).toBe(1);
    expect(sum.line_counts).toMatchObject({ active: 2, merged: 1, blocked: 0 });
    expect(sum.retries.total_retries).toBe(1);
  });
  it("budget de phase : niveaux warn / over / ceiling", () => {
    const s = memStore();
    const at = (tokens: number, i: number) => ev({ ts: `2026-10-18T09:00:0${i}.000Z`, phase: "P0", line: "P0-001", tokens_in: tokens, tokens_out: 0, cost: 1, action: `llm.call${"x".repeat(0)}`, agent: "implementeur" });
    const level = () => (s.db.prepare("SELECT alert_level, pct_budget FROM v_phase_budget WHERE phase='P0'").get() as any);
    expect(level().alert_level).toBe("ok");
    s.ingest([at(19_000_000, 1)]);
    expect(level().alert_level).toBe("ok");
    s.ingest([at(1_000_000, 2)]); // 20 M = 80 % de 25 M
    expect(level()).toMatchObject({ alert_level: "warn", pct_budget: 0.8 });
    s.ingest([at(5_000_000, 3)]); // 25 M
    expect(level().alert_level).toBe("over");
    s.ingest([at(7_500_000, 4)]); // 32,5 M = 1,3 x
    expect(level().alert_level).toBe("ceiling");
    const sum = buildSummary(s, { now: new Date("2026-10-18T09:00:05.000Z") });
    expect(sum.alerts.map((a) => a.kind)).toContain("budget_ceiling");
    expect(sum.phases[0]).toMatchObject({ phase: "P0", budget_tokens: 25_000_000, ceiling_tokens: 32_500_000 });
  });
  it("budgets par phase conformes à la config", () => {
    const rows = memStore().db.prepare("SELECT phase, budget_tokens FROM phase_budgets ORDER BY phase").all();
    expect(rows).toEqual([25, 70, 90, 120, 70, 45].map((m, i) => ({ phase: `P${i}`, budget_tokens: m * 1_000_000 })));
  });
  it("alertes : boucle et agent muet > 5 min", () => {
    const s = memStore();
    s.ingest([
      ev({ ts: "2026-10-18T09:00:00.000Z", line: "P1-001", action: "loop.detected", status: "looping", agent: "orchestrateur", model: "none" }),
      ev({ ts: "2026-10-18T09:00:00.000Z", line: "P1-002", agent: "testeur" }),
    ]);
    const quiet = buildSummary(s, { now: new Date("2026-10-18T09:04:00.000Z") });
    expect(quiet.alerts.map((a) => a.kind)).toEqual(["loop"]);
    const late = buildSummary(s, { now: new Date("2026-10-18T09:06:00.000Z") });
    expect(late.alerts.some((a) => a.kind === "silent_agent" && a.subject === "P1-002")).toBe(true);
    // une ligne bloquée n'est pas "muette" : son état est déjà signalé
    expect(late.alerts.some((a) => a.kind === "silent_agent" && a.subject === "P1-001")).toBe(false);
  });
  it("taux d'invalides", () => {
    const s = memStore();
    s.ingest([ev(), { nope: 1 }, { nope: 2 }, ev({ ts: "2026-10-18T09:14:04.000Z" })]);
    const sum = buildSummary(s);
    expect(sum.counters.events_invalid_total).toBe(2);
    expect(sum.counters.invalid_rate).toBeCloseTo(0.5);
  });
});
