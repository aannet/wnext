// BR-04 : application du report assisté, allocation par allocation (reporter ou réduire), en écritures d'allocation.
import { describe, expect, it } from "vitest";
import type { PersonInput, TimeoffInput } from "../src/capacity";
import type { AllocationInput } from "../src/load";
import { detectTimeoffConflicts, proposeResolution, type IdentifiedAllocation } from "../src/timeoff-conflicts";
import { resolutionWrites, type ResolutionChoice } from "../src/timeoff-resolution";

const tom: PersonInput = { id: "tom", active: true, workDaysHours: [8, 8, 8, 8, 8, 0, 0], country: null, departmentId: null };
const alloc = (id: string, startDate: string, endDate: string, hours: number, over: Partial<AllocationInput> = {}): IdentifiedAllocation => ({
  id, personId: "tom", startDate, endDate, mode: "hours", hoursPerDay: hours, percent: null, status: "confirmed",
  billable: true, repeatState: "none", repeatEndDate: null, projectTentative: false, projectNonBillable: false,
  phaseNonBillable: false, taskBillable: null, ...over,
});
const pct = (id: string, startDate: string, endDate: string, percent: number) => alloc(id, startDate, endDate, 0, { mode: "percentage", hoursPerDay: null, percent });
const off = (startDate: string, endDate = startDate, over: Partial<TimeoffInput> = {}): TimeoffInput => ({
  personId: "tom", startDate, endDate, scope: "full_day", startHalf: "am", endHalf: "pm", hoursPerDay: null,
  deducted: true, approvalStatus: "approved", ...over,
});

const MON = "2026-04-13", TUE = "2026-04-14", WED = "2026-04-15", THU = "2026-04-16", FRI = "2026-04-17", NEXT_MON = "2026-04-20";

function writes(timeoff: TimeoffInput, allocations: IdentifiedAllocation[], id: string, choice: ResolutionChoice, horizonDays?: number) {
  const conflicts = detectTimeoffConflicts({ person: tom, timeoff, timeoffs: [], holidays: [], allocations, logged: [] }).days;
  const resolutions = proposeResolution({ person: tom, timeoff, timeoffs: [], holidays: [], allocations, conflicts, horizonDays });
  return resolutionWrites({ allocation: allocations.find((a) => a.id === id)!, workDaysHours: tom.workDaysHours, resolutions, choice });
}

// @BR-04
describe("écritures du report assisté", () => {
  it("reporter : la journée de congé sort de l'allocation, ses heures prolongent la fin (week-end sauté)", () => {
    const w = writes(off(WED), [alloc("a", MON, FRI, 8)], "a", "move");
    expect(w).toEqual({
      allocationId: "a", update: { startDate: MON, endDate: TUE }, creates: [{ startDate: THU, endDate: NEXT_MON, hoursPerDay: null }],
      movedHours: 8, removedHours: 0,
    });
  });
  it("réduire : la journée de congé est retirée, le reste de l'allocation est intact", () => {
    const w = writes(off(WED), [alloc("a", MON, FRI, 8)], "a", "reduce");
    expect(w).toEqual({
      allocationId: "a", update: { startDate: MON, endDate: TUE }, creates: [{ startDate: THU, endDate: FRI, hoursPerDay: null }],
      movedHours: 0, removedHours: 8,
    });
  });
  it("allocation entièrement couverte par le congé : simple déplacement des dates", () => {
    expect(writes(off(WED), [alloc("a", WED, WED, 8)], "a", "move")).toMatchObject({ update: { startDate: THU, endDate: THU }, creates: [] });
  });
  it("réduire à zéro tout le contenu : suppression (aucun morceau)", () => {
    expect(writes(off(WED), [alloc("a", WED, WED, 8)], "a", "reduce")).toEqual({ allocationId: "a", update: null, creates: [], movedHours: 0, removedHours: 8 });
  });
  it("demi-journée : l'excédent part le lendemain, l'allocation passe à 4 h sur deux jours", () => {
    const w = writes(off(MON, MON, { endHalf: "am" }), [alloc("a", MON, MON, 8)], "a", "move");
    expect(w).toMatchObject({ update: { startDate: MON, endDate: TUE, hoursPerDay: 4 }, creates: [], movedHours: 4 });
  });
  it("heures non placées (horizon trop court) : elles restent sur leur jour, jamais perdues", () => {
    const w = writes(off(MON), [alloc("a", MON, MON, 6), alloc("b", TUE, TUE, 6)], "a", "move", 1);
    expect(w).toMatchObject({ update: { startDate: MON, endDate: MON, hoursPerDay: 4 }, creates: [{ startDate: TUE, endDate: TUE, hoursPerDay: 2 }], movedHours: 2 });
  });
  it("pourcentage : l'origine garde ses morceaux en %, la réduction partielle devient un morceau en heures", () => {
    expect(writes(off(TUE), [pct("p", MON, WED, 100)], "p", "reduce")).toMatchObject({
      update: { startDate: MON, endDate: MON }, creates: [{ startDate: WED, endDate: WED, hoursPerDay: null }],
    });
    expect(writes(off(MON, MON, { endHalf: "am" }), [pct("p", MON, MON, 100)], "p", "reduce")).toEqual({
      allocationId: "p", update: null, creates: [{ startDate: MON, endDate: MON, hoursPerDay: 4 }], movedHours: 0, removedHours: 4,
    });
  });
  it("série, allocation hors conflit ou sans heure à déplacer : rien à écrire (null)", () => {
    const weekly = alloc("w", MON, MON, 5, { repeatState: "weekly", repeatEndDate: "2026-05-31" });
    expect(writes(off(MON), [weekly], "w", "move")).toBeNull();
    expect(writes(off(MON), [alloc("a", MON, MON, 4), alloc("z", THU, THU, 4)], "z", "move")).toBeNull();
    expect(writes(off(MON, MON, { endHalf: "am" }), [alloc("a", MON, MON, 4)], "a", "reduce")).toBeNull();
  });
  it("report au-delà d'autres jours pleins : l'allocation saute jusqu'au premier jour libre", () => {
    const w = writes(off(MON), [alloc("a", MON, MON, 8), alloc("b", TUE, FRI, 8)], "a", "move");
    expect(w).toMatchObject({ update: { startDate: NEXT_MON, endDate: NEXT_MON }, creates: [] });
  });
  it("demi-journée à deux allocations : seule celle dont l'excédent part est touchée ; proposition sans entrée : rien", () => {
    const all = [alloc("a", MON, MON, 4), alloc("b", MON, MON, 4)];
    expect(writes(off(MON, MON, { endHalf: "am" }), all, "b", "move")).toBeNull();
    const none = resolutionWrites({ allocation: all[0]!, workDaysHours: tom.workDaysHours, choice: "reduce", resolutions: [{ day: MON, reduce: [], moves: [], unplacedHours: 0 }] });
    expect(none).toBeNull();
  });
  it("deux allocations le même jour : chacune ne reprend que ses propres heures", () => {
    const all = [alloc("a", WED, WED, 4), alloc("b", WED, WED, 4)];
    expect(writes(off(WED), all, "a", "move")).toMatchObject({ update: { startDate: THU, endDate: THU }, movedHours: 4 });
    expect(writes(off(WED), all, "b", "move")).toMatchObject({ update: { startDate: THU, endDate: THU }, movedHours: 4 });
  });
});
