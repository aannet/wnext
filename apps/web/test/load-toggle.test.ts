// @vitest-environment jsdom
// Bascule « Charge » (RT-052, cadrage n°4 D3, amende Q11) : elle affiche ou masque toute la bande de capacité (graphique et
// chiffres, dépassements compris). Éteinte : aucun .wn-cap, lignes raccourcies de la hauteur de la bande ; la jauge de la
// colonne Personnes reste calculée et affichée.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { DENSITY_METRICS, rowMetrics } from "../src/schedule/density";
import { buildGrid, gaugeOf } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string) => ({
  id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, personId: string, from: string, to: string, hoursPerDay: number): Alloc => ({
  id, version: 1, personId, projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: from, endDate: to, status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay, percent: null,
} as Alloc);
const snap = {
  window: { from: "2026-03-02", to: "2026-03-15" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" },
  people: [person("1"), person("2")],
  allocations: [alloc("a", "1", "2026-03-02", "2026-03-03", 10)],
  timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [], roles: [],
} as unknown as ScheduleResponse;
const range = { from: "2026-03-02", to: "2026-03-15" };

describe("bascule Charge : modèle (RT-052)", () => {
  it("rowMetrics : bande à la hauteur de la densité si la bascule est active, 0 sinon", () => {
    expect(rowMetrics("standard", true)).toEqual(DENSITY_METRICS.standard);
    expect(rowMetrics("standard", false)).toEqual({ rowUnitPx: DENSITY_METRICS.standard.rowUnitPx, capPx: 0 });
  });

  it("bande masquée : aucune cellule, ligne raccourcie de la bande ; la jauge reste calculée (surcharge comprise)", () => {
    const on = buildGrid(snap, range, 96, "day", rowMetrics("compact", true));
    const off = buildGrid(snap, range, 96, "day", rowMetrics("compact", false));
    expect(on.rows[1]!.cells.length).toBeGreaterThan(0);
    expect(off.rows.every((r) => r.cells.length === 0)).toBe(true);
    expect(off.rows[1]!.heightPx).toBe(on.rows[1]!.heightPx - DENSITY_METRICS.compact.capPx);
    const week = { from: "2026-03-02", to: "2026-03-08" };
    expect(gaugeOf(off.rows[0]!, week, off.thresholds)).toEqual(gaugeOf(on.rows[0]!, week, on.thresholds));
    expect(gaugeOf(off.rows[0]!, week, off.thresholds).state).toBe("over");
  });
});

describe("bascule Charge : scroller (RT-052)", () => {
  const setup = (showLoad?: boolean) => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, setTimer: () => 0, clearTimer: () => {}, idle: () => {} };
    const s = createScroller({
      root, data: snap, today: "2026-03-04", widthPx: GUTTER_PX + 7 * 96, heightPx: 400, label: (c) => c.from, clock,
      ...(showLoad === undefined ? {} : { showLoad }),
    });
    const caps = () => [...root.querySelectorAll<HTMLElement>(".wn-cap")].filter((c) => c.style.display !== "none");
    const rowH = () => root.querySelector<HTMLElement>(".wn-row:not([style*='display: none'])")!.style.height;
    return { root, s, caps, rowH };
  };

  it("active par défaut : la bande est dessinée", () => {
    const { s, caps, root } = setup();
    expect(s.showLoad()).toBe(true);
    expect(caps().length).toBeGreaterThan(0);
    s.destroy();
    root.remove();
  });

  it("éteinte : aucun .wn-cap, lignes raccourcies ; rallumée : bande et hauteurs reviennent", () => {
    const { s, caps, rowH, root } = setup();
    const before = parseInt(rowH(), 10);
    s.setShowLoad(false);
    expect(s.showLoad()).toBe(false);
    expect(caps()).toHaveLength(0);
    expect(parseInt(rowH(), 10)).toBe(before - DENSITY_METRICS.compact.capPx);
    expect(root.querySelector(".wn-gauge")!.className).toContain("wn-gauge-over");
    s.setShowLoad(true);
    expect(caps().length).toBeGreaterThan(0);
    expect(parseInt(rowH(), 10)).toBe(before);
    s.destroy();
    root.remove();
  });

  it("option showLoad: false au montage, conservée au changement de densité", () => {
    const { s, caps, rowH, root } = setup(false);
    expect(caps()).toHaveLength(0);
    s.setDensity("airy");
    expect(caps()).toHaveLength(0);
    expect(rowH()).toBe(`${buildGrid(snap, range, 96, "day", rowMetrics("airy", false)).rows[0]!.heightPx}px`);
    s.destroy();
    root.remove();
  });
});
