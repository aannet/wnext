// Parité avec tests/sql/schema_tests.sql T05..T07 : daily_capacity() en SQL et dailyCapacity() en TS
// doivent rendre les mêmes nombres sur les mêmes cas. Index 0 de work_days_hours = lundi (ADR-001).
import { describe, expect, it } from "vitest";
import {
  dailyCapacity,
  type CapacityInput,
  type HolidayInput,
  type PersonInput,
  type TimeoffInput,
} from "../src/capacity";

const WEEK = [8, 8, 8, 8, 8, 0, 0];

const person = (id: string, over: Partial<PersonInput> = {}): PersonInput => ({
  id,
  active: true,
  workDaysHours: WEEK,
  country: null,
  departmentId: null,
  ...over,
});

const timeoff = (personId: string, startDate: string, endDate = startDate, over: Partial<TimeoffInput> = {}): TimeoffInput => ({
  personId,
  startDate,
  endDate,
  scope: "full_day",
  startHalf: "am",
  endHalf: "pm",
  hoursPerDay: null,
  deducted: true,
  approvalStatus: "pending",
  ...over,
});

const holiday = (hdate: string, over: Partial<HolidayInput> = {}): HolidayInput => ({
  hdate,
  country: null,
  departmentId: null,
  hoursOff: null,
  ...over,
});

const cap = (input: Partial<CapacityInput>, personId: string, day: string) => {
  const rows = dailyCapacity({ people: [], holidays: [], timeoffs: [], from: day, to: day, ...input });
  return rows.find((r) => r.personId === personId && r.day === day);
};

describe("T05 capacité de base", () => {
  it("rend une ligne par jour, même non ouvré", () => {
    const rows = dailyCapacity({ people: [person("alice")], holidays: [], timeoffs: [], from: "2026-03-02", to: "2026-03-08" });
    expect(rows).toHaveLength(7);
  });
  it("lundi = 8 h, samedi = 0 h (index 0 = lundi, dimanche = index 6)", () => {
    const people = [person("alice")];
    expect(cap({ people }, "alice", "2026-03-02")?.capacityHours).toBe(8);
    expect(cap({ people }, "alice", "2026-03-07")?.capacityHours).toBe(0);
    expect(cap({ people }, "alice", "2026-03-08")?.capacityHours).toBe(0);
  });
  it("horaire asymétrique", () => {
    const people = [person("bob", { workDaysHours: [0, 4, 4, 4, 4, 0, 0] })];
    expect(cap({ people }, "bob", "2026-03-03")?.capacityHours).toBe(4);
    expect(cap({ people }, "bob", "2026-03-02")?.capacityHours).toBe(0);
  });
  it("exclut les personnes inactives", () => {
    const people = [person("old", { active: false })];
    expect(cap({ people }, "old", "2026-03-02")).toBeUndefined();
  });
  it("refuse une plage > 400 jours ou inversée (code stable)", () => {
    const base = { people: [], holidays: [], timeoffs: [] };
    expect(() => dailyCapacity({ ...base, from: "2026-01-01", to: "2027-06-01" })).toThrow(/INVALID_RANGE/);
    expect(() => dailyCapacity({ ...base, from: "2026-03-09", to: "2026-03-02" })).toThrow(/INVALID_RANGE/);
    expect(() => dailyCapacity({ ...base, from: "2026-01-01", to: "2027-02-05" })).not.toThrow(); // 400 jours
  });
});

// @BR-02 @BR-30
describe("T06 jours fériés", () => {
  const people = [
    person("fr", { country: "FR", departmentId: "design" }),
    person("fr2", { country: "FR" }),
    person("de", { country: "DE" }),
    person("nc"),
  ];
  const c = (holidays: HolidayInput[], p: string, day: string) => cap({ people, holidays }, p, day);

  it("férié global : tout le monde à 0, ligne conservée", () => {
    const h = [holiday("2026-04-06")];
    for (const p of ["fr", "nc", "de"]) expect(c(h, p, "2026-04-06")?.capacityHours).toBe(0);
  });
  it("férié par pays", () => {
    const h = [holiday("2026-04-07", { country: "FR" })];
    expect(c(h, "fr", "2026-04-07")?.capacityHours).toBe(0);
    expect(c(h, "fr2", "2026-04-07")?.capacityHours).toBe(0);
    expect(c(h, "de", "2026-04-07")?.capacityHours).toBe(8);
    expect(c(h, "nc", "2026-04-07")?.capacityHours).toBe(8);
  });
  it("férié par département", () => {
    const h = [holiday("2026-04-08", { departmentId: "design" })];
    expect(c(h, "fr", "2026-04-08")?.capacityHours).toBe(0);
    expect(c(h, "fr2", "2026-04-08")?.capacityHours).toBe(8);
  });
  it("demi-journée chômée (hours_off)", () => {
    const h = [holiday("2026-04-09", { country: "DE", hoursOff: 3 })];
    expect(c(h, "de", "2026-04-09")?.capacityHours).toBe(5);
    expect(c(h, "fr", "2026-04-09")?.capacityHours).toBe(8);
  });
  it("plusieurs fériés le même jour : le plus grand l'emporte, plafonné à l'horaire du jour", () => {
    const h = [holiday("2026-04-09", { hoursOff: 2 }), holiday("2026-04-09", { country: "DE", hoursOff: 3 })];
    expect(c(h, "de", "2026-04-09")?.holidayHours).toBe(3);
    expect(c([holiday("2026-04-09", { hoursOff: 20 })], "de", "2026-04-09")?.holidayHours).toBe(8);
  });
});

