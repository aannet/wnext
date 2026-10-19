// BR-04 : cas limites de la détection de conflits et de la proposition de report / réduction. Complète timeoff-conflicts.test.ts.
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
const AM = { startHalf: "am", endHalf: "am" } as const;

const MON = "2026-04-13", TUE = "2026-04-14", WED = "2026-04-15", THU = "2026-04-16";

interface Extra { holidays?: HolidayInput[]; timeoffs?: TimeoffInput[]; from?: string; to?: string; person?: PersonInput }
const detect = (timeoff: TimeoffInput, allocations: IdentifiedAllocation[], logged: LoggedTimeInput[] = [], x: Extra = {}) =>
  detectTimeoffConflicts({ person: x.person ?? tom, timeoff, timeoffs: x.timeoffs ?? [], holidays: x.holidays ?? [], allocations, logged, from: x.from, to: x.to });

// @BR-04
describe("détection : fenêtre", () => {
  it("la fenêtre demandée est bornée par le congé des deux côtés", () => {
    const a = [alloc("a1", MON, 2), alloc("a2", TUE, 2), alloc("a3", WED, 2), alloc("a4", THU, 2)];
    expect(detect(off(TUE, WED), a, [], { from: MON, to: THU }).days.map((d) => d.day)).toEqual([TUE, WED]);
    expect(detect(off(TUE, WED), a, [], { from: WED }).days.map((d) => d.day)).toEqual([WED]);
    expect(detect(off(TUE, WED), a, [], { to: TUE }).days.map((d) => d.day)).toEqual([TUE]);
  });
  it("fenêtre d'un seul jour égal au dernier ou au premier jour du congé", () => {
    const a = [alloc("a1", TUE, 2), alloc("a2", WED, 2)];
    expect(detect(off(TUE, WED), a, [], { from: WED, to: WED }).days.map((d) => d.day)).toEqual([WED]);
    expect(detect(off(TUE, WED), a, [], { from: TUE, to: TUE }).days.map((d) => d.day)).toEqual([TUE]);
  });
  it("fenêtre entièrement avant le congé : aucun conflit", () => {
    expect(detect(off(WED), [alloc("a1", WED, 2)], [], { from: MON, to: TUE })).toEqual({ days: [], requiresAssistant: false });
  });
});

