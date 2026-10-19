// Modèle de la grille du Schedule (ADR-005 : DOM A2) : lignes à hauteur variable, blocs en pixels, séries développées.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { buildGrid, visibleRows, ROW_UNIT_PX } from "../src/schedule/grid-model";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string, name = `P${id}`) => ({
  id, version: 1, name, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, over: Partial<Alloc> = {}): Alloc => ({
  id, version: 1, personId: "1", projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-03-02", endDate: "2026-03-04", status: "confirmed", billable: true, priority: 0,
  repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 4, percent: null, ...over,
} as Alloc);
const snap = (people = [person("1")], allocations: Alloc[] = []): ScheduleResponse => ({
  window: { from: "2026-03-02", to: "2026-03-15" }, changeCursor: "0", page: { nextCursor: null, total: people.length },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" }, people, allocations, timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [], roles: [],
});
const range = { from: "2026-03-02", to: "2026-03-15" };

describe("buildGrid", () => {
  it("bloc : x = jours depuis le début × px/jour, largeur = durée, hauteur = part de la journée de référence", () => {
    const g = buildGrid(snap([person("1")], [alloc("100", { startDate: "2026-03-03" })]), range, 40);
    expect(g.widthPx).toBe(14 * 40);
    expect(g.rows[0]!.blocks).toEqual([expect.objectContaining({
      key: "100:0", allocationId: "100", x: 40, w: 80, y: 0, h: ROW_UNIT_PX / 2, color: "#3B82F6", label: "Refonte", tentative: false,
    })]);
  });

  it("série hebdomadaire : une occurrence par semaine dans la fenêtre, clé stable par rang", () => {
    const g = buildGrid(snap([person("1")], [alloc("100", { endDate: "2026-03-02", repeatState: "weekly", repeatEndDate: "2026-12-31" })]), range, 10);
    expect(g.rows[0]!.blocks.map((b) => [b.key, b.x])).toEqual([["100:0", 0], ["100:1", 70]]);
  });

  it("empilement > 100 % : la ligne grandit, débordement signalé ; tops cumulés", () => {
    const over = [alloc("100", { hoursPerDay: 6 }), alloc("101", { hoursPerDay: 6 })];
    const g = buildGrid(snap([person("1"), person("2")], over), range, 10);
    expect(g.rows[0]).toMatchObject({ personId: "1", overflow: true, top: 0, heightPx: 1.5 * ROW_UNIT_PX });
    expect(g.rows[1]).toMatchObject({ personId: "2", overflow: false, top: 1.5 * ROW_UNIT_PX, heightPx: ROW_UNIT_PX });
    expect(g.heightPx).toBe(2.5 * ROW_UNIT_PX);
  });

  it("tentatif et projet inconnu : marqués, jamais d'exception", () => {
    const g = buildGrid(snap([person("1")], [alloc("100", { status: "tentative", projectId: "99" })]), range, 10);
    expect(g.rows[0]!.blocks[0]).toMatchObject({ tentative: true, label: "", color: null });
  });
});

describe("visibleRows", () => {
  it("lignes qui touchent [scrollTop, scrollTop + hauteur], avec une marge", () => {
    const people = Array.from({ length: 300 }, (_, i) => person(String(i + 1)));
    const g = buildGrid(snap(people), range, 10);
    expect(visibleRows(g, 0, ROW_UNIT_PX * 3, 0)).toEqual([0, 1, 2]);
    expect(visibleRows(g, ROW_UNIT_PX * 10 + 1, ROW_UNIT_PX * 2, 1)).toEqual([9, 10, 11, 12, 13]);
    expect(visibleRows(g, ROW_UNIT_PX * 299, ROW_UNIT_PX * 5, 2)).toEqual([297, 298, 299]);
  });
});
