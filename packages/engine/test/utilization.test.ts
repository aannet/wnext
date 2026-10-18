// Parité avec utilization() : surtemps, utilization NULL à capacité 0, is_overbooked jamais masqué (BR-38).
import { describe, expect, it } from "vitest";
import { utilization } from "../src/utilization";
import type { AllocationInput } from "../src/load";
import type { HolidayInput, PersonInput } from "../src/capacity";

const p = (id: string, over: Partial<PersonInput> = {}): PersonInput => ({
  id, active: true, workDaysHours: [8, 8, 8, 8, 8, 0, 0], country: null, departmentId: null, ...over,
});
const a = (personId: string, day: string, hours: number, over: Partial<AllocationInput> = {}): AllocationInput => ({
  personId, startDate: day, endDate: day, mode: "hours", hoursPerDay: hours, percent: null, status: "confirmed",
  billable: true, repeatState: "none", repeatEndDate: null, projectTentative: false, projectNonBillable: false,
  phaseNonBillable: false, taskBillable: null, ...over,
});
const one = (people: PersonInput[], allocations: AllocationInput[], day: string, holidays: HolidayInput[] = []) =>
  utilization({ people, allocations, holidays, timeoffs: [], from: day, to: day }).find((r) => r.day === day && r.personId === people[0]!.id)!;

// @BR-01 @BR-03 @BR-38
describe("utilization", () => {
  it("sous la capacité : ratio, pas de surtemps", () => {
    expect(one([p("x")], [a("x", "2026-03-02", 6)], "2026-03-02")).toMatchObject({
      capacityHours: 8, plannedHours: 6, utilization: 0.75, overtimeHours: 0, isOverbooked: false,
    });
  });
  it("sans allocation : planifié 0 (la ligne de capacité est conservée)", () => {
    expect(one([p("x")], [], "2026-03-02")).toMatchObject({ plannedHours: 0, utilization: 0, isOverbooked: false });
  });
  it("sur-allocation rapportée, jamais bloquée (BR-01)", () => {
    expect(one([p("x")], [a("x", "2026-03-02", 10)], "2026-03-02")).toMatchObject({ overtimeHours: 2, utilization: 1.25, isOverbooked: true });
  });
  it("exactement à la capacité : pas sur-alloué (seuil strict, 100 %)", () => {
    expect(one([p("x")], [a("x", "2026-03-02", 8)], "2026-03-02")).toMatchObject({ utilization: 1, isOverbooked: false });
  });
  it("charge sur un férié : conservée, surtemps = charge, utilization infinie (sur-allocation maximale) et isOverbooked (BR-38)", () => {
    const r = one([p("x")], [a("x", "2026-04-06", 6)], "2026-04-06", [{ hdate: "2026-04-06", country: null, departmentId: null, hoursOff: null }]);
    expect(r).toMatchObject({ capacityHours: 0, plannedHours: 6, overtimeHours: 6, utilization: Infinity, isOverbooked: true });
  });
  it("capacité 0 et charge 0 : utilization 0, jamais null (BR-38)", () => {
    const r = one([p("x")], [], "2026-04-06", [{ hdate: "2026-04-06", country: null, departmentId: null, hoursOff: null }]);
    expect(r).toMatchObject({ capacityHours: 0, plannedHours: 0, utilization: 0, isOverbooked: false });
  });
  it("tentatif inclus dans le planifié, décomposé dans tentativeHours (Q-01)", () => {
    expect(one([p("x")], [a("x", "2026-03-02", 4), a("x", "2026-03-02", 2, { status: "tentative" })], "2026-03-02")).toMatchObject({
      plannedHours: 6, tentativeHours: 2,
    });
  });
  it("personne inactive exclue", () => {
    const rows = utilization({ people: [p("x", { active: false })], allocations: [a("x", "2026-03-02", 4)], holidays: [], timeoffs: [], from: "2026-03-02", to: "2026-03-02" });
    expect(rows).toHaveLength(0);
  });
});
