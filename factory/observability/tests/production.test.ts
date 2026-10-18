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
