// BR-11 : le pré-remplissage du timesheet est le miroir des allocations confirmées ; BR-28 : jamais plus de 24 h par jour.
import { describe, expect, it } from "vitest";
import { planPrefill, type PrefillAllocation, type PrefillInput } from "../src/prefill";

const WEEK = [8, 8, 8, 8, 8, 0, 0];

const alloc = (id: string, startDate: string, endDate: string, hours: number, over: Partial<PrefillAllocation> = {}): PrefillAllocation => ({
  id, personId: "p", projectId: "10", phaseId: null, taskId: null,
  startDate, endDate, mode: "hours", hoursPerDay: hours, percent: null, status: "confirmed", billable: true,
  repeatState: "none", repeatEndDate: null, projectTentative: false, projectNonBillable: false, phaseNonBillable: false, taskBillable: null,
  ...over,
});

const plan = (allocations: PrefillAllocation[], over: Partial<PrefillInput> = {}) =>
  planPrefill({ workDaysHours: WEEK, allocations, existing: [], from: "2026-03-02", to: "2026-03-08", ...over });

// @BR-11
describe("miroir des allocations confirmées", () => {
  it("une ligne par jour ouvré couvert, avec l'allocation source, le projet, la phase et la tâche", () => {
    const rows = plan([alloc("1", "2026-03-02", "2026-03-06", 6, { phaseId: "7", taskId: "8" })]);
    expect(rows.map((r) => r.workDate)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]);
    expect(rows[0]).toEqual({ allocationId: "1", projectId: "10", phaseId: "7", taskId: "8", workDate: "2026-03-02", hours: 6, billable: true });
  });
  it("ignore les jours non ouvrés et tout ce qui est hors de la fenêtre", () => {
    const rows = plan([alloc("1", "2026-02-27", "2026-03-10", 4)], { from: "2026-03-05", to: "2026-03-09" });
    expect(rows.map((r) => r.workDate)).toEqual(["2026-03-05", "2026-03-06", "2026-03-09"]);
  });
  it("ignore les allocations tentatives et celles d'un projet tentatif", () => {
    expect(plan([alloc("1", "2026-03-02", "2026-03-02", 4, { status: "tentative" })])).toEqual([]);
    expect(plan([alloc("2", "2026-03-02", "2026-03-02", 4, { projectTentative: true })])).toEqual([]);
  });
  it("ne retire rien pour congés ou fériés (miroir : l'utilisateur ajuste)", () => {
    // le moteur ne reçoit ni congé ni férié : la ligne est produite telle que planifiée
    expect(plan([alloc("1", "2026-03-04", "2026-03-04", 8)])).toHaveLength(1);
  });
  it("pourcentage : converti sur les heures brutes du jour, arrondi au centième", () => {
    const rows = plan([alloc("1", "2026-03-02", "2026-03-02", 0, { mode: "percentage", hoursPerDay: null, percent: 33.33 })]);
    expect(rows[0]!.hours).toBe(2.67); // 8 h x 33,33 % = 2,6664
  });
  it("répétition : chaque occurrence est reflétée jusqu'à la fin de la série", () => {
    const rows = plan([alloc("1", "2026-03-02", "2026-03-02", 3, { repeatState: "weekly", repeatEndDate: "2026-03-09" })], { to: "2026-03-15" });
    expect(rows.map((r) => r.workDate)).toEqual(["2026-03-02", "2026-03-09"]);
  });
  it("facturable : même règle que la charge facturable (allocation, projet, phase, tâche)", () => {
    const b = (over: Partial<PrefillAllocation>) => plan([alloc("1", "2026-03-02", "2026-03-02", 4, over)])[0]!.billable;
    expect(b({})).toBe(true);
    expect(b({ billable: false })).toBe(false);
    expect(b({ projectNonBillable: true })).toBe(false);
    expect(b({ phaseNonBillable: true })).toBe(false);
    expect(b({ taskBillable: false })).toBe(false);
  });
  it("tri déterministe : par jour puis par identifiant d'allocation", () => {
    const rows = plan([alloc("2", "2026-03-02", "2026-03-03", 1), alloc("1", "2026-03-03", "2026-03-03", 1)]);
    expect(rows.map((r) => `${r.workDate}/${r.allocationId}`)).toEqual(["2026-03-02/2", "2026-03-03/1", "2026-03-03/2"]);
  });
});

// @BR-28
describe("idempotence et plafond de 24 h", () => {
  it("saute (allocation, jour) déjà présents, quel que soit leur statut", () => {
    const rows = plan([alloc("1", "2026-03-02", "2026-03-04", 6)], { existing: [{ allocationId: "1", workDate: "2026-03-03", hours: 5 }] });
    expect(rows.map((r) => r.workDate)).toEqual(["2026-03-02", "2026-03-04"]);
  });
  it("rejouer avec le résultat précédent ne produit plus rien", () => {
    const first = plan([alloc("1", "2026-03-02", "2026-03-06", 6)]);
    const again = plan([alloc("1", "2026-03-02", "2026-03-06", 6)], { existing: first.map((r) => ({ allocationId: r.allocationId, workDate: r.workDate, hours: r.hours })) });
    expect(again).toEqual([]);
  });
  it("tronque au reste de la journée : 24 h au plus par jour, existant compris", () => {
    const rows = plan(
      [alloc("1", "2026-03-02", "2026-03-02", 20), alloc("2", "2026-03-02", "2026-03-02", 20), alloc("3", "2026-03-02", "2026-03-02", 20)],
      { existing: [{ allocationId: null, workDate: "2026-03-02", hours: 2 }] },
    );
    expect(rows.map((r) => [r.allocationId, r.hours])).toEqual([["1", 20], ["2", 2]]); // 2 + 20 + 2 = 24, la 3e est omise
  });
  it("ne crée aucune ligne si la journée est déjà pleine", () => {
    expect(plan([alloc("1", "2026-03-02", "2026-03-02", 4)], { existing: [{ allocationId: null, workDate: "2026-03-02", hours: 24 }] })).toEqual([]);
  });
});

// @BR-19 @BR-11 : horaire daté, comme daily_planned_load (person_work_days_hours_on) et non la seule période ouverte.
describe("horaire daté (workSchedule)", () => {
  const halfFromMar9 = {
    workDaysHours: [4, 4, 4, 4, 4, 0, 0], // période ouverte (future pour la semaine du 2 mars)
    workSchedule: [
      { validFrom: null, validTo: "2026-03-08", workDaysHours: WEEK },
      { validFrom: "2026-03-09", validTo: null, workDaysHours: [4, 4, 4, 4, 4, 0, 0] },
    ],
  };
  const full = alloc("1", "2026-03-02", "2026-03-13", 0, { mode: "percentage", hoursPerDay: null, percent: 100 });
  it("un changement daté ultérieur ne modifie pas la semaine qui le précède (8 h, pas 4 h)", () => {
    expect(plan([full], halfFromMar9).map((r) => r.hours)).toEqual([8, 8, 8, 8, 8]);
  });
  it("après la date d'effet, l'horaire de la nouvelle période s'applique", () => {
    expect(plan([full], { ...halfFromMar9, from: "2026-03-06", to: "2026-03-10" }).map((r) => [r.workDate, r.hours])).toEqual([
      ["2026-03-06", 8], ["2026-03-09", 4], ["2026-03-10", 4],
    ]);
  });
});
