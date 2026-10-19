// Parité avec tests/sql/schema_tests.sql T01..T04 : daily_planned_load() <-> dailyPlannedLoad().
import { describe, expect, it } from "vitest";
import { dailyPlannedLoad, type AllocationInput, type LoadInput, type LoadPersonInput } from "../src/load";

const WEEK = [8, 8, 8, 8, 8, 0, 0];

const person = (id: string, workDaysHours: readonly number[] = WEEK): LoadPersonInput => ({ id, workDaysHours });

const alloc = (personId: string, startDate: string, endDate: string, v: number, over: Partial<AllocationInput> = {}): AllocationInput => ({
  personId,
  startDate,
  endDate,
  mode: "hours",
  hoursPerDay: v,
  percent: null,
  status: "confirmed",
  billable: true,
  repeatState: "none",
  repeatEndDate: null,
  projectTentative: false,
  projectNonBillable: false,
  phaseNonBillable: false,
  taskBillable: null,
  ...over,
});

const pct = (personId: string, startDate: string, endDate: string, p: number, over: Partial<AllocationInput> = {}) =>
  alloc(personId, startDate, endDate, 0, { mode: "percentage", hoursPerDay: null, percent: p, ...over });

const run = (people: LoadPersonInput[], allocations: AllocationInput[], from: string, to: string, p: string) => {
  const rows = dailyPlannedLoad({ people, allocations, from, to } satisfies LoadInput).filter((r) => r.personId === p);
  return { rows, days: rows.length, load: rows.reduce((s, r) => s + r.plannedHours, 0) };
};

// @BR-01
describe("T01 allocation multi-jours", () => {
  const people = [person("alice"), person("alice2")];
  const allocations = [alloc("alice", "2026-03-02", "2026-03-06", 6), alloc("alice2", "2026-03-04", "2026-03-10", 4)];
  it("lun-ven x 6 h = 30 h sur 5 jours, rien hors du bloc", () => {
    expect(run(people, allocations, "2026-03-02", "2026-03-08", "alice")).toMatchObject({ load: 30, days: 5 });
    expect(run(people, allocations, "2026-03-09", "2026-03-31", "alice").days).toBe(0);
  });
  it("bloc à cheval sur un week-end : jours non ouvrés ignorés", () => {
    expect(run(people, allocations, "2026-03-01", "2026-03-31", "alice2").load).toBe(20);
    expect(run(people, allocations, "2026-03-07", "2026-03-08", "alice2").days).toBe(0);
  });
  it("fenêtre partielle : clamp de from/to", () => {
    expect(run(people, allocations, "2026-03-05", "2026-03-09", "alice2").load).toBe(12);
  });
  it("refuse une plage invalide ou > 400 jours", () => {
    expect(() => run(people, allocations, "2026-03-09", "2026-03-02", "alice")).toThrow(/INVALID_RANGE/);
    expect(() => run(people, allocations, "2026-01-01", "2027-06-01", "alice")).toThrow(/INVALID_RANGE/);
  });
});

// @BR-01
describe("T02 pourcentage et horaire asymétrique (base brute)", () => {
  it("50 % de mar/mer/jeu à 4 h = 6 h sur 3 jours, lundi/vendredi sans charge", () => {
    const people = [person("bob", [0, 4, 4, 4, 0, 0, 0])];
    expect(run(people, [pct("bob", "2026-03-02", "2026-03-06", 50)], "2026-03-02", "2026-03-08", "bob")).toMatchObject({ load: 6, days: 3 });
  });
  it("150 % accepté", () => {
    expect(run([person("bob2")], [pct("bob2", "2026-03-09", "2026-03-09", 150)], "2026-03-09", "2026-03-09", "bob2").load).toBe(12);
  });
});

