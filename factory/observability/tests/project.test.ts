import { describe, expect, it } from "vitest";
import { buildProject } from "@/lib/project";
import { buildProduction } from "@/lib/production";
import { buildSummary } from "@/lib/summary";
import { RUN, ev, memStore } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const NOW = new Date(T0 + 60_000);
const RUN2 = RUN.slice(0, -1) + "Z";
const lite = { tokens_in: 0, tokens_out: 0, cost: 0 };

function view(events: ReturnType<typeof ev>[]) {
  const s = memStore();
  s.ingest(events);
  return buildProject(buildSummary(s, { now: NOW }), buildProduction(s, { now: NOW }));
}

describe("buildProject", () => {
  it("santé ok sans alerte ; phase en cours = première phase ouverte", () => {
    const v = view([
      ev({ ts: at(1), agent: "specifieur" }),
      ev({ ts: at(30), agent: "implementeur" }),
    ]);
    expect(v.health).toBe("ok");
    expect(v.current_phase).toBe("P1");
    expect(v.lines[0]).toMatchObject({ line: "P1-017", step_label: "Implémentation", step_index: 2 });
  });

  it("une ligne bloquée passe la santé à « à surveiller »", () => {
    const v = view([
      ev({ ts: at(1), agent: "integrateur", model: "none", action: "approval.wait", status: "blocked", ...lite }),
    ]);
    expect(v.health).toBe("watch");
    expect(v.watch[0].message).toContain("P1-017");
  });

  it("CI au premier passage : première ci.result de chaque ligne", () => {
    const v = view([
      ev({ ts: at(1), agent: "sentinelle", model: "none", action: "ci.result", status: "error", ...lite }),
      ev({ ts: at(2), agent: "sentinelle", model: "none", action: "ci.result", status: "ok", ...lite }),
      ev({ ts: at(3), line: "P1-018", run_id: RUN2, agent: "sentinelle", model: "none", action: "ci.result", status: "ok", ...lite }),
    ]);
    expect(v.ci_first_pass).toEqual({ rate: 0.5, passed: 1, total: 2 });
  });

  it("les lignes mergées sortent de la liste et comptent dans le total", () => {
    const v = view([
      ev({ ts: at(1), agent: "integrateur", model: "none", action: "merge.done", ...lite }),
      ev({ ts: at(2), line: "P1-018", run_id: RUN2, agent: "testeur" }),
    ]);
    expect(v.merged_total).toBe(1);
    expect(v.lines.map((l) => l.line)).toEqual(["P1-018"]);
    expect(v.phases.find((p) => p.phase === "P1")).toMatchObject({ lines: 2, merged: 1 });
  });
});
