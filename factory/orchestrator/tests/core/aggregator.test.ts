import { beforeEach, describe, expect, it } from "vitest";
import { EventAggregator } from "../../src/core/aggregator";
import { InMemoryBudgetMeter } from "../../src/core/budget";
import { simhash64 } from "../../src/core/fingerprint";
import { LineMachine } from "../../src/core/line-machine";
import { config, ev } from "./helpers";

const T0 = Date.parse("2026-10-18T09:00:00.000Z");
const MIN = 60_000;
let agg: EventAggregator, budget: InMemoryBudgetMeter, m: LineMachine;

const mkLine = (line: string, phase: "P0" | "P1" = "P0") => {
  const lm = new LineMachine({ line, phase, run_id: "R-" + line, token_budget: 30_000, now_ms: T0, model: "m-sonnet" }, config.retries);
  budget.setLineBudget(line, 30_000);
  agg.registerLine(lm);
  return lm;
};
const start = (id: string, line = "P0-001", at = T0) =>
  agg.agentStarted({ instance_id: id, line, role: "implementeur", model: "m-sonnet", pid: 1, pgid: 1 }, at);
const input = (line = "P0-001", now = T0, extra: object = {}) => agg.buildInput(line, { now, verdicts: [], killActive: false, ...extra });

beforeEach(() => {
  budget = new InMemoryBudgetMeter({ alert_ratio: 0.8, phase_ceiling_factor: 1.3 });
  agg = new EventAggregator({ budget, config });
  m = mkLine("P0-001");
});

describe("EventAggregator : AgentState", () => {
  it("compte les appels d'outils depuis le dernier commit et les remet à zéro au commit", () => {
    start("i1"); start("i2");
    for (let k = 0; k < 3; k++) agg.observe(ev({ action: "tool.exec" }), T0 + k * 1000);
    expect(input().agents.map((a) => a.tool_calls_since_commit)).toEqual([3, 0]);
    agg.observe(ev({ action: "git.commit", detail: { diff_hash: "h1", lines_changed: 4 } }), T0 + 5000);
    const i = input("P0-001", T0 + 6000);
    expect(i.agents.map((a) => a.tool_calls_since_commit)).toEqual([0, 0]);
    expect(i.line.last_commit_at_ms).toBe(T0 + 5000);
    expect(i.agents[0]!.last_commit_at_ms).toBe(T0 + 5000);
  });
  it("série d'llm.call identiques (prompt_hash)", () => {
    start("i1");
    const call = (h: string) => agg.observe(ev({ action: "llm.call", detail: { prompt_hash: h } }), T0);
    call("a"); expect(input().agents[0]!.identical_llm_call_streak).toBe(1);
    call("a"); call("a"); expect(input().agents[0]!.identical_llm_call_streak).toBe(3);
    call("b"); expect(input().agents[0]!.identical_llm_call_streak).toBe(1);
  });
  it("last_event / last_event_at / changement d'état (ci.result, pas llm.call)", () => {
    start("i1");
    agg.observe(ev({ action: "llm.call" }), T0 + 1000);
    let a = input().agents[0]!;
    expect(a.last_event_at_ms).toBe(T0 + 1000);
    expect(a.last_event?.action).toBe("llm.call");
    expect(a.last_state_change_at_ms).toBe(T0);
    agg.observe(ev({ action: "ci.result", status: "ok", detail: { tests_green: 3 } }), T0 + 2000);
    a = input().agents[0]!;
    expect(a.last_state_change_at_ms).toBe(T0 + 2000);
  });
  it("agentEnded retire l'agent ; événements d'une autre ligne ignorés pour cette ligne", () => {
    start("i1"); agg.agentEnded("i1");
    expect(input().agents).toEqual([]);
  });
});

describe("EventAggregator : LineState", () => {
  it("diffs : similarité par simhash, empreintes de fichiers, fenêtre bornée", () => {
    const body = Array.from({ length: 200 }, (_, i) => `const v${i} = compute(${i}) + helper_${i % 7};`).join("\n");
    const near = body.replace("compute(100)", "compute(999)");
    agg.observe(ev({ action: "git.commit", detail: { diff_hash: "h1", diff_simhash: simhash64(body), lines_changed: 10, "file_hash:src/a.ts": "f1" } }), T0);
    agg.observe(ev({ action: "git.commit", detail: { diff_hash: "h2", diff_simhash: simhash64(near), lines_changed: 2, "file_hash:src/a.ts": "f2" } }), T0 + 1000);
    agg.observe(ev({ action: "git.commit", detail: { diff_hash: "h2", lines_changed: 2 } }), T0 + 2000);
    const d = input().line.recent_diffs;
    expect(d[0]).toMatchObject({ hash: "h1", similarity_to_previous: null, lines_changed: 10, file_hashes: { "src/a.ts": "f1" } });
    expect(d[1]!.similarity_to_previous).toBeGreaterThan(0.9);
    expect(d[1]!.file_hashes).toEqual({ "src/a.ts": "f2" });
    expect(d[2]!.similarity_to_previous).toBe(1); // même hash exact
    for (let k = 0; k < 10; k++) agg.observe(ev({ action: "git.commit", detail: { diff_hash: "x" + k, lines_changed: 1 } }), T0 + 3000 + k);
    expect(input().line.recent_diffs.length).toBeLessThanOrEqual(5);
  });
  it("erreurs CI et tests verts : used_at_last_green_gain suit les tokens à la dernière hausse", () => {
    start("i1");
    budget.record("P0-001", "P0", { tokens_in: 1000, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 });
    agg.observe(ev({ action: "ci.result", status: "error", detail: { tests_green: 2, error_signature: "sigA" } }), T0 + 1000);
    budget.record("P0-001", "P0", { tokens_in: 4000, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 });
    agg.observe(ev({ action: "ci.result", status: "error", detail: { tests_green: 2, error_signature: "sigA" } }), T0 + 2000);
    const l = input().line;
    expect(l.green_tests).toBe(2);
    expect(l.tokens).toEqual({ used: 5000, budget: 30_000, used_at_last_green_gain: 1000 });
    expect(l.recent_ci_errors).toEqual([{ signature: "sigA", at_ms: T0 + 1000 }, { signature: "sigA", at_ms: T0 + 2000 }]);
    agg.observe(ev({ action: "ci.result", status: "ok", detail: { tests_green: 5 } }), T0 + 3000);
    expect(input().line.tokens.used_at_last_green_gain).toBe(5000);
  });
  it("expose config, kill_switch_active, verdicts, now", () => {
    const v = [{ verdict: "continue" as const, cause: "c", instance_id: "i1", received_at_ms: T0 }];
    const i = input("P0-001", T0 + 5, { verdicts: v, killActive: true });
    expect(i).toMatchObject({ now_ms: T0 + 5, kill_switch_active: true, verdicts: v, config });
  });
});