// @BR-04
describe("détection : critères d'un jour en conflit", () => {
  it("charge exactement égale à la capacité restante : pas de conflit ; au-dessus : conflit", () => {
    expect(detect(off(MON, MON, AM), [alloc("a", MON, 4)]).days).toEqual([]);
    expect(detect(off(MON, MON, AM), [alloc("a", MON, 4.25)]).days).toMatchObject([{ plannedHours: 4.25, overtimeHours: 0.25 }]);
  });
  it("temps loggé : conflit seulement si la capacité restante est nulle", () => {
    const logged = [{ personId: "tom", day: MON, hours: 3 }];
    expect(detect(off(MON, MON, AM), [], logged).days).toEqual([]); // il reste 4 h de capacité
    expect(detect(off(MON), [], logged).days).toMatchObject([{ loggedHours: 3, plannedHours: 0, overtimeHours: 0, capacityHours: 0 }]);
  });
  it("temps loggé à 0 h : ignoré", () => {
    expect(detect(off(MON), [], [{ personId: "tom", day: MON, hours: 0 }]).days).toEqual([]);
  });
  it("temps loggé : cumulé sur la journée, ignoré les autres jours", () => {
    const logged = [
      { personId: "tom", day: MON, hours: 1 }, { personId: "tom", day: MON, hours: 2.5 }, { personId: "tom", day: TUE, hours: 9 },
    ];
    const r = detect(off(MON, TUE), [], logged);
    expect(r.days.map((d) => [d.day, d.loggedHours])).toEqual([[MON, 3.5], [TUE, 9]]);
  });
  it("heures planifiées d'un jour : somme des allocations, celles qui ne couvrent pas le jour sont absentes", () => {
    const r = detect(off(MON, TUE), [alloc("a", MON, 2), alloc("b", MON, 3), alloc("c", TUE, 1), alloc("d", WED, 5)]);
    expect(r.days).toMatchObject([
      { day: MON, plannedHours: 5, overtimeHours: 5, allocations: [{ allocationId: "a", hours: 2 }, { allocationId: "b", hours: 3 }] },
      { day: TUE, plannedHours: 1, overtimeHours: 1, allocations: [{ allocationId: "c", hours: 1 }] },
    ]);
  });
  it("allocation de 0 h : n'est pas un conflit et n'est pas listée", () => {
    expect(detect(off(MON), [alloc("z", MON, 0)]).days).toEqual([]);
  });
  it("chaque jour porte sa capacité restante et ses heures de congé (demi-journée : 4 h / 4 h)", () => {
    expect(detect(off(MON, MON, AM), [alloc("a", MON, 6)]).days[0]).toMatchObject({ capacityHours: 4, timeoffHours: 4 });
  });
  it("un autre congé déduit déjà posé le même jour : le nouveau ne retire rien, pas de conflit à son nom", () => {
    const already = off(MON);
    expect(detect(off(MON), [alloc("a", MON, 4)], [], { timeoffs: [already] }).days).toEqual([]);
  });
  it("un autre congé sur un autre jour ne masque pas le conflit ; sa demi-journée se cumule avec celle-ci", () => {
    expect(detect(off(MON), [alloc("a", MON, 4)], [], { timeoffs: [off(TUE)] }).days).toHaveLength(1);
    const r = detect(off(MON, MON, { startHalf: "pm", endHalf: "pm" }), [alloc("a", MON, 3)], [], { timeoffs: [off(MON, MON, AM)] });
    expect(r.days[0]).toMatchObject({ capacityHours: 0, timeoffHours: 8, plannedHours: 3 }); // le matin déjà pris + l'après-midi
  });
  it("congés d'une autre personne : ignorés", () => {
    const theirs = { ...off(MON), personId: "tom2" };
    expect(detect(off(MON), [alloc("a", MON, 4)], [], { timeoffs: [theirs] }).days).toHaveLength(1);
  });
  it("férié partiel ou férié du bon pays : la capacité restante en tient compte", () => {
    const holidays: HolidayInput[] = [{ hdate: MON, country: null, departmentId: null, hoursOff: 4 }];
    const r = detect(off(MON), [alloc("a", MON, 4)], [], { holidays });
    expect(r.days).toMatchObject([{ capacityHours: 0, timeoffHours: 4, plannedHours: 4 }]); // 4 h fériées + 4 h de congé
  });
  it("congé de type non déduit : jamais un conflit, même avec du temps loggé", () => {
    expect(detect(off(MON, MON, { deducted: false }), [alloc("a", MON, 4)], [{ personId: "tom", day: MON, hours: 2 }]).days).toEqual([]);
  });
  it("BR-29 : requiresAssistant faux sans conflit, même approuvé", () => {
    expect(detect(off(MON), []).requiresAssistant).toBe(false);
  });
  it("congé refusé ou partiel : retour vide complet", () => {
    const a = [alloc("a", MON, 4)];
    expect(detect(off(MON, MON, { approvalStatus: "declined" }), a)).toEqual({ days: [], requiresAssistant: false });
    expect(detect(off(MON, MON, { scope: "partial", hoursPerDay: 2 }), a)).toEqual({ days: [], requiresAssistant: false });
  });
});