// @BR-25
describe("T03 répétitions", () => {
  it("hebdo lun-mar jusqu'au 29/03 : 4 semaines x 2 jours x 5 h", () => {
    const a = [alloc("carol", "2026-03-02", "2026-03-03", 5, { repeatState: "weekly", repeatEndDate: "2026-03-29" })];
    const r = (f: string, t: string) => run([person("carol")], a, f, t, "carol");
    expect(r("2026-03-01", "2026-04-30")).toMatchObject({ days: 8, load: 40 });
    expect(r("2026-03-04", "2026-03-04").load).toBe(0);
    expect(r("2026-03-09", "2026-03-09").load).toBe(5);
    expect(r("2026-03-24", "2026-03-24").load).toBe(5);
    expect(r("2026-03-30", "2026-04-30").days).toBe(0);
  });
  it("quotidien jusqu'au 13/03 : 10 jours ouvrés, week-end sauté", () => {
    const a = [alloc("dave", "2026-03-02", "2026-03-02", 3, { repeatState: "daily", repeatEndDate: "2026-03-13" })];
    expect(run([person("dave")], a, "2026-03-01", "2026-03-31", "dave").days).toBe(10);
    expect(run([person("dave")], a, "2026-03-07", "2026-03-08", "dave").days).toBe(0);
  });
  it("mensuel le 31 : clamp en fin de mois, calcul depuis la date d'origine", () => {
    const sam = person("sam", [8, 8, 8, 8, 8, 8, 8]);
    const a = [alloc("sam", "2026-01-31", "2026-01-31", 2, { repeatState: "monthly", repeatEndDate: "2026-05-31" })];
    const r = (f: string, t: string) => run([sam], a, f, t, "sam");
    expect(r("2026-01-01", "2026-06-30").days).toBe(5);
    expect(r("2026-02-28", "2026-02-28").load).toBe(2);
    expect(r("2026-03-03", "2026-03-03").load).toBe(0);
    expect(r("2026-03-31", "2026-03-31").load).toBe(2);
    expect(r("2026-04-30", "2026-04-30").load).toBe(2);
  });
});

// @BR-07 @BR-13 @BR-20 @BR-21
describe("T04 tentatif et facturable", () => {
  const d = "2026-03-09";
  const allocations = [
    alloc("erin", d, d, 4), // confirmé facturable
    alloc("erin", d, d, 3, { projectTentative: true }),
    alloc("erin", d, d, 2, { status: "tentative" }),
    alloc("erin", d, d, 1, { projectNonBillable: true }),
    alloc("erin", d, d, 1, { billable: false }),
    alloc("erin", "2026-03-10", "2026-03-10", 5, { phaseNonBillable: true }),
    alloc("erin", "2026-03-10", "2026-03-10", 2, { taskBillable: false }),
  ];
  const row = (day: string) => run([person("erin")], allocations, day, day, "erin").rows[0]!;
  it("planifié total (chevauchements autorisés) = 11", () => expect(row(d).plannedHours).toBe(11));
  it("tentatif = projet tentatif + allocation tentative = 5", () => expect(row(d).tentativeHours).toBe(5));
  it("facturable = seulement confirmé facturable = 4", () => expect(row(d).billableHours).toBe(4));
  it("phase ou tâche non facturable : planifié 7, facturable 0", () => {
    const r = row("2026-03-10");
    expect(r.plannedHours - r.billableHours).toBe(7);
  });
});

describe("entrées hors périmètre", () => {
  it("allocation à 0 h : aucune ligne (rien à planifier)", () => {
    expect(dailyPlannedLoad({ people: [person("alice")], allocations: [alloc("alice", "2026-03-02", "2026-03-06", 0)], from: "2026-03-02", to: "2026-03-08" })).toEqual([]);
  });

  it("allocation d'une personne absente de la liste : ignorée", () => {
    expect(dailyPlannedLoad({ people: [person("alice")], allocations: [alloc("fantome", "2026-03-02", "2026-03-06", 6)], from: "2026-03-02", to: "2026-03-08" })).toEqual([]);
  });

  it("lignes triées par personne puis par jour, quel que soit l'ordre des allocations", () => {
    const rows = dailyPlannedLoad({
      people: [person("b"), person("a")],
      allocations: [alloc("b", "2026-03-03", "2026-03-03", 1), alloc("a", "2026-03-03", "2026-03-03", 1), alloc("a", "2026-03-02", "2026-03-02", 1)],
      from: "2026-03-02", to: "2026-03-08",
    });
    expect(rows.map((r) => `${r.personId}|${r.day}`)).toEqual(["a|2026-03-02", "a|2026-03-03", "b|2026-03-03"]);
  });
});
