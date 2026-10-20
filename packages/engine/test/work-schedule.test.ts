// Horaire daté (@BR-19) : miroir de people_history / person_work_days_hours_on() (migration 0002). Mêmes cas que
// tests/sql/people_history_tests.sql H02 : changement d'horaire au 1er du mois, capacité et charge avant/après.
import { describe, expect, it } from "vitest";
import { dailyCapacity, type PersonInput } from "../src/capacity";
import { dailyPlannedLoad, type AllocationInput } from "../src/load";
import { utilization } from "../src/utilization";
import { workDaysHoursOn, type WorkScheduleEntry } from "../src/work-schedule";

const FULL = [8, 8, 8, 8, 8, 0, 0];
const HALF = [4, 4, 4, 4, 4, 0, 0];
// Mardi 31/03 : 8 h ; mercredi 01/04 : 4 h.
const APRIL: WorkScheduleEntry[] = [
  { validFrom: null, validTo: "2026-03-31", workDaysHours: FULL },
  { validFrom: "2026-04-01", validTo: null, workDaysHours: HALF },
];
const person = (over: Partial<PersonInput> = {}): PersonInput => ({ id: "p", active: true, workDaysHours: HALF, country: null, departmentId: null, workSchedule: APRIL, ...over });
const alloc = (over: Partial<AllocationInput> = {}): AllocationInput => ({
  personId: "p", startDate: "2026-03-31", endDate: "2026-04-01", mode: "percentage", hoursPerDay: null, percent: 50,
  status: "confirmed", billable: true, repeatState: "none", repeatEndDate: null,
  projectTentative: false, projectNonBillable: false, phaseNonBillable: false, taskBillable: null, ...over,
});

describe("workDaysHoursOn (@BR-19)", () => {
  it("rend l'horaire de la période qui couvre le jour, bornes incluses", () => {
    const p = { workDaysHours: HALF, workSchedule: APRIL };
    expect(workDaysHoursOn(p, "2026-01-01")).toBe(FULL);
    expect(workDaysHoursOn(p, "2026-03-31")).toBe(FULL);
    expect(workDaysHoursOn(p, "2026-04-01")).toBe(HALF);
    expect(workDaysHoursOn(p, "2099-12-31")).toBe(HALF);
  });

  it("sans historique, ou hors de toute période (historique partiel), retombe sur workDaysHours", () => {
    expect(workDaysHoursOn({ workDaysHours: FULL }, "2026-04-01")).toBe(FULL);
    expect(workDaysHoursOn({ workDaysHours: FULL, workSchedule: [] }, "2026-04-01")).toBe(FULL);
    const partial = { workDaysHours: FULL, workSchedule: [{ validFrom: "2026-04-01", validTo: "2026-04-30", workDaysHours: HALF }] };
    expect(workDaysHoursOn(partial, "2026-03-31")).toBe(FULL);
    expect(workDaysHoursOn(partial, "2026-04-15")).toBe(HALF);
    expect(workDaysHoursOn(partial, "2026-05-01")).toBe(FULL);
  });
});

describe("capacité, charge et utilisation datées (@BR-19)", () => {
  it("changement d'horaire au 1er du mois : capacité 8 h le 31/03, 4 h le 01/04", () => {
    const rows = dailyCapacity({ people: [person()], holidays: [], timeoffs: [], from: "2026-03-30", to: "2026-04-05" });
    expect(rows.map((r) => r.capacityHours)).toEqual([8, 8, 4, 4, 4, 0, 0]);
  });

  it("fériés et congés se déduisent de l'horaire du jour même", () => {
    const rows = dailyCapacity({
      people: [person()],
      holidays: [{ hdate: "2026-03-31", country: null, departmentId: null, hoursOff: null }],
      timeoffs: [{ personId: "p", startDate: "2026-04-01", endDate: "2026-04-01", scope: "full_day", startHalf: "pm", endHalf: "pm", hoursPerDay: null, deducted: true, approvalStatus: "approved" }],
      from: "2026-03-31", to: "2026-04-01",
    });
    expect(rows.map((r) => [r.baseHours, r.holidayHours, r.timeoffHours])).toEqual([[8, 8, 0], [4, 0, 2]]);
  });

  it("charge en pourcentage (BR-24) : base brute du jour, 4 h puis 2 h ; un jour devenu non ouvré n'a plus de charge", () => {
    const load = dailyPlannedLoad({ people: [person()], allocations: [alloc()], from: "2026-03-31", to: "2026-04-01" });
    expect(load.map((r) => r.plannedHours)).toEqual([4, 2]);
    const thursdayOff: WorkScheduleEntry[] = [APRIL[0]!, { validFrom: "2026-04-01", validTo: null, workDaysHours: [4, 4, 4, 0, 0, 0, 0] }];
    const hours = dailyPlannedLoad({
      people: [person({ workSchedule: thursdayOff })], allocations: [alloc({ mode: "hours", hoursPerDay: 2, percent: null, startDate: "2026-03-26", endDate: "2026-04-02" })],
      from: "2026-03-26", to: "2026-04-02",
    });
    expect(hours.filter((r) => r.day === "2026-03-26" || r.day === "2026-04-02").map((r) => r.day)).toEqual(["2026-03-26"]);
  });

  it("utilization joint capacité et charge datées", () => {
    const rows = utilization({ people: [person()], holidays: [], timeoffs: [], allocations: [alloc()], from: "2026-03-31", to: "2026-04-01" });
    expect(rows.map((r) => [r.capacityHours, r.plannedHours, r.utilization])).toEqual([[8, 4, 0.5], [4, 2, 0.5]]);
  });

  it("sans historique : comportement inchangé (workDaysHours)", () => {
    const rows = dailyCapacity({ people: [person({ workSchedule: undefined, workDaysHours: FULL })], holidays: [], timeoffs: [], from: "2026-04-01", to: "2026-04-01" });
    expect(rows[0]!.capacityHours).toBe(8);
  });
});
