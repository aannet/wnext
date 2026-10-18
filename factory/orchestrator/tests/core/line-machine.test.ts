import { describe, expect, it } from "vitest";
import { InvalidTransitionError, LineMachine } from "../../src/core/line-machine";
import { config } from "./helpers";

const T0 = Date.parse("2026-10-18T09:00:00.000Z");
const make = (retries = config.retries) =>
  new LineMachine({ line: "P0-001", phase: "P0", run_id: "R", token_budget: 30_000, now_ms: T0, model: "A" }, retries);
const toImpl = (m: LineMachine) => { m.advance("tests", T0); m.advance("impl", T0); };

describe("LineMachine : transitions", () => {
  it("chemin nominal spec -> tests -> impl -> ci -> review -> merge -> done", () => {
    const m = make();
    expect(m.state.step).toBe("spec");
    toImpl(m);
    expect(m.advance("ci", T0 + 1)).toEqual({ kind: "ok" });
    m.advance("review", T0 + 2);
    m.advance("merge", T0 + 3);
    m.complete(T0 + 4);
    expect(m.state.status).toBe("done");
    expect(m.state.last_step_change_at_ms).toBe(T0 + 4);
  });
  it("local_check optionnel entre impl et ci", () => {
    const m = make(); toImpl(m);
    m.advance("local_check", T0); m.advance("ci", T0);
    expect(m.state.cycles.total).toBe(1);
  });
  it("refuse les transitions invalides", () => {
    const m = make();
    expect(() => m.advance("impl", T0)).toThrow(InvalidTransitionError);
    expect(() => m.advance("merge", T0)).toThrow(InvalidTransitionError);
    toImpl(m);
    expect(() => m.advance("review", T0)).toThrow(InvalidTransitionError);
    expect(m.canTransition("ci")).toBe(true);
    expect(m.canTransition("spec")).toBe(false);
  });
  it("états terminaux et looping refusent toute transition", () => {
    const m = make(); toImpl(m);
    m.markLooping(T0);
    expect(m.state.status).toBe("looping");
    expect(() => m.advance("ci", T0)).toThrow(InvalidTransitionError);
    m.resume();
    expect(m.state.status).toBe("running");
    m.kill(T0);
    expect(m.state.status).toBe("killed");
    expect(() => m.advance("ci", T0)).toThrow(InvalidTransitionError);
    expect(() => m.resume()).toThrow(InvalidTransitionError);
  });
  it("complete() n'est permis que depuis merge", () => {
    const m = make(); toImpl(m);
    expect(() => m.complete(T0)).toThrow(InvalidTransitionError);
  });
  it("respec renvoie à spec (sauf depuis merge)", () => {
    const m = make(); toImpl(m);
    m.respec(T0 + 5);
    expect(m.state.step).toBe("spec");
    m.advance("tests", T0); m.advance("impl", T0); m.advance("ci", T0); m.advance("review", T0); m.advance("merge", T0);
    expect(() => m.respec(T0)).toThrow(InvalidTransitionError);
  });
});

describe("LineMachine : compteurs §4.3", () => {
  it("max 2 cycles par modèle : le 3e retour demande un changement de modèle sans rien muter", () => {
    const m = make(); toImpl(m);
    m.advance("ci", T0); expect(m.advance("impl", T0)).toEqual({ kind: "ok" });
    m.advance("ci", T0);
    expect(m.advance("impl", T0)).toEqual({ kind: "model_change" });
    expect(m.state.step).toBe("ci");
    expect(m.state.status).toBe("running");
    m.switchModel("B");
    expect(m.advance("impl", T0)).toEqual({ kind: "ok" });
    expect(m.state.cycles).toEqual({ total: 2, by_model: { A: 2 } });
  });
  it("max 5 cycles au total puis blocked", () => {
    const m = make();
    toImpl(m);
    const ladder = ["B", "C", "D"];
    for (let i = 0; i < 4; i++) {
      m.advance("ci", T0);
      let r = m.advance("impl", T0);
      if (r.kind === "model_change") { m.switchModel(ladder.shift()!); r = m.advance("impl", T0); }
      expect(r).toEqual({ kind: "ok" });
    }
    m.advance("ci", T0);
    expect(m.state.cycles).toEqual({ total: 5, by_model: { A: 2, B: 2, C: 1 } });
    expect(m.advance("impl", T0 + 9)).toEqual({ kind: "blocked", reason: "cycles_exhausted" });
    expect(m.state.status).toBe("blocked");
    expect(m.blockReason).toBe("cycles_exhausted");
  });
  it("max 2 retours de review puis blocked", () => {
    const m = make({ ...config.retries, max_cycles_per_model: 9 }); toImpl(m);
    for (let i = 0; i < 2; i++) { m.advance("ci", T0); m.advance("review", T0); expect(m.advance("impl", T0)).toEqual({ kind: "ok" }); }
    expect(m.state.review_returns).toBe(2);
    m.advance("ci", T0); m.advance("review", T0);
    expect(m.advance("impl", T0)).toEqual({ kind: "blocked", reason: "review_returns_exhausted" });
  });
  it("durée murale : atteinte à 3 h pile", () => {
    const m = make();
    expect(m.wallExceeded(T0 + 180 * 60_000 - 1)).toBe(false);
    expect(m.wallExceeded(T0 + 180 * 60_000)).toBe(true);
  });
  it("le budget de ligne est porté par l'état", () => {
    expect(make().state.tokens).toEqual({ used: 0, budget: 30_000, used_at_last_green_gain: 0 });
  });
});
