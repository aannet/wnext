import { describe, expect, it } from "vitest";
import { inferFlow } from "@/lib/flow";
import { buildLineLoop, pickLoopLine } from "@/lib/loop";
import type { StoredEvent } from "@/lib/types";
import { ev } from "./helpers";

let id = 0;
const e = (agent: string, action: string, ms: number, over: Partial<StoredEvent> = {}): StoredEvent =>
  ({ ...ev({ agent, action, model: "claude-sonnet-5-5", ts: new Date(Date.UTC(2026, 9, 18, 9, 0, 0, ms)).toISOString(), status: "ok", tokens_in: 100, tokens_out: 50 }), id: ++id, schema_version: "1.0", ...over });
const loop = (evs: StoredEvent[]) => buildLineLoop(inferFlow(evs).calls, "P1-017");
const states = (v: ReturnType<typeof loop>) => v.steps.map((s) => s.state).join(",");

describe("buildLineLoop", () => {
  it("ligne en cours : étapes passées faites, dernière atteinte en cours, suivantes à venir", () => {
    const v = loop([e("specifieur", "llm.call", 1), e("testeur", "llm.call", 2), e("implementeur", "llm.call", 3, { attempt: 1 })]);
    expect(states(v)).toBe("done,done,running,pending,pending,pending");
    expect(v.outcome).toBe("open");
    expect(v.steps[0]).toMatchObject({ calls: 1, tokens: 150, model: "claude-sonnet-5-5" });
  });

  it("CI en échec non reprise = échec ; reprise par une étape suivante = fait ; compte les essais", () => {
    const base = [e("specifieur", "llm.call", 1), e("testeur", "llm.call", 2), e("implementeur", "llm.call", 3, { attempt: 1 }), e("sentinelle", "ci.result", 4, { status: "error", model: "none", attempt: 1 })];
    expect(states(loop(base))).toBe("done,done,done,failed,pending,pending");
    const retried = [...base, e("orchestrateur", "retry.start", 5, { status: "retry", model: "none" }), e("implementeur", "llm.call", 6, { attempt: 2 }),
      e("sentinelle", "ci.result", 7, { model: "none", attempt: 2 }), e("reviseur", "review.verdict", 8)];
    const v = loop(retried);
    expect(states(v)).toBe("done,done,done,done,running,pending");
    expect(v.steps[2].attempts).toBe(2);
    expect(v.retries).toBe(1);
  });

  it("merge.done termine la ligne ; approval.wait bloque", () => {
    const all = [e("specifieur", "llm.call", 1), e("testeur", "llm.call", 2), e("implementeur", "llm.call", 3), e("sentinelle", "ci.result", 4, { model: "none" }), e("reviseur", "review.verdict", 5)];
    expect(states(loop([...all, e("integrateur", "merge.done", 6, { model: "none" })]))).toBe("done,done,done,done,done,done");
    expect(loop([...all, e("integrateur", "merge.done", 6, { model: "none" })]).outcome).toBe("merged");
    const b = loop([...all, e("integrateur", "approval.wait", 6, { model: "none", status: "blocked" })]);
    expect(b.steps[5].state).toBe("blocked");
  });

  it("ligne arrêtée (loop + kill) : étape atteinte en échec, issue killed", () => {
    const v = loop([e("implementeur", "llm.call", 1), e("sentinelle", "ci.result", 2, { status: "error", model: "none" }),
      e("orchestrateur", "loop.detected", 3, { status: "looping", model: "none" }), e("orchestrateur", "kill.triggered", 4, { status: "killed", model: "none" })]);
    expect(v.outcome).toBe("killed");
    expect(v.loops).toBe(1);
    expect(v.steps[3].state).toBe("failed");
  });

  it("modèle LLM prioritaire sur « none » pour l'étape", () => {
    const v = loop([e("implementeur", "llm.call", 1), e("implementeur", "git.commit", 2, { model: "none", tokens_in: 0, tokens_out: 0 })]);
    expect(v.steps[2].model).toBe("claude-sonnet-5-5");
  });
});

describe("pickLoopLine", () => {
  it("filtre > ligne tenue > dernière ligne connue", () => {
    expect(pickLoopLine("P1-002", ["P1-001"], ["P1-001", "P1-002"])).toBe("P1-002");
    expect(pickLoopLine("", ["P1-001"], ["P0-001"])).toBe("P1-001");
    expect(pickLoopLine("", [], ["P0-001", "P0-002"])).toBe("P0-002");
    expect(pickLoopLine("", [], [])).toBeNull();
  });
});
