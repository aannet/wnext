// Avertissements non bloquants d'une écriture : dates hors phase (@BR-37) et surcharge selon l'horaire daté (@BR-19, @BR-01).
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { editWarnings } from "../src/schedule/edit-warnings";

type Alloc = ScheduleResponse["allocations"][number];
const person = {
  id: "1", version: 1, name: "P1", peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
};
const alloc = (over: Partial<Alloc> = {}): Alloc => ({
  id: "100", version: 1, personId: "1", projectId: "10", phaseId: "7", taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-03-03", endDate: "2026-03-05", status: "confirmed", billable: true, priority: 0,
  repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 6, percent: null, ...over,
} as Alloc);
const data = (over: Partial<ScheduleResponse> = {}): ScheduleResponse => ({
  window: { from: "2026-03-02", to: "2026-03-29" }, changeCursor: "0", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" }, people: [person], allocations: [], timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Pr", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: "2026-03-01", endDate: "2026-03-31" }],
  phases: [{ id: "7", version: 1, projectId: "10", name: "Conception", startDate: "2026-03-03", endDate: "2026-03-06", color: null }],
  timeoffTypes: [], departments: [], roles: [],
  ...over,
});

describe("dates hors phase (@BR-37)", () => {
  it("dans la phase : rien ; avant ou après la phase : avertissement, jamais de refus", () => {
    expect(editWarnings(data(), alloc())).toEqual([]);
    expect(editWarnings(data(), alloc({ startDate: "2026-03-02" }))).toEqual(["ALLOCATION_STARTS_BEFORE_PHASE"]);
    expect(editWarnings(data(), alloc({ endDate: "2026-03-09" }))).toEqual(["ALLOCATION_ENDS_AFTER_PHASE"]);
  });

  it("projet et phase dépassés ensemble : les deux avertissements", () => {
    expect(editWarnings(data(), alloc({ startDate: "2026-02-27", endDate: "2026-04-01" }))).toEqual([
      "ALLOCATION_STARTS_BEFORE_PROJECT", "ALLOCATION_ENDS_AFTER_PROJECT", "ALLOCATION_STARTS_BEFORE_PHASE", "ALLOCATION_ENDS_AFTER_PHASE",
    ]);
  });

  it("sans phase, phase inconnue ou phases non transportées : aucun avertissement de phase", () => {
    expect(editWarnings(data(), alloc({ phaseId: null, startDate: "2026-03-02" }))).toEqual([]);
    expect(editWarnings(data(), alloc({ phaseId: "99", startDate: "2026-03-02" }))).toEqual([]);
    expect(editWarnings(data({ phases: undefined }), alloc({ startDate: "2026-03-02" }))).toEqual([]);
  });
});

describe("surcharge selon l'horaire en vigueur (@BR-19)", () => {
  // Passage à 4 h par jour le lundi 9 mars : 6 h tiennent avant, débordent après.
  const dated = data({
    people: [{
      ...person, workDaysHours: [4, 4, 4, 4, 4, 0, 0],
      workSchedule: [
        { validFrom: null, validTo: "2026-03-08", workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
        { validFrom: "2026-03-09", validTo: null, workDaysHours: [4, 4, 4, 4, 4, 0, 0] },
      ],
    }],
    phases: [],
  });

  it("avant le changement : pas de surcharge ; après : surcharge", () => {
    expect(editWarnings(dated, alloc({ phaseId: null }))).toEqual([]);
    expect(editWarnings(dated, alloc({ phaseId: null, startDate: "2026-03-10", endDate: "2026-03-11" }))).toEqual(["OVERLOAD"]);
  });
});
