import { describe, expect, it } from "vitest";
import { buildSummary } from "@/lib/summary";
import { ev, memStore } from "./helpers";

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const NOW = new Date(T0 + 60_000);
const sup = (s: number, action: string) => ev({ ts: at(s), agent: "superviseur", model: "none", action, tokens_in: 0, tokens_out: 0, cost: 0 });

describe("alertes du Superviseur (ADR-006)", () => {
  it("signale avertissement et interruption sur une ligne ouverte", () => {
    const s = memStore();
    s.ingest([ev({ ts: at(1) }), sup(2, "supervisor.warn"), sup(3, "supervisor.interrupt")]);
    const kinds = buildSummary(s, { now: NOW }).alerts.map((a) => a.kind);
    expect(kinds).toContain("supervisor_warn");
    expect(kinds).toContain("supervisor_interrupt");
  });

  it("n'alerte plus une fois la ligne mergée", () => {
    const s = memStore();
    s.ingest([ev({ ts: at(1) }), sup(2, "supervisor.interrupt"), ev({ ts: at(3), agent: "integrateur", model: "none", action: "merge.done", tokens_in: 0, tokens_out: 0, cost: 0 })]);
    expect(buildSummary(s, { now: NOW }).alerts.filter((a) => a.kind.startsWith("supervisor"))).toEqual([]);
  });
});
