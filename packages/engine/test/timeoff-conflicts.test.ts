// BR-04 : un congé pleine journée posé sur des allocations / du temps loggé ne supprime rien ;
// il produit un avertissement listant les impacts, puis une proposition de report assisté.
import { describe, expect, it } from "vitest";
import type { HolidayInput, PersonInput, TimeoffInput } from "../src/capacity";
import type { AllocationInput } from "../src/load";
import { detectTimeoffConflicts, proposeResolution, type IdentifiedAllocation, type LoggedTimeInput } from "../src/timeoff-conflicts";

const tom: PersonInput = { id: "tom", active: true, workDaysHours: [8, 8, 8, 8, 8, 0, 0], country: null, departmentId: null };

const alloc = (id: string, day: string, hours: number, over: Partial<AllocationInput> = {}): IdentifiedAllocation => ({
  id, personId: "tom", startDate: day, endDate: day, mode: "hours", hoursPerDay: hours, percent: null, status: "confirmed",
  billable: true, repeatState: "none", repeatEndDate: null, projectTentative: false, projectNonBillable: false,
  phaseNonBillable: false, taskBillable: null, ...over,
});

const off = (startDate: string, endDate = startDate, over: Partial<TimeoffInput> = {}): TimeoffInput => ({
  personId: "tom", startDate, endDate, scope: "full_day", startHalf: "am", endHalf: "pm", hoursPerDay: null,
  deducted: true, approvalStatus: "approved", ...over,
});

const MON = "2026-04-13", TUE = "2026-04-14", WED = "2026-04-15";

const detect = (timeoff: TimeoffInput, allocations: IdentifiedAllocation[], logged: LoggedTimeInput[] = [], extra: { holidays?: HolidayInput[]; timeoffs?: TimeoffInput[]; from?: string; to?: string } = {}) =>
  detectTimeoffConflicts({ person: tom, timeoff, timeoffs: extra.timeoffs ?? [], holidays: extra.holidays ?? [], allocations, logged, from: extra.from, to: extra.to });

// @BR-04
describe("détection des conflits", () => {
  it("congé pleine journée sur un jour alloué : liste les allocations impactées, ne supprime rien", () => {
    const allocations = [alloc("a1", MON, 4), alloc("a2", MON, 3)];
    const snapshot = JSON.stringify(allocations);
    const r = detect(off(MON, TUE), allocations);
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({
      day: MON, capacityHours: 0, timeoffHours: 8, plannedHours: 7, overtimeHours: 7, loggedHours: 0,
      allocations: [{ allocationId: "a1", hours: 4 }, { allocationId: "a2", hours: 3 }],
    });
    expect(JSON.stringify(allocations)).toBe(snapshot);
  });
  it("aucune allocation ni temps loggé : aucun conflit", () => {
    expect(detect(off(MON, WED), [])).toEqual({ days: [], requiresAssistant: false });
  });
  it("temps loggé seul : signalé, jamais modifié", () => {
    const logged = Object.freeze([{ personId: "tom", day: MON, hours: 2 }]);
    const r = detect(off(MON), [], logged as LoggedTimeInput[]);
    expect(r.days[0]).toMatchObject({ day: MON, loggedHours: 2, plannedHours: 0, allocations: [] });
  });
  it("BR-05 : les allocations d'une autre personne sont ignorées", () => {
    const other = alloc("x", MON, 6, { personId: "tom2" });
    expect(detect(off(MON), [other]).days).toEqual([]);
    expect(detect(off(MON), [], [{ personId: "tom2", day: MON, hours: 3 }]).days).toEqual([]);
  });
  it("@BR-29 : en attente, le conflit est visible mais l'assistant n'est déclenché qu'à l'approbation", () => {
    const a = [alloc("a1", MON, 4)];
    expect(detect(off(MON, MON, { approvalStatus: "pending" }), a)).toMatchObject({ requiresAssistant: false, days: [{ day: MON }] });
    expect(detect(off(MON, MON, { approvalStatus: "approved" }), a).requiresAssistant).toBe(true);
  });
  it("congé refusé, partiel ou de type non déduit : pas de conflit", () => {
    const a = [alloc("a1", MON, 4)];
    expect(detect(off(MON, MON, { approvalStatus: "declined" }), a).days).toEqual([]);
    expect(detect(off(MON, MON, { scope: "partial", hoursPerDay: 4 }), a).days).toEqual([]);
    expect(detect(off(MON, MON, { deducted: false }), a).days).toEqual([]);
  });
  it("demi-journée : conflit seulement si la charge dépasse la capacité restante", () => {
    const am = off(MON, MON, { startHalf: "am", endHalf: "am" });
    expect(detect(am, [alloc("a1", MON, 4)]).days).toEqual([]);
    expect(detect(am, [alloc("a1", MON, 6)]).days[0]).toMatchObject({ capacityHours: 4, timeoffHours: 4, overtimeHours: 2 });
  });
  it("jour férié : le congé n'ajoute rien, l'allocation n'est pas un conflit de congé", () => {
    const holidays: HolidayInput[] = [{ hdate: MON, country: null, departmentId: null, hoursOff: null }];
    expect(detect(off(MON), [alloc("a1", MON, 4)], [], { holidays }).days).toEqual([]);
  });
  it("jours non ouvrés ignorés ; fenêtre from/to respectée", () => {
    const r = detect(off("2026-04-17", "2026-04-20"), [alloc("a1", "2026-04-18", 4), alloc("a2", "2026-04-20", 3)]);
    expect(r.days.map((d) => d.day)).toEqual(["2026-04-20"]);
    const w = detect(off(MON, WED), [alloc("a1", MON, 2), alloc("a2", TUE, 2), alloc("a3", WED, 2)], [], { from: TUE, to: TUE });
    expect(w.days.map((d) => d.day)).toEqual([TUE]);
  });
  it("allocation répétée : retrouvée sur chaque jour de congé qu'elle couvre", () => {
    const weekly = alloc("w", MON, 5, { repeatState: "weekly", repeatEndDate: "2026-05-31" });
    expect(detect(off("2026-04-20"), [weekly]).days[0]?.allocations).toEqual([{ allocationId: "w", hours: 5 }]);
  });
});

