// Le contrat GET /api/v1/schedule doit suffire au moteur : capacité, utilisation, états et conflits BR-04 se calculent
// côté client à partir de la seule réponse. La charge utile ci-dessous est typée par le contrat (la compilation le prouve).
import { describe, expect, it } from "vitest";
import type { ScheduleResponse } from "@wnext/contracts";
import { classifyCapacity } from "../src/capacity-state";
import { detectTimeoffConflicts } from "../src/timeoff-conflicts";
import { scheduleToEngineInput, scheduleUtilization } from "../src/schedule-adapter";

const base = {
  id: "100", version: 1, personId: "1", projectId: "50", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  endDate: "2026-03-06", status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null,
} as const;

const response: ScheduleResponse = {
  window: { from: "2026-03-02", to: "2026-03-20" },
  changeCursor: "42",
  page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 90 }, timezone: "UTC" },
  people: [
    { id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: "FR",
      workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true },
    { id: "2", version: 1, name: "Bob", peopleType: "employee", departmentId: null, roleId: null, country: "DE",
      workDaysHours: [0, 4, 4, 4, 0, 0, 0], tags: [], avatarUrl: null, active: true },
  ],
  allocations: [
    { ...base, startDate: "2026-03-02", mode: "hours", hoursPerDay: 6, percent: null },
    { ...base, id: "101", projectId: "51", startDate: "2026-03-03", endDate: "2026-03-03", mode: "hours", hoursPerDay: 4, percent: null },
    { ...base, id: "102", personId: "2", startDate: "2026-03-03", endDate: "2026-03-03", mode: "percentage", hoursPerDay: null, percent: 150 },
    { ...base, id: "103", startDate: "2026-03-10", endDate: "2026-03-10", mode: "hours", hoursPerDay: 5, percent: null },
  ],
  timeoffs: [{ id: "7", version: 1, personId: "1", typeId: "2", startDate: "2026-03-10", endDate: "2026-03-11", scope: "full_day",
    startHalf: "am", endHalf: "pm", hoursPerDay: null, approvalStatus: "approved" },
    { id: "8", version: 1, personId: "1", typeId: "3", startDate: "2026-03-05", endDate: "2026-03-05", scope: "partial",
      startHalf: "am", endHalf: "pm", hoursPerDay: 4, approvalStatus: "approved" }],
  holidays: [{ id: "9", name: "Férié FR", date: "2026-03-17", country: "FR", departmentId: null, hoursOff: null }],
  projects: [
    { id: "50", name: "Site web", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false },
    { id: "51", name: "Pitch", projectCode: null, color: "#EF4444", status: "tentative", nonBillable: false },
  ],
  timeoffTypes: [{ id: "2", name: "Vacances", deducted: true }, { id: "3", name: "Télétravail", deducted: false }],
  departments: [],
  roles: [],
};

const row = (rows: ReturnType<typeof scheduleUtilization>, personId: string, day: string) => rows.find((r) => r.personId === personId && r.day === day)!;

describe("réponse du contrat -> moteur", () => {
  const rows = scheduleUtilization(response);
  it("capacité nette : horaires, congé approuvé, férié de pays", () => {
    expect(row(rows, "1", "2026-03-02").capacityHours).toBe(8);
    expect(row(rows, "1", "2026-03-10").capacityHours).toBe(0); // congé
    expect(row(rows, "1", "2026-03-17").capacityHours).toBe(0); // férié FR
    expect(row(rows, "1", "2026-03-05").capacityHours).toBe(8); // télétravail : type non déduit
    expect(row(rows, "2", "2026-03-17").capacityHours).toBe(4); // le férié FR ne touche pas Bob (DE)
    expect(row(rows, "2", "2026-03-02").capacityHours).toBe(0); // lundi non ouvré pour Bob
  });
  it("charge : heures, pourcentage sur la base brute, projet tentatif décomposé", () => {
    const tue = row(rows, "1", "2026-03-03");
    expect(tue).toMatchObject({ plannedHours: 10, tentativeHours: 4, overtimeHours: 2, isOverbooked: true });
    expect(row(rows, "2", "2026-03-03")).toMatchObject({ plannedHours: 6, capacityHours: 4 }); // 150 % de 4 h brutes
  });
  it("états de capacité avec le seuil du compte (90 %)", () => {
    const t = scheduleToEngineInput(response).thresholds;
    expect(t).toEqual({ underPercent: 90 });
    expect(classifyCapacity(row(rows, "1", "2026-03-02"), t).state).toBe("under"); // 6/8 = 75 %
    const tue = classifyCapacity(row(rows, "1", "2026-03-03"), t);
    // 6 h confirmées + 4 h sur le projet tentatif : la sur-allocation n'existe que si le tentatif se confirme
    expect(tue).toMatchObject({ state: "over", overbookedConfirmed: false, potentialOnly: true });
    expect(classifyCapacity(row(rows, "1", "2026-03-10"), t).state).toBe("over"); // congé sur une allocation : jamais masqué
  });
  it("BR-04 : le congé approuvé sur l'allocation du 10/03 est détecté à partir de la réponse seule", () => {
    const input = scheduleToEngineInput(response);
    const person = input.people.find((p) => p.id === "1")!;
    const timeoff = input.timeoffs.find((t) => t.personId === "1")!;
    const r = detectTimeoffConflicts({ person, timeoff, timeoffs: [], holidays: input.holidays, allocations: input.allocations, logged: [] });
    expect(r.requiresAssistant).toBe(true);
    expect(r.days).toMatchObject([{ day: "2026-03-10", plannedHours: 5, allocations: [{ allocationId: "103", hours: 5 }] }]);
  });
  it("incohérence de la réponse (type de congé ou projet inconnu) : erreur explicite, jamais une capacité fausse en silence", () => {
    expect(() => scheduleToEngineInput({ ...response, timeoffTypes: [] })).toThrow(/UNKNOWN_TIMEOFF_TYPE/);
    expect(() => scheduleToEngineInput({ ...response, projects: [] })).toThrow(/UNKNOWN_PROJECT/);
  });
});
