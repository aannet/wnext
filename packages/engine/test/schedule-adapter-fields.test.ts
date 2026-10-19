// Conversion ScheduleResponse -> entrées du moteur : chaque champ du contrat doit arriver intact (aucune valeur figée ni permutée).
import { describe, expect, it } from "vitest";
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_THRESHOLDS } from "../src/capacity-state";
import { scheduleToEngineInput, scheduleUtilization } from "../src/schedule-adapter";

// Valeurs toutes distinctes des valeurs par défaut, pour qu'un champ oublié, permuté ou figé se voie.
const rich: ScheduleResponse = {
  window: { from: "2026-05-04", to: "2026-05-29" },
  changeCursor: "1",
  page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 60 }, timezone: "UTC" },
  people: [
    { id: "9", version: 3, name: "Zoe", peopleType: "contractor", departmentId: "d4", roleId: "r1", country: "BE",
      workDaysHours: [4, 6, 0, 7, 8, 1, 2], tags: ["a"], avatarUrl: null, active: false },
  ],
  allocations: [
    { id: "a7", version: 1, personId: "9", projectId: "51", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
      startDate: "2026-05-05", endDate: "2026-05-19", mode: "percentage", hoursPerDay: null, percent: 35, status: "tentative",
      billable: false, priority: 0, repeatState: "weekly", repeatEndDate: "2026-06-30" },
  ],
  timeoffs: [
    { id: "t1", version: 1, personId: "9", typeId: "2", startDate: "2026-05-11", endDate: "2026-05-12", scope: "partial",
      startHalf: "pm", endHalf: "am", hoursPerDay: 2.5, approvalStatus: "pending" },
  ],
  holidays: [{ id: "h1", name: "Fête", date: "2026-05-14", country: "BE", departmentId: "d4", hoursOff: 3 }],
  projects: [{ id: "51", name: "Pitch", projectCode: null, color: "#EF4444", status: "tentative", nonBillable: true }],
  timeoffTypes: [{ id: "2", name: "Vacances", deducted: false }],
  departments: [],
  roles: [],
};

describe("conversion fidèle : chaque champ du contrat arrive au moteur", () => {
  const out = scheduleToEngineInput(rich);

  it("fenêtre et seuil du compte", () => {
    expect(out.from).toBe("2026-05-04");
    expect(out.to).toBe("2026-05-29");
    expect(out.thresholds).toEqual({ underPercent: 60 });
  });
  it("personnes", () => {
    expect(out.people).toEqual([{ id: "9", active: false, workDaysHours: [4, 6, 0, 7, 8, 1, 2], country: "BE", departmentId: "d4" }]);
  });
  it("jours fériés (date, pays, département, heures retirées)", () => {
    expect(out.holidays).toEqual([{ hdate: "2026-05-14", country: "BE", departmentId: "d4", hoursOff: 3 }]);
  });
  it("congés : périmètre, demi-journées, heures, statut, et déduction héritée du type", () => {
    expect(out.timeoffs).toEqual([{ personId: "9", startDate: "2026-05-11", endDate: "2026-05-12", scope: "partial", startHalf: "pm",
      endHalf: "am", hoursPerDay: 2.5, deducted: false, approvalStatus: "pending" }]);
    const deducted = scheduleToEngineInput({ ...rich, timeoffTypes: [{ id: "2", name: "Vacances", deducted: true }] });
    expect(deducted.timeoffs[0]!.deducted).toBe(true);
  });
  it("allocations : champs repris, projet tentatif et non facturable lus sur le projet, phase et tâche sans information", () => {
    expect(out.allocations).toEqual([{ id: "a7", personId: "9", startDate: "2026-05-05", endDate: "2026-05-19", mode: "percentage",
      hoursPerDay: null, percent: 35, status: "tentative", billable: false, repeatState: "weekly", repeatEndDate: "2026-06-30",
      projectTentative: true, projectNonBillable: true, phaseNonBillable: false, taskBillable: null }]);
  });
  it("projet confirmé et facturable : drapeaux à faux", () => {
    const o = scheduleToEngineInput({ ...rich, projects: [{ id: "51", name: "Pitch", projectCode: null, color: "#000", status: "in_progress", nonBillable: false }] });
    expect(o.allocations[0]).toMatchObject({ projectTentative: false, projectNonBillable: false });
  });
  it("seuil du compte absent : seuil par défaut du moteur", () => {
    const o = scheduleToEngineInput({ ...rich, account: { weekStart: 1, capacityThresholds: {}, timezone: "UTC" } });
    expect(o.thresholds).toEqual({ underPercent: DEFAULT_THRESHOLDS.underPercent });
  });
  it("réponse vide : entrées vides, sans erreur", () => {
    const o = scheduleToEngineInput({ ...rich, people: [], holidays: [], timeoffs: [], allocations: [], projects: [], timeoffTypes: [] });
    expect(o).toMatchObject({ people: [], holidays: [], timeoffs: [], allocations: [] });
  });
  it("messages d'erreur : identifiant fautif et objet concerné", () => {
    expect(() => scheduleToEngineInput({ ...rich, timeoffTypes: [] })).toThrow("UNKNOWN_TIMEOFF_TYPE: 2 (congé t1)");
    expect(() => scheduleToEngineInput({ ...rich, projects: [] })).toThrow("UNKNOWN_PROJECT: 51 (allocation a7)");
  });
  it("scheduleUtilization : une ligne par jour de la fenêtre, bornes incluses, sans le seuil", () => {
    const active = { ...rich, people: [{ ...rich.people[0]!, active: true }] };
    const rows = scheduleUtilization(active);
    expect(scheduleUtilization(rich)).toEqual([]); // personne inactive : aucune ligne
    expect(rows).toHaveLength(26);
    expect(rows[0]!.day).toBe("2026-05-04");
    expect(rows[rows.length - 1]!.day).toBe("2026-05-29");
    expect(new Set(rows.map((r) => r.personId))).toEqual(new Set(["9"]));
  });
});
