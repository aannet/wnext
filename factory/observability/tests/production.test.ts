import { describe, expect, it } from "vitest";
import { buildProduction } from "@/lib/production";
import { RUN, ev, memStore } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const NOW = new Date(T0 + 60_000);

function seed() {
  const s = memStore();
  s.ingest([
    ev({ ts: at(1), agent: "orchestrateur", model: "none", action: "session.start", tokens_in: 0, tokens_out: 0, cost: 0 }),
    ev({ ts: at(5), agent: "specifieur", model: "claude-opus-5-5", action: "llm.call" }),
    ev({ ts: at(40), agent: "implementeur", model: "claude-sonnet-5-5", action: "llm.call" }),
    ev({ ts: at(45), agent: "implementeur", model: "none", action: "git.commit", tokens_in: 0, tokens_out: 0, cost: 0 }),
    // autre ligne, terminée
    ev({ ts: at(10), line: "P0-001", phase: "P0", run_id: RUN.slice(0, -1) + "Z", agent: "integrateur", model: "none", action: "merge.done", tokens_in: 0, tokens_out: 0, cost: 0 }),
  ]);
  return s;
}

describe("buildProduction", () => {
  it("place les carrés des agents qui tiennent une ligne ou ont agi récemment", () => {
    const p = buildProduction(seed(), { now: NOW, activeWindowS: 120, muteAfterS: 300 });
    const impl = p.agents.find((a) => a.agent === "implementeur")!;
    expect(impl.state).toBe("running");
    expect(impl.units.map((u) => u.line)).toEqual(["P1-017"]);
    expect(p.agents.find((a) => a.agent === "architecte")).toMatchObject({ state: "idle", units: [] });
  });

  it("marque muet un agent qui tient une ligne sans événement depuis longtemps", () => {
    const p = buildProduction(seed(), { now: new Date(T0 + 3_600_000), activeWindowS: 120, muteAfterS: 300 });
    expect(p.agents.find((a) => a.agent === "implementeur")).toMatchObject({ state: "muted" });
    expect(p.counts.muted).toBe(1);
  });

  it("n'affiche pas comme tenue une ligne mergée", () => {
    const p = buildProduction(seed(), { now: new Date(T0 + 3_600_000), activeWindowS: 120 });
    expect(p.agents.find((a) => a.agent === "integrateur")!.units).toEqual([]);
    expect(p.phases.find((x) => x.phase === "P0")).toMatchObject({ state: "done", open: 0 });
    expect(p.phases.find((x) => x.phase === "P1")).toMatchObject({ state: "open", open: 1 });
  });

  it("matrice : un élément par ligne avec le modèle dominant (tokens)", () => {
    const p = buildProduction(seed(), { now: NOW });
    const cell = p.matrix.find((c) => c.phase === "P1" && c.agent === "implementeur")!;
    expect(cell.lines).toEqual([expect.objectContaining({ line: "P1-017", model: "claude-sonnet-5-5", events: 2 })]);
  });

  it("filtre par phase et par ligne (flux et appels), pas la matrice", () => {
    const p = buildProduction(seed(), { now: NOW, phase: "P1" });
    expect(p.calls.every((c) => c.phase === "P1")).toBe(true);
    expect(p.matrix.some((c) => c.phase === "P0")).toBe(true);
    expect(buildProduction(seed(), { now: NOW, line: "n'importe quoi" }).filter.line).toBeNull();
  });
});

describe("buildProduction : arbre des agents lancés", () => {
  const inst = (s: number, name: string, parent: string | undefined, over: Record<string, unknown> = {}) =>
    ev({ ts: at(s), agent: "implementeur", instance_id: name, ...(parent ? { parent_instance_id: parent } : {}), ...over });

  it("rattache les sous-agents à leur parent et agrège le sous-arbre", () => {
    const s = memStore();
    s.ingest([
      inst(1, "orch", undefined, { agent: "orchestrateur", model: "none", action: "agent.start", tokens_in: 0, tokens_out: 0, cost: 0 }),
      inst(2, "impl", "orch", { action: "agent.start" }),
      inst(3, "sub-a", "impl", { action: "agent.start", detail: { subagent_type: "Explore" } }),
      inst(4, "sub-a", "impl", { tokens_in: 100, tokens_out: 0, cost: 0.5 }),
      inst(5, "sub-a", "impl", { action: "agent.stop", tokens_in: 0, tokens_out: 0, cost: 0 }),
      inst(6, "sub-b", "impl", { action: "agent.start" }),
    ]);
    const { instances: t } = buildProduction(s, { now: NOW });
    expect(t.roots.map((r) => r.instance_id)).toEqual(["orch"]);
    const impl = t.roots[0].children[0];
    expect(impl.children.map((c) => [c.instance_id, c.state, c.subagent_type])).toEqual([["sub-a", "done", "Explore"], ["sub-b", "running", null]]);
    expect(impl.descendants).toBe(2);
    expect(t.roots[0].descendants).toBe(3);
    expect(t.counts).toMatchObject({ total: 4, roots: 1, max_depth: 2, done: 1, active: 3 });
  });

  it("garde deux sous-agents parallèles qui émettent au même instant", () => {
    const s = memStore();
    const r = s.ingest([inst(1, "a", "orch", { action: "agent.start" }), inst(1, "b", "orch", { action: "agent.start" })]);
    expect(r.accepted).toBe(2);
  });

  it("traite un parent inconnu ou un cycle comme une racine, et ignore les événements sans instance", () => {
    const s = memStore();
    s.ingest([inst(1, "x", "absent"), inst(2, "p", "q"), inst(3, "q", "p"), ev({ ts: at(4) })]);
    const { instances: t } = buildProduction(s, { now: NOW });
    expect(t.counts.total).toBe(3);
    expect(t.roots.length).toBeGreaterThanOrEqual(2);
  });
});