// @BR-04
describe("proposition de report assisté", () => {
  const plan = (timeoff: TimeoffInput, allocations: IdentifiedAllocation[], horizonDays?: number) => {
    const conflicts = detect(timeoff, allocations);
    return proposeResolution({ person: tom, timeoff, timeoffs: [], holidays: [], allocations, conflicts: conflicts.days, horizonDays });
  };
  it("report : l'excédent va sur les prochains jours avec de la marge (lundi 6 h -> mardi 2 h + mercredi 4 h)", () => {
    const r = plan(off(MON), [alloc("a1", MON, 6), alloc("b", TUE, 6)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.moves).toEqual([
      { allocationId: "a1", fromDay: MON, toDay: TUE, hours: 2 },
      { allocationId: "a1", fromDay: MON, toDay: WED, hours: 4 },
    ]);
    expect(r[0]!.unplacedHours).toBe(0);
  });
  it("report : le week-end est sauté, plusieurs allocations se répartissent dans l'ordre", () => {
    const r = plan(off("2026-04-17"), [alloc("a1", "2026-04-17", 5), alloc("a2", "2026-04-17", 5)]);
    const moves = r[0]!.moves;
    expect(moves.reduce((s, m) => s + m.hours, 0)).toBe(10);
    expect(moves.every((m) => m.toDay >= "2026-04-20")).toBe(true);
    expect(moves.filter((m) => m.allocationId === "a1").reduce((s, m) => s + m.hours, 0)).toBe(5);
  });
  it("report : heures non placées quand l'horizon est trop court", () => {
    const r = plan(off(MON), [alloc("a1", MON, 6), alloc("b", TUE, 6)], 1);
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: TUE, hours: 2 }]);
    expect(r[0]!.unplacedHours).toBe(4);
  });
  it("réduction : charge ramenée à la capacité restante, au quart d'heure inférieur", () => {
    const am = off(MON, MON, { startHalf: "am", endHalf: "am" });
    const r = plan(am, [alloc("a1", MON, 4), alloc("a2", MON, 4)]);
    expect(r[0]!.reduce).toEqual([{ allocationId: "a1", fromHours: 4, toHours: 2 }, { allocationId: "a2", fromHours: 4, toHours: 2 }]);
  });
  it("réduction jusqu'à 0 quand la capacité est nulle ; garder = ne rien appliquer", () => {
    const r = plan(off(MON), [alloc("a1", MON, 3)]);
    expect(r[0]!.reduce).toEqual([{ allocationId: "a1", fromHours: 3, toHours: 0 }]);
  });
  it("pur : les entrées ne sont pas modifiées, aucune sortie ne touche au temps loggé", () => {
    const allocations = Object.freeze([alloc("a1", MON, 6)]) as IdentifiedAllocation[];
    const r = plan(off(MON), allocations);
    expect(JSON.stringify(r)).not.toMatch(/logged/i);
  });
  it("aucun conflit : aucune proposition", () => {
    expect(plan(off(MON), [])).toEqual([]);
  });
});

describe("fenêtre de détection", () => {
  it("fenêtre qui ne recoupe pas le congé : aucun conflit", () => {
    expect(detect(off(MON, TUE), [alloc("a", MON, 8)], [], { from: WED, to: WED })).toEqual({ days: [], requiresAssistant: false });
  });
});
