// BR-04 + BR-19 : l'assistant de congé (détection, proposition, écritures) suit l'horaire DATÉ de la personne, comme dailyCapacity
// et resolutionWrites. Sinon (charge calculée sur la seule période ouverte) un report pouvait produire un morceau négatif.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PersonInput, TimeoffInput } from "../src/capacity";
import { addDays } from "../src/dates";
import { allocationHoursOn } from "../src/load";
import { detectTimeoffConflicts, proposeResolution, type IdentifiedAllocation } from "../src/timeoff-conflicts";
import { resolutionWrites, type ResolutionChoice, type ResolutionWrites } from "../src/timeoff-resolution";
import { workDaysHoursOn, type WorkScheduleEntry } from "../src/work-schedule";

const MON = "2026-04-13";
const off = (startDate: string, endDate = startDate): TimeoffInput => ({
  personId: "tom", startDate, endDate, scope: "full_day", startHalf: "am", endHalf: "pm", hoursPerDay: null, deducted: true, approvalStatus: "approved",
});
const alloc = (startDate: string, endDate: string, over: Partial<IdentifiedAllocation>): IdentifiedAllocation => ({
  id: "a", personId: "tom", startDate, endDate, mode: "hours", hoursPerDay: 8, percent: null, status: "confirmed",
  billable: true, repeatState: "none", repeatEndDate: null, projectTentative: false, projectNonBillable: false,
  phaseNonBillable: false, taskBillable: null, ...over,
});

function run(person: PersonInput, timeoff: TimeoffInput, a: IdentifiedAllocation, choice: ResolutionChoice) {
  const base = { person, timeoff, timeoffs: [], holidays: [], allocations: [a] };
  const conflicts = detectTimeoffConflicts({ ...base, logged: [] }).days;
  const resolutions = proposeResolution({ ...base, conflicts });
  const w = resolutionWrites({ allocation: a, workDaysHours: person.workDaysHours, ...(person.workSchedule && { workSchedule: person.workSchedule }), resolutions, choice });
  return { conflicts, resolutions, w };
}

/** Heures totales portées par l'allocation (horaire daté), et par ses écritures. */
function total(person: PersonInput, a: IdentifiedAllocation, from: string, to: string) {
  let s = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) s += allocationHoursOn(a, workDaysHoursOn(person, d), d);
  return s;
}
function totalAfter(person: PersonInput, a: IdentifiedAllocation, w: ResolutionWrites) {
  let s = 0;
  if (w.update) {
    const u = { ...a, startDate: w.update.startDate, endDate: w.update.endDate, ...(w.update.hoursPerDay !== undefined && { hoursPerDay: w.update.hoursPerDay }) };
    s += total(person, u, u.startDate, u.endDate);
  }
  for (const c of w.creates) {
    const piece = c.hoursPerDay === null ? { ...a, startDate: c.startDate, endDate: c.endDate } : { ...a, mode: "hours" as const, hoursPerDay: c.hoursPerDay, percent: null, startDate: c.startDate, endDate: c.endDate };
    s += total(person, piece, c.startDate, c.endDate);
  }
  return s;
}

// @BR-04 @BR-19
describe("assistant de congé sur horaire daté", () => {
  // Période ouverte à 8 h, mais 4 h jusqu'au dimanche 19 avril (horaire passé à temps plein le 20).
  const tom: PersonInput = {
    id: "tom", active: true, country: null, departmentId: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0],
    workSchedule: [
      { validFrom: null, validTo: "2026-04-19", workDaysHours: [4, 4, 4, 4, 4, 0, 0] },
      { validFrom: "2026-04-20", validTo: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
    ],
  };
  const full = alloc(MON, "2026-04-17", { mode: "percentage", hoursPerDay: null, percent: 100 });

  it("détection : la charge d'un jour est celle de l'horaire en vigueur ce jour-là (4 h, pas 8 h)", () => {
    const { conflicts } = run(tom, off("2026-04-15"), full, "move");
    expect(conflicts.map((c) => [c.day, c.plannedHours, c.overtimeHours])).toEqual([["2026-04-15", 4, 4]]);
  });

  it("report : aucun morceau négatif, les 4 h du congé sont reportées", () => {
    const { w } = run(tom, off("2026-04-15"), full, "move");
    expect(w!.movedHours).toBe(4);
    for (const c of w!.creates) if (c.hoursPerDay !== null) expect(c.hoursPerDay).toBeGreaterThan(0);
    expect(totalAfter(tom, full, w!)).toBe(total(tom, full, MON, "2026-04-17"));
  });

  it("propriété : quel que soit l'historique, aucun morceau <= 0 et heures conservées (reporter) ou retirées exactement (réduire)", () => {
    const week = fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 7, maxLength: 7 });
    fc.assert(
      fc.property(
        week, week, fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 2 }), fc.boolean(), fc.constantFrom<ResolutionChoice>("move", "reduce"),
        fc.integer({ min: 1, max: 10 }), fc.integer({ min: 10, max: 150 }),
        (before, after, cut, startOff, len, offStart, offLen, pctMode, choice, hours, percent) => {
          const pivot = addDays(MON, cut);
          const schedule: WorkScheduleEntry[] = [
            { validFrom: null, validTo: addDays(pivot, -1), workDaysHours: before },
            { validFrom: pivot, validTo: null, workDaysHours: after },
          ];
          const person: PersonInput = { id: "tom", active: true, country: null, departmentId: null, workDaysHours: after, workSchedule: schedule };
          const start = addDays(MON, startOff);
          const end = addDays(start, len);
          const a = alloc(start, end, pctMode ? { mode: "percentage", hoursPerDay: null, percent } : { hoursPerDay: hours });
          const t = off(addDays(start, Math.min(offStart, len)), addDays(start, Math.min(offStart + offLen, len)));
          const { resolutions, w } = run(person, t, a, choice);
          if (!w) return;
          if (w.update?.hoursPerDay !== undefined) expect(w.update.hoursPerDay).toBeGreaterThan(0);
          for (const c of w.creates) if (c.hoursPerDay !== null) expect(c.hoursPerDay).toBeGreaterThan(0);
          const unplaced = resolutions.reduce((s, r) => s + r.unplacedHours, 0);
          expect(unplaced).toBeGreaterThanOrEqual(0);
          const expected = total(person, a, a.startDate, a.endDate) - (choice === "reduce" ? w.removedHours : 0);
          expect(totalAfter(person, a, w)).toBeCloseTo(expected, 6);
        },
      ),
      { numRuns: 400 },
    );
  });
});