// @BR-04 @BR-05
describe("T07 congés", () => {
  const people = [person("tom"), person("tom2")];
  const c = (timeoffs: TimeoffInput[], p: string, day: string, holidays: HolidayInput[] = []) =>
    cap({ people, timeoffs, holidays }, p, day);

  it("congé pleine journée en attente : capacité 0, sans effet sur un coéquipier", () => {
    const t = [timeoff("tom", "2026-04-13", "2026-04-14")];
    expect(c(t, "tom", "2026-04-13")?.capacityHours).toBe(0);
    expect(c(t, "tom", "2026-04-14")?.capacityHours).toBe(0);
    expect(c(t, "tom2", "2026-04-13")?.capacityHours).toBe(8);
  });
  it("congé refusé : capacité inchangée", () => {
    expect(c([timeoff("tom", "2026-04-15", "2026-04-15", { approvalStatus: "declined" })], "tom", "2026-04-15")?.capacityHours).toBe(8);
  });
  it("congés partiels cumulés (2 h + 3 h) : capacité 3 h", () => {
    const p = { scope: "partial" as const };
    const t = [timeoff("tom", "2026-04-16", "2026-04-16", { ...p, hoursPerDay: 2 }), timeoff("tom", "2026-04-16", "2026-04-16", { ...p, hoursPerDay: 3 })];
    expect(c(t, "tom", "2026-04-16")?.capacityHours).toBe(3);
  });
  it("congés partiels > horaire du jour : plafonné à 8", () => {
    const p = { scope: "partial" as const, hoursPerDay: 6 };
    const t = [timeoff("tom", "2026-04-17", "2026-04-17", p), timeoff("tom", "2026-04-17", "2026-04-17", p)];
    const r = c(t, "tom", "2026-04-17");
    expect(r?.capacityHours).toBe(0);
    expect(r?.timeoffHours).toBe(8);
  });
  it("congé sur week-end : aucun effet", () => {
    expect(c([timeoff("tom", "2026-04-18", "2026-04-19")], "tom", "2026-04-18")?.timeoffHours).toBe(0);
  });
  it("type non déduit : capacité inchangée", () => {
    const t = [timeoff("tom", "2026-04-20", "2026-04-20", { scope: "partial", hoursPerDay: 4, deducted: false })];
    expect(c(t, "tom", "2026-04-20")?.capacityHours).toBe(8);
  });
  it("férié prioritaire : pas de double déduction", () => {
    const r = c([timeoff("tom", "2026-04-21")], "tom", "2026-04-21", [holiday("2026-04-21")]);
    expect(r).toMatchObject({ capacityHours: 0, holidayHours: 8, timeoffHours: 0 });
  });
  it("demi-journées : matin, après-midi, et multi-jours pm -> am", () => {
    const am = timeoff("tom", "2026-05-04", "2026-05-04", { startHalf: "am", endHalf: "am" });
    const pm = timeoff("tom", "2026-05-04", "2026-05-04", { startHalf: "pm", endHalf: "pm" });
    expect(c([am], "tom", "2026-05-04")?.capacityHours).toBe(4);
    expect(c([am, pm], "tom", "2026-05-04")?.capacityHours).toBe(0);
    const span = [timeoff("tom", "2026-05-11", "2026-05-13", { startHalf: "pm", endHalf: "am" })];
    expect(c(span, "tom", "2026-05-11")?.capacityHours).toBe(4);
    expect(c(span, "tom", "2026-05-12")?.capacityHours).toBe(0);
    expect(c(span, "tom", "2026-05-13")?.capacityHours).toBe(4);
  });
});