describe("EventAggregator : PhaseSignals", () => {
  it("interruptions et lignes looping sur 1 h glissante (lignes distinctes)", () => {
    mkLine("P0-002");
    agg.observe(ev({ action: "supervisor.interrupt", agent: "superviseur", model: "none", instance_id: undefined }), T0);
    agg.observe(ev({ action: "supervisor.interrupt", agent: "superviseur", model: "none", instance_id: undefined }), T0 + 30 * MIN);
    agg.observe(ev({ action: "loop.detected", status: "looping", line: "P0-001", instance_id: undefined }), T0 + 10 * MIN);
    agg.observe(ev({ action: "loop.detected", status: "looping", line: "P0-001", instance_id: undefined }), T0 + 20 * MIN);
    agg.observe(ev({ action: "loop.detected", status: "looping", line: "P0-002", instance_id: undefined }), T0 + 40 * MIN);
    let p = input("P0-001", T0 + 50 * MIN).phase;
    expect(p.interruptions_last_hour).toBe(2);
    expect(p.looping_lines_last_hour).toBe(2);
    p = input("P0-001", T0 + 85 * MIN).phase;
    expect(p.interruptions_last_hour).toBe(1);
    expect(p.looping_lines_last_hour).toBe(1);
  });
  it("médiane tokens par ligne modifiée sur les lignes terminées de la phase", () => {
    expect(input().phase.median_tokens_per_changed_line).toBeNull();
    const fin = (line: string, used: number, changed: number, phase: "P0" | "P1" = "P0") => {
      const lm = mkLine(line, phase);
      budget.record(line, phase, { tokens_in: used, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 });
      agg.observe(ev({ action: "git.commit", line, phase, instance_id: undefined, detail: { diff_hash: "h" + line, lines_changed: changed } }), T0);
      lm.state.status = "done";
    };
    fin("P0-010", 1000, 10); // 100
    fin("P0-011", 3000, 10); // 300
    fin("P0-012", 2000, 10); // 200
    fin("P1-001", 99_999, 1, "P1");
    expect(input().phase.median_tokens_per_changed_line).toBe(200);
  });
  it("taux d'échec CI sur la fenêtre des N derniers résultats", () => {
    for (let k = 0; k < 25; k++) agg.observe(ev({ action: "ci.result", status: k % 2 === 0 ? "error" : "ok", detail: { tests_green: 0 } }), T0 + k);
    const p = input().phase;
    expect(p.ci_runs_in_window).toBe(config.kill.ci_failure_window_lines);
    // 25 résultats alternant error(k pair) / ok ; les 20 derniers = k 5..24 -> erreurs aux k pairs 6..24 = 10
    expect(p.ci_failures_in_window).toBe(10);
  });
  it("coût sur 1 h, tokens et budget de phase, violation de permission", () => {
    budget.setPhaseBudget("P0", 100_000);
    budget.record("P0-001", "P0", { tokens_in: 700, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 });
    agg.observe(ev({ action: "llm.call", cost: 1.5 }), T0);
    agg.observe(ev({ action: "llm.call", cost: 2 }), T0 + 40 * MIN);
    let p = input("P0-001", T0 + 80 * MIN).phase;
    expect(p).toMatchObject({ cost_last_hour_usd: 2, tokens_used: 700, tokens_budget: 100_000, permission_violation: false });
    agg.observe(ev({ action: "kill.triggered", status: "killed" }), T0 + 81 * MIN);
    p = input("P0-001", T0 + 82 * MIN).phase;
    expect(p.permission_violation).toBe(true);
  });
  it("journal d'événements par ligne", () => {
    agg.observe(ev({ action: "tool.exec" }), T0);
    agg.observe(ev({ action: "tool.exec", line: "P0-002" }), T0);
    expect(agg.eventsOf("P0-001")).toHaveLength(1);
  });
});
