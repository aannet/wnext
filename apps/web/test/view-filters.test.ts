// Filtres de vue : ET entre critères, OU dans une liste, allocations et congés suivent les personnes gardées, tri par département / rôle.
import { describe, expect, it } from "vitest";
import type { ScheduleResponse } from "@wnext/contracts";
import { activeFilterCount, applyViewFilters, normalizeFilters, sameFilters } from "../src/schedule/view-filters";

const person = (id: string, name: string, over: Partial<ScheduleResponse["people"][number]> = {}) => ({
  id, version: 1, name, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [] as string[], avatarUrl: null, active: true, ...over,
});
const alloc = (id: string, personId: string, projectId: string) => ({ id, version: 1, personId, projectId, startDate: "2026-03-02", endDate: "2026-03-03" }) as ScheduleResponse["allocations"][number];
const off = (id: string, personId: string) => ({ id, personId }) as ScheduleResponse["timeoffs"][number];

const data = {
  window: { from: "2026-03-01", to: "2026-03-31" },
  people: [
    person("1", "Alice", { departmentId: "d1", roleId: "r2", tags: ["front"] }),
    person("2", "Bob", { departmentId: "d2", roleId: "r1", tags: ["back", "lead"] }),
    person("3", "Chloé", { departmentId: "d1", roleId: "r1" }),
    person("4", "Dan"),
  ],
  allocations: [alloc("a1", "1", "p1"), alloc("a2", "2", "p2"), alloc("a3", "3", "p1"), alloc("a4", "3", "p2")],
  timeoffs: [off("t1", "1"), off("t2", "4")],
  departments: [{ id: "d1", version: 1, name: "Produit" }, { id: "d2", version: 1, name: "Design" }],
  roles: [{ id: "r1", version: 1, name: "Senior" }, { id: "r2", version: 1, name: "Junior" }],
  projects: [], holidays: [], timeoffTypes: [],
} as unknown as ScheduleResponse;
const ids = (d: ScheduleResponse) => d.people.map((p) => p.id);

describe("applyViewFilters", () => {
  it("sans filtre (ou listes vides) : les mêmes données, par référence", () => {
    expect(applyViewFilters(data, {})).toBe(data);
    expect(applyViewFilters(data, { departmentIds: [], tags: [], zoom: "week" })).toBe(data);
  });

  it("OU dans une liste, ET entre critères", () => {
    expect(ids(applyViewFilters(data, { departmentIds: ["d1"] }))).toEqual(["1", "3"]);
    expect(ids(applyViewFilters(data, { departmentIds: ["d1", "d2"] }))).toEqual(["1", "2", "3"]);
    expect(ids(applyViewFilters(data, { departmentIds: ["d1"], roleIds: ["r1"] }))).toEqual(["3"]);
    expect(ids(applyViewFilters(data, { roleIds: ["r1"], personIds: ["2", "4"] }))).toEqual(["2"]);
    expect(ids(applyViewFilters(data, { tags: ["lead", "front"] }))).toEqual(["1", "2"]);
  });

  it("projet : les personnes allouées à ce projet dans les données chargées", () => {
    expect(ids(applyViewFilters(data, { projectIds: ["p1"] }))).toEqual(["1", "3"]);
    expect(ids(applyViewFilters(data, { projectIds: ["p1", "p2"], departmentIds: ["d2"] }))).toEqual(["2"]);
    expect(ids(applyViewFilters(data, { projectIds: ["inconnu"] }))).toEqual([]);
  });

  it("allocations et congés des personnes écartées sont retirés, ceux des gardées restent entiers (autres projets compris)", () => {
    const r = applyViewFilters(data, { projectIds: ["p1"] });
    expect(r.allocations.map((a) => a.id)).toEqual(["a1", "a3", "a4"]);
    expect(r.timeoffs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("tri par département ou rôle : par nom, sans valeur en dernier, stable (ordre par nom conservé à égalité)", () => {
    expect(ids(applyViewFilters(data, { peopleSort: "department" }))).toEqual(["2", "1", "3", "4"]);
    expect(ids(applyViewFilters(data, { peopleSort: "role" }))).toEqual(["1", "2", "3", "4"]); // Junior, Senior, Senior, sans rôle
    expect(ids(applyViewFilters(data, { peopleSort: "name" }))).toEqual(["1", "2", "3", "4"]);
  });
});

describe("normalizeFilters, sameFilters, activeFilterCount", () => {
  it("forme canonique : listes vides retirées, doublons et ordre ignorés, tri « name » implicite", () => {
    expect(normalizeFilters({ departmentIds: ["b", "a", "a"], roleIds: [], peopleSort: "name", zoom: "day" })).toEqual({ departmentIds: ["a", "b"], zoom: "day" });
    expect(sameFilters({ personIds: ["2", "1"] }, { personIds: ["1", "2"], tags: [] })).toBe(true);
    expect(sameFilters({ personIds: ["1"] }, { personIds: ["1"], zoom: "week" })).toBe(false);
  });
  it("compte les critères de filtrage actifs, pas le zoom ni le tri", () => {
    expect(activeFilterCount({ departmentIds: ["a"], projectIds: [], zoom: "week", peopleSort: "role" })).toBe(1);
    expect(activeFilterCount({})).toBe(0);
  });
});