// @BR-04
describe("proposition : réduction", () => {
  const plan = (timeoff: TimeoffInput, allocations: IdentifiedAllocation[], x: Extra & { horizonDays?: number } = {}) => {
    const conflicts = detect(timeoff, allocations, [], x);
    return proposeResolution({ person: x.person ?? tom, timeoff, timeoffs: x.timeoffs ?? [], holidays: x.holidays ?? [], allocations, conflicts: conflicts.days, horizonDays: x.horizonDays });
  };

  it("réduction proportionnelle arrondie au quart d'heure inférieur (jamais au-dessus de la capacité)", () => {
    // capacité restante 4 h pour 6 h planifiées : facteur 2/3 -> 5 h = 3,333 -> 3,25 ; 1 h = 0,667 -> 0,5
    const r = plan(off(MON, MON, AM), [alloc("a1", MON, 5), alloc("a2", MON, 1)]);
    expect(r[0]!.reduce).toEqual([{ allocationId: "a1", fromHours: 5, toHours: 3.25 }, { allocationId: "a2", fromHours: 1, toHours: 0.5 }]);
    expect(r[0]!.reduce.reduce((s, x) => s + x.toHours, 0)).toBeLessThanOrEqual(4);
  });
  it("une allocation que la réduction ne change pas n'est pas listée", () => {
    // 4,25 h pour 4 h de capacité : la petite allocation tombe à 0, la grande à 3,75 h
    const r = plan(off(MON, MON, AM), [alloc("a1", MON, 4.25), alloc("a2", MON, 0.25)]);
    expect(r[0]!.reduce.map((x) => x.allocationId)).toEqual(["a1", "a2"]);
    expect(r[0]!.reduce[1]).toEqual({ allocationId: "a2", fromHours: 0.25, toHours: 0 }); // 0,22 h arrondi au quart inférieur
  });
  it("conflit sur du temps loggé seul : rien à réduire ni à reporter", () => {
    const timeoff = off(MON);
    const conflicts = detect(timeoff, [], [{ personId: "tom", day: MON, hours: 2 }]).days;
    expect(proposeResolution({ person: tom, timeoff, timeoffs: [], holidays: [], allocations: [], conflicts })).toEqual([
      { day: MON, reduce: [], moves: [], unplacedHours: 0 },
    ]);
  });
  it("une résolution par jour en conflit, dans l'ordre, avec le bon jour", () => {
    const r = plan(off(MON, TUE), [alloc("a", MON, 2), alloc("b", TUE, 3)]);
    expect(r.map((x) => x.day)).toEqual([MON, TUE]);
    expect(r.map((x) => x.reduce[0]!.fromHours)).toEqual([2, 3]);
  });
});

