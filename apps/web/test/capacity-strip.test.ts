// @vitest-environment jsdom
// Bande de capacité du Schedule (BR-01 signalée, BR-07 tentatif distinct) : modèle par tranche, alignement sur les
// colonnes aux trois zooms, recyclage des nœuds, libellés accessibles FR / EN.
import type { ScheduleResponse } from "@wnext/contracts";
import { dayNumber, headerCells, type Zoom } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { demoSchedule } from "../src/demo";
import { createI18n } from "../src/i18n";
import { capacityLabeler } from "../src/schedule/capacity-label";
import { createGridRenderer } from "../src/schedule/grid-dom";
import { buildGrid, CAP_PX, type GridCap } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string) => ({
  id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, day: string, hoursPerDay: number, status: "confirmed" | "tentative" = "confirmed"): Alloc => ({
  id, version: 1, personId: "1", projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: day, endDate: day, status, billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay, percent: null,
} as Alloc);
const snap = (allocations: Alloc[], window = { from: "2026-03-02", to: "2026-03-15" }): ScheduleResponse => ({
  window, changeCursor: "0", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" }, people: [person("1")], allocations, timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [], roles: [],
});
// lundi 2 mars 2026 : 6 h confirmées ; mardi : 6 h + 4 h tentatives (dépassement de 2 h) ; samedi : 4 h sans capacité.
const simple = snap([alloc("1", "2026-03-02", 6), alloc("2", "2026-03-03", 6), alloc("3", "2026-03-03", 4, "tentative"), alloc("4", "2026-03-04", 4)]);
simple.holidays = [{ id: "h1", version: 1, name: "Férié", date: "2026-03-04", country: null, departmentId: null, hoursOff: null }];
const range = { from: "2026-03-02", to: "2026-03-15" };
const cap = (g: ReturnType<typeof buildGrid>, from: string) => g.rows[0]!.cells.find((c) => c.from === from)!;

describe("cellules de capacité du modèle", () => {
  const g = buildGrid(simple, range, 10, "day");

  it("une cellule par jour de la tranche, la ligne gagne la bande en pied", () => {
    expect(g.rows[0]!.cells).toHaveLength(14);
    expect(g.rows[0]!.capY).toBe(g.rows[0]!.heightPx - CAP_PX);
  });

  it("jour simple : confirmé seul, pas de dépassement", () => {
    expect(cap(g, "2026-03-02")).toMatchObject({ state: "ok", plannedHours: 6, capacityHours: 8, tentativeHours: 0, overPx: 0, tentativePx: 0 });
    expect(cap(g, "2026-03-02").confirmedPx).toBe(Math.round((6 / 8) * CAP_PX));
  });

  it("confirmé + tentatif + dépassement : segments distincts et zone de dépassement (signalé, jamais bloqué)", () => {
    const c = cap(g, "2026-03-03");
    expect(c).toMatchObject({ state: "over", plannedHours: 10, capacityHours: 8, tentativeHours: 4, overtimeHours: 2, overbookedDays: 1 });
    expect(c.tentativePx).toBeGreaterThan(0);
    expect(c.confirmedPx).toBeGreaterThan(0);
    expect(c.overPx).toBeGreaterThan(0);
    expect(c.confirmedPx + c.tentativePx).toBeLessThanOrEqual(CAP_PX);
    expect(c.lineY).toBe(c.overPx);
  });

  it("week-end : neutre ; férié (capacité 0) avec une charge : reste visible en surcharge", () => {
    expect(cap(g, "2026-03-08")).toMatchObject({ state: "none", capacityHours: 0, plannedHours: 0, confirmedPx: 0 });
    expect(cap(g, "2026-03-04")).toMatchObject({ state: "over", capacityHours: 0, plannedHours: 4 });
    expect(cap(g, "2026-03-04").overPx).toBeGreaterThan(0);
  });

  it("semaine : un jour en surcharge marque la cellule même si le total hebdomadaire est sous la capacité", () => {
    const w = buildGrid(simple, range, 10, "week");
    expect(w.rows[0]!.cells).toHaveLength(2);
    expect(w.rows[0]!.cells[0]).toMatchObject({ from: "2026-03-02", state: "over", plannedHours: 20, capacityHours: 32, overbookedDays: 2 });
  });

  it("tolère un projet inconnu (jamais d'exception)", () => {
    expect(() => buildGrid(snap([{ ...alloc("9", "2026-03-04", 4), projectId: "99" }]), range, 10)).not.toThrow();
  });
});

describe("alignement sur les colonnes d'en-tête", () => {
  const wide = snap(simple.allocations, { from: "2026-02-01", to: "2026-04-30" });
  const full = { from: "2026-02-01", to: "2026-04-30" };
  for (const [zoom, px] of [["day", 96], ["week", 28], ["month", 8]] as [Zoom, number][]) {
    it(`zoom ${zoom} : x et largeur de chaque cellule = ceux de la colonne de même date`, () => {
      const g = buildGrid(wide, full, px, zoom);
      const cols = headerCells(full, zoom, 1).filter((c) => c.from >= full.from && c.to <= full.to);
      const cells = g.rows[0]!.cells;
      expect(cells.map((c) => c.from)).toEqual(cols.map((c) => c.from));
      for (const [i, c] of cells.entries()) {
        expect(c.x).toBe((dayNumber(cols[i]!.from) - dayNumber(full.from)) * px);
        expect(c.w).toBe((dayNumber(cols[i]!.to) - dayNumber(cols[i]!.from) + 1) * px);
        if (i > 0) expect(c.x).toBe(cells[i - 1]!.x + cells[i - 1]!.w);
      }
    });
  }
});

describe("rendu et recyclage", () => {
  const TODAY = "2026-10-20";
  function manual() {
    const frames: (() => void)[] = [];
    const clock: Partial<Clock> = { raf: (cb) => frames.push(cb), caf: () => {}, now: () => 0, setTimer: () => 0, clearTimer: () => {}, idle: (cb) => cb() };
    return { clock, run: () => { for (const f of frames.splice(0)) f(); } };
  }

  it("défilement continu : le nombre de nœuds de capacité reste constant une fois le pool chaud", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const m = manual();
    const s = createScroller({
      root, data: demoSchedule(TODAY), today: TODAY, widthPx: GUTTER_PX + 960, heightPx: 400, label: (c) => c.from, clock: m.clock,
      capacityLabel: (p, c) => `${p} ${c.plannedHours}`,
    });
    const count = () => root.querySelectorAll(".wn-cap:not([style*='display: none'])").length;
    const scroll = (n: number) => {
      for (let i = 0; i < n; i++) {
        root.scrollLeft += 96 * 3;
        root.dispatchEvent(new Event("scroll"));
        m.run();
      }
    };
    scroll(100); // chauffe du pool (positions variées par rapport au palier de fenêtre)
    const created = s.stats().capsCreated;
    const visible = count();
    expect(created).toBeGreaterThan(0);
    scroll(100);
    expect(s.stats().capsCreated).toBe(created);
    expect(count()).toBeLessThanOrEqual(visible + 12);
    expect(root.querySelector(".wn-cap")?.getAttribute("aria-label")).toMatch(/^\d{4}-\d{2}-\d{2} /);
    s.destroy();
  });

  const cell = (over: Partial<GridCap> = {}): GridCap => ({
    from: "2026-03-03", to: "2026-03-03", kind: "day", x: 0, w: 96, state: "over", confirmedPx: 6, tentativePx: 4, overPx: 3, lineY: 3,
    plannedHours: 10, capacityHours: 8, tentativeHours: 4, overtimeHours: 2, overbookedDays: 1, ...over,
  });
  const labels = (locale: "fr" | "en", c: GridCap) => capacityLabeler(createI18n(locale))("mar. 3", c);

  it("libellés FR : heures planifiées / capacité, tentatif, surcharge", () => {
    expect(labels("fr", cell())).toBe("mar. 3 : 10 h planifiées sur 8 h de capacité, dont 4 h tentatives, surcharge de 2 h");
    expect(labels("fr", cell({ state: "ok", plannedHours: 6, tentativeHours: 0, overtimeHours: 0, overbookedDays: 0 }))).toBe("mar. 3 : 6 h planifiées sur 8 h de capacité");
    expect(labels("fr", cell({ state: "over", overbookedDays: 3 }))).toContain("surcharge de 2 h sur 3 jours");
    expect(labels("fr", cell({ state: "none", plannedHours: 0, capacityHours: 0 }))).toBe("mar. 3 : aucune capacité, rien de planifié");
  });

  it("libellés EN", () => {
    expect(labels("en", cell())).toBe("mar. 3: 10 h planned of 8 h capacity, of which 4 h tentative, overload of 2 h");
    expect(labels("en", cell({ overbookedDays: 2 }))).toContain("overload of 2 h over 2 days");
    expect(labels("en", cell({ state: "none", plannedHours: 0, capacityHours: 0 }))).toBe("mar. 3: no capacity, nothing planned");
  });

  it("le rendu pose aria-label et infobulle sur la cellule", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root, { capLabel: (c) => capacityLabeler(createI18n("fr"))("mar. 3", c) });
    const row = { personId: "1", name: "P1", top: 0, heightPx: 62, overflow: false, blocks: [], capY: 48, cells: [cell()] };
    r.render({ from: "2026-03-02", to: "2026-03-15", pxPerDay: 96, widthPx: 1344, heightPx: 62, rows: [row] }, 0, 400);
    const el = root.querySelector(".wn-cap") as HTMLElement;
    expect(el.getAttribute("role")).toBe("gridcell");
    expect(el.getAttribute("aria-label")).toContain("10 h planifiées sur 8 h de capacité");
    expect(el.title).toBe(el.getAttribute("aria-label"));
    expect(el.className).toContain("wn-cap-over");
    expect(el.style.transform).toBe("translate(0px, 48px)");
  });
});
