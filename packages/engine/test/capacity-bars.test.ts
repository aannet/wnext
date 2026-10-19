// Barres de capacité par cellule de zoom (BR-38, ADR-002 §2).
import { describe, expect, it } from "vitest";
import { capacityBar, capacityCells, capacityCellsByPerson } from "../src/capacity-bars";
import { DEFAULT_THRESHOLDS } from "../src/capacity-state";
import { utilization } from "../src/utilization";
import type { AllocationInput } from "../src/load";

const person = { id: "p", active: true, workDaysHours: [8, 8, 8, 8, 8, 0, 0], country: null, departmentId: null };
const alloc = (startDate: string, endDate: string, hoursPerDay: number, status: "confirmed" | "tentative" = "confirmed"): AllocationInput => ({
  personId: "p", startDate, endDate, mode: "hours", hoursPerDay, percent: null, status, billable: true,
  repeatState: "none", repeatEndDate: null, projectTentative: false, projectNonBillable: false, phaseNonBillable: false, taskBillable: null,
});
const rows = (allocations: AllocationInput[], from = "2026-03-02", to = "2026-03-15") =>
  utilization({ people: [person], holidays: [], timeoffs: [], allocations, from, to });

// @BR-38
describe("capacityBar", () => {
  it("sous la capacité : confirmé + tentatif + libre = 1, ligne de capacité en haut", () => {
    expect(capacityBar({ capacityHours: 8, plannedHours: 6, tentativeHours: 2 }))
      .toEqual({ confirmed: 0.5, tentative: 0.25, free: 0.25, over: 0, capacityLine: 1 });
  });

  it("au-delà : la barre s'étend, la ligne de capacité descend, le dépassement est visible", () => {
    const b = capacityBar({ capacityHours: 8, plannedHours: 10, tentativeHours: 0 });
    expect(b).toEqual({ confirmed: 1, tentative: 0, free: 0, over: 0.2, capacityLine: 0.8 });
  });

  it("capacité nulle et charge > 0 : tout est dépassement, jamais masqué", () => {
    expect(capacityBar({ capacityHours: 0, plannedHours: 4, tentativeHours: 0 })).toMatchObject({ over: 1, capacityLine: 0 });
    expect(capacityBar({ capacityHours: 0, plannedHours: 0, tentativeHours: 0 })).toEqual({ confirmed: 0, tentative: 0, free: 0, over: 0, capacityLine: 1 });
  });
});

describe("capacityCells", () => {
  it("zoom jour : une cellule par jour, week-end indisponible", () => {
    const cells = capacityCells(rows([alloc("2026-03-02", "2026-03-06", 6)]), { from: "2026-03-02", to: "2026-03-08" }, "day", 1, DEFAULT_THRESHOLDS);
    expect(cells).toHaveLength(7);
    expect(cells[0]).toMatchObject({ from: "2026-03-02", aggregate: { capacityHours: 8, plannedHours: 6, state: "under" } });
    expect(cells[5]).toMatchObject({ from: "2026-03-07", aggregate: { capacityHours: 0, state: "unavailable" } });
  });

  it("zoom semaine : un jour sur-alloué reste signalé même si la semaine est globalement sous la capacité", () => {
    const cells = capacityCells(
      rows([alloc("2026-03-02", "2026-03-02", 10), alloc("2026-03-03", "2026-03-03", 2)]),
      { from: "2026-03-02", to: "2026-03-15" }, "week", 1, DEFAULT_THRESHOLDS,
    );
    expect(cells.map((c) => c.from)).toEqual(["2026-03-02", "2026-03-09"]);
    expect(cells[0]!.aggregate).toMatchObject({ capacityHours: 40, plannedHours: 12, overbookedDays: 1, overtimeHours: 2, state: "under" });
    expect(cells[1]!.aggregate).toMatchObject({ plannedHours: 0, overbookedDays: 0 });
  });

  it("zoom mois : cellules de mois entiers, données de la plage seulement", () => {
    const r = rows([alloc("2026-03-02", "2026-03-31", 8, "tentative")], "2026-03-01", "2026-03-31");
    const [march] = capacityCells(r, { from: "2026-03-01", to: "2026-03-31" }, "month", 1, DEFAULT_THRESHOLDS);
    expect(march).toMatchObject({ from: "2026-03-01", to: "2026-03-31", aggregate: { capacityHours: 176, plannedHours: 176, tentativeHours: 176, state: "full" } });
    expect(march!.bar).toMatchObject({ confirmed: 0, tentative: 1, free: 0 });
  });
});

describe("capacityCells : entrée quelconque", () => {
  it("lignes dans le désordre ou hors de la plage : triées, et celles hors plage ignorées", () => {
    const all = rows([alloc("2026-03-02", "2026-03-13", 4)], "2026-02-23", "2026-03-15");
    const shuffled = [...all].reverse();
    const cells = capacityCells(shuffled, { from: "2026-03-02", to: "2026-03-08" }, "week", 1, DEFAULT_THRESHOLDS);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.aggregate).toMatchObject({ capacityHours: 40, plannedHours: 20 });
  });
});

describe("capacityCellsByPerson", () => {
  it("toutes les personnes d'un coup : mêmes cellules que capacityCells personne par personne", () => {
    const people = [person, { ...person, id: "q" }];
    const allocs = [alloc("2026-03-02", "2026-03-06", 6), { ...alloc("2026-03-03", "2026-03-04", 9), personId: "q" }];
    const rows = utilization({ people, holidays: [], timeoffs: [], allocations: allocs, from: "2026-03-02", to: "2026-03-15" });
    const range = { from: "2026-03-02", to: "2026-03-15" };
    const all = capacityCellsByPerson(rows, range, "week", 1, DEFAULT_THRESHOLDS);
    expect([...all.keys()].sort()).toEqual(["p", "q"]);
    for (const id of ["p", "q"]) expect(all.get(id)).toEqual(capacityCells(rows.filter((r) => r.personId === id), range, "week", 1, DEFAULT_THRESHOLDS));
    expect(all.get("q")![0]!.aggregate.overbookedDays).toBe(2);
  });
});