// @BR-04
describe("proposition : report", () => {
  const plan = (timeoff: TimeoffInput, allocations: IdentifiedAllocation[], x: Extra & { horizonDays?: number } = {}) => {
    const conflicts = detect(timeoff, allocations, [], x);
    return proposeResolution({ person: x.person ?? tom, timeoff, timeoffs: x.timeoffs ?? [], holidays: x.holidays ?? [], allocations, conflicts: conflicts.days, horizonDays: x.horizonDays });
  };

  it("seul l'excédent est déplacé (demi-journée : 4 h restent, 2 h partent), dans l'ordre des allocations", () => {
    const r = plan(off(MON, MON, AM), [alloc("a1", MON, 3), alloc("a2", MON, 3)]);
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: TUE, hours: 2 }]);
    expect(r[0]!.unplacedHours).toBe(0);
  });
  it("les heures déjà reportées comptent : la 2e allocation ne réutilise pas la marge consommée par la 1re", () => {
    const r = plan(off(MON), [alloc("a1", MON, 6), alloc("a2", MON, 5)]);
    expect(r[0]!.moves).toEqual([
      { allocationId: "a1", fromDay: MON, toDay: TUE, hours: 6 },
      { allocationId: "a2", fromDay: MON, toDay: TUE, hours: 2 },
      { allocationId: "a2", fromDay: MON, toDay: WED, hours: 3 },
    ]);
  });
  it("jour d'arrivée déjà chargé : seule la marge restante est utilisée", () => {
    const r = plan(off(MON), [alloc("a1", MON, 3), alloc("b", TUE, 5)]);
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: TUE, hours: 3 }]);
    const r2 = plan(off(MON), [alloc("a1", MON, 4), alloc("b", TUE, 6)]);
    expect(r2[0]!.moves).toEqual([
      { allocationId: "a1", fromDay: MON, toDay: TUE, hours: 2 },
      { allocationId: "a1", fromDay: MON, toDay: WED, hours: 2 },
    ]);
  });
  it("les allocations d'une autre personne ne réduisent pas la marge", () => {
    const r = plan(off(MON), [alloc("a1", MON, 4), alloc("x", TUE, 8, { personId: "tom2" })]);
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: TUE, hours: 4 }]);
  });
  it("jour férié et congé déjà posé sur le chemin : sautés", () => {
    const holidays: HolidayInput[] = [{ hdate: TUE, country: null, departmentId: null, hoursOff: null }];
    const r = plan(off(MON), [alloc("a1", MON, 4)], { holidays, timeoffs: [off(WED)] });
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: THU, hours: 4 }]);
  });
  it("horizon : la borne est incluse, le jour suivant exclu", () => {
    const allocs = [alloc("a1", MON, 6), alloc("b", TUE, 6)];
    const two = plan(off(MON), allocs, { horizonDays: 2 });
    expect(two[0]!.moves).toEqual([
      { allocationId: "a1", fromDay: MON, toDay: TUE, hours: 2 },
      { allocationId: "a1", fromDay: MON, toDay: WED, hours: 4 },
    ]);
    expect(two[0]!.unplacedHours).toBe(0);
    const zero = plan(off(MON), allocs, { horizonDays: 0 });
    expect(zero[0]).toMatchObject({ moves: [], unplacedHours: 6 });
  });
  it("horizon par défaut de 60 jours à partir du premier conflit", () => {
    const mondays: PersonInput = { ...tom, workDaysHours: [8, 0, 0, 0, 0, 0, 0] };
    const full = ["2026-04-20", "2026-04-27", "2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"]
      .map((d, i) => alloc(`f${i}`, d, 8));
    // 8 juin = jour 56, 15 juin = jour 63 : le 8 juin est libre et dans l'horizon, le 15 aussi mais hors horizon
    const inside = plan(off(MON), [alloc("a1", MON, 6), ...full], { person: mondays });
    expect(inside[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: "2026-06-08", hours: 6 }]);
    const blocked = plan(off(MON), [alloc("a1", MON, 6), ...full, alloc("f8", "2026-06-08", 8)], { person: mondays });
    expect(blocked[0]).toMatchObject({ moves: [], unplacedHours: 6 });
  });
  it("horizon énorme : plafonné à la plage maximale, sans erreur", () => {
    const r = plan(off(MON), [alloc("a1", MON, 6)], { horizonDays: 100_000 });
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: TUE, hours: 6 }]);
  });
  it("congé de plusieurs jours : l'horizon part du dernier jour en conflit et les reports se cumulent d'un jour à l'autre", () => {
    const r = plan(off(MON, WED), [alloc("a", MON, 8), alloc("b", TUE, 8), alloc("c", WED, 8)], { horizonDays: 1 });
    expect(r.map((x) => x.day)).toEqual([MON, TUE, WED]);
    // la fenêtre se termine jeudi : lundi prend toute la marge de jeudi, mardi et mercredi n'ont plus rien
    expect(r[0]!.moves).toEqual([{ allocationId: "a", fromDay: MON, toDay: THU, hours: 8 }]);
    expect(r[1]).toMatchObject({ moves: [], unplacedHours: 8 });
    expect(r[2]).toMatchObject({ moves: [], unplacedHours: 8 });
  });
  it("heures non placées : une allocation partiellement placée garde son reste dans unplacedHours", () => {
    const r = plan(off(MON), [alloc("a1", MON, 6), alloc("b", TUE, 7)], { horizonDays: 1 });
    expect(r[0]!.moves).toEqual([{ allocationId: "a1", fromDay: MON, toDay: TUE, hours: 1 }]);
    expect(r[0]!.unplacedHours).toBe(5);
  });
  it("une allocation non reportable n'empêche pas la suivante de l'être", () => {
    const r = plan(off(MON), [alloc("a1", MON, 4), alloc("a2", MON, 4), alloc("b", TUE, 8)], { horizonDays: 1 });
    expect(r[0]).toMatchObject({ moves: [], unplacedHours: 8 });
  });
});
