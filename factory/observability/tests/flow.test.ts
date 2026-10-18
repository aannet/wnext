import { describe, expect, it } from "vitest";
import { inferFlow } from "@/lib/flow";
import type { StoredEvent } from "@/lib/types";
import { RUN, ev } from "./helpers";

const RUN2 = RUN.slice(0, -1) + "Z";
let id = 0;
const e = (agent: string, action: string, ms: number, over: Partial<StoredEvent> = {}): StoredEvent =>
  ({ ...ev({ agent, action, ts: new Date(Date.UTC(2026, 9, 18, 9, 0, 0, ms)).toISOString(), duration_ms: 100, status: "ok" }), id: ++id, schema_version: "1.0", ...over });

describe("inferFlow", () => {
  it("relie l'agent précédent au suivant quand l'agent change", () => {
    const { calls, edges } = inferFlow([
      e("orchestrateur", "session.start", 1), e("specifieur", "llm.call", 2), e("testeur", "llm.call", 3),
      e("testeur", "git.commit", 4), e("implementeur", "llm.call", 5),
    ]);
    expect(edges.map((x) => `${x.from}>${x.to}:${x.count}`)).toEqual(["orchestrateur>specifieur:1", "specifieur>testeur:1", "testeur>implementeur:1"]);
    expect(calls[0].caller).toBeNull();
    expect(calls[1]).toMatchObject({ caller: "orchestrateur", kind: "handoff" });
    expect(calls[3]).toMatchObject({ caller: "specifieur", kind: "call" }); // même agent qui continue : appelant hérité
  });

  it("distingue retry, escalade, boucle et kill", () => {
    const { edges } = inferFlow([
      e("implementeur", "llm.call", 1), e("sentinelle", "ci.result", 2, { status: "error" }),
      e("orchestrateur", "retry.start", 3, { status: "retry" }), e("router", "escalate.model", 4, { status: "escalated" }),
      e("implementeur", "llm.call", 5), e("orchestrateur", "loop.detected", 6, { status: "looping" }),
      e("orchestrateur", "kill.triggered", 7, { status: "killed" }),
    ]);
    const kinds = Object.fromEntries(edges.map((x) => [`${x.from}>${x.to}`, x.kind]));
    expect(kinds["sentinelle>orchestrateur"]).toBe("retry");
    expect(kinds["orchestrateur>router"]).toBe("escalate");
    expect(kinds["implementeur>orchestrateur"]).toBe("loop");
  });

  it("ne mélange pas deux runs entrelacés", () => {
    const { calls, edges } = inferFlow([
      e("specifieur", "llm.call", 1, { run_id: RUN, line: "P1-001" }),
      e("specifieur", "llm.call", 2, { run_id: RUN2, line: "P1-002" }),
      e("testeur", "llm.call", 3, { run_id: RUN, line: "P1-001" }),
      e("testeur", "llm.call", 4, { run_id: RUN2, line: "P1-002" }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "specifieur", to: "testeur", count: 2, lines: 2 });
    expect(calls.filter((c) => c.kind === "handoff")).toHaveLength(2);
  });

  it("trie par ts puis id, indépendamment de l'ordre d'arrivée", () => {
    const { calls } = inferFlow([e("testeur", "llm.call", 3), e("specifieur", "llm.call", 1)]);
    expect(calls.map((c) => c.agent)).toEqual(["specifieur", "testeur"]);
  });

  it("calcule le début du bloc à partir de la durée", () => {
    const [c] = inferFlow([e("testeur", "llm.call", 500, { duration_ms: 200 })]).calls;
    expect(c.end_ms - c.start_ms).toBe(200);
  });
});
