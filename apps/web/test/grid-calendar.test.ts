// @vitest-environment jsdom
// Lecture du calendrier dans la grille (recette n°2, L-I) : jours non travaillés hachurés selon l'horaire de chaque personne
// (RT-028, Q9, BR-19), samedi et dimanche grisés dans l'en-tête en vue jour (Q9), séparateurs de colonnes (RT-026), période
// courante mise en évidence (RT-027) et jauge qui ne compte pas les jours non travaillés (RT-029, Q10 : non-régression).
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createGridRenderer } from "../src/schedule/grid-dom";
import { columnsBackground, createHeaderRenderer } from "../src/schedule/grid-header";
import { buildGrid, gaugeOf } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller } from "../src/schedule/scroller";

type Alloc = ScheduleResponse["allocations"][number];
type Person = ScheduleResponse["people"][number];
const person = (id: string, over: Partial<Person> = {}): Person => ({
  id, version: 1, name: `P${id}`, peopleType: "employee", departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true, ...over,
} as Person);
const alloc = (id: string, over: Partial<Alloc> = {}): Alloc => ({
  id, version: 1, personId: "1", projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-19", endDate: "2026-10-25", status: "confirmed", billable: true, priority: 0,
  repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 8, percent: null, ...over,
} as Alloc);
// Deux semaines du lundi 19 octobre au dimanche 1er novembre 2026.
const range = { from: "2026-10-19", to: "2026-11-01" };
const snap = (people: Person[], allocations: Alloc[] = []): ScheduleResponse => ({
  window: range, changeCursor: "0", page: { nextCursor: null, total: people.length },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" }, people, allocations, timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [], roles: [],
} as ScheduleResponse);

describe("jours non travaillés dans le modèle (RT-028, Q9)", () => {
  it("horaire par défaut : samedi et dimanche, une plage par week-end", () => {
    const g = buildGrid(snap([person("1")]), range, 10);
    expect(g.rows[0]!.nonWorking).toEqual([{ x: 50, w: 20 }, { x: 120, w: 20 }]);
  });

  it("selon l'horaire de chaque personne : qui travaille le samedi n'a que le dimanche, qui ne travaille pas le mercredi l'a aussi", () => {
    const g = buildGrid(snap([person("1", { workDaysHours: [8, 8, 8, 8, 8, 4, 0] }), person("2", { workDaysHours: [8, 8, 0, 8, 8, 0, 0] })]), range, 10);
    expect(g.rows[0]!.nonWorking).toEqual([{ x: 60, w: 10 }, { x: 130, w: 10 }]);
    expect(g.rows[1]!.nonWorking).toEqual([{ x: 20, w: 10 }, { x: 50, w: 20 }, { x: 90, w: 10 }, { x: 120, w: 20 }]);
  });

  it("horaire daté (BR-19) : le samedi travaillé à partir du 26 octobre n'est plus hachuré", () => {
    const p = person("1", {
      workDaysHours: [8, 8, 8, 8, 8, 4, 0],
      workSchedule: [
        { validFrom: null, validTo: "2026-10-25", workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
        { validFrom: "2026-10-26", validTo: null, workDaysHours: [8, 8, 8, 8, 8, 4, 0] },
      ],
    });
    expect(buildGrid(snap([p]), range, 10).rows[0]!.nonWorking).toEqual([{ x: 50, w: 20 }, { x: 130, w: 10 }]);
  });
});

describe("hachures dans le rendu (RT-028)", () => {
  it("un nœud décoratif par ligne, sous les congés et les blocs, une couche de fond par plage visible", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    const g = buildGrid(snap([person("1")], [alloc("1", { startDate: "2026-10-20", endDate: "2026-10-20" })]), range, 10);
    r.render(g, 0, 400, { surfaceWidth: 1000, originX: 300, left: 0, right: 1000 });
    const rowEl = root.querySelector<HTMLElement>("[role=row]")!;
    const hatch = rowEl.querySelector<HTMLElement>(".wn-nonwork")!;
    expect(hatch.getAttribute("aria-hidden")).toBe("true");
    const bg = hatch.style.background;
    expect(bg.match(/var\(--wn-nonwork-hatch\)/g)).toHaveLength(2);
    expect(bg).toContain("350px 0px / 20px 100%");
    expect(bg).toContain("420px 0px / 20px 100%");
    const order = [...rowEl.children].map((c) => c.className.split(" ")[0]);
    expect(order.indexOf("wn-nonwork")).toBeLessThan(order.indexOf("wn-block"));
  });

  it("plages hors de la fenêtre horizontale : pas de couche ; aucune plage : fond vide", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    const g = buildGrid(snap([person("1"), person("2", { workDaysHours: [8, 8, 8, 8, 8, 8, 8] })]), range, 10);
    r.render(g, 0, 400, { surfaceWidth: 1000, originX: 0, left: 0, right: 100 });
    const [a, b] = [...root.querySelectorAll<HTMLElement>(".wn-nonwork")];
    expect(a!.style.background.match(/var\(--wn-nonwork-hatch\)/g)).toHaveLength(1);
    expect(b!.style.background).toBe("");
  });
});

describe("en-tête : période courante et week-end (RT-027, Q9)", () => {
  it("cellule courante marquée (classe et aria-current=date), week-end grisé ; marques retirées au recyclage", () => {
    const root = document.createElement("div");
    const h = createHeaderRenderer(root, { heightPx: 32, gutterPx: 240 });
    h.render([
      { from: "2026-10-23", x: 240, w: 96, label: "ven. 23" },
      { from: "2026-10-24", x: 336, w: 96, label: "sam. 24", weekend: true, current: true },
    ], 1000);
    const cell = (d: string) => root.querySelector<HTMLElement>(`[data-from="${d}"]`)!;
    expect(cell("2026-10-24").classList.contains("wn-colheader-current")).toBe(true);
    expect(cell("2026-10-24").getAttribute("aria-current")).toBe("date");
    expect(cell("2026-10-24").classList.contains("wn-colheader-weekend")).toBe(true);
    expect(cell("2026-10-23").classList.contains("wn-colheader-current")).toBe(false);
    expect(cell("2026-10-23").hasAttribute("aria-current")).toBe(false);
    h.render([{ from: "2026-10-23", x: 240, w: 96, label: "ven. 23", current: true }], 1000);
    expect(cell("2026-10-23").getAttribute("aria-current")).toBe("date");
    const recycled = [...root.querySelectorAll<HTMLElement>(".wn-colheader")].find((e) => e.style.display === "none")!;
    expect(recycled.className).toBe("wn-colheader");
    expect(recycled.hasAttribute("aria-current")).toBe(false);
  });

  it("fond des colonnes : un séparateur au début de chaque cellule, teinte de la colonne courante", () => {
    const bg = columnsBackground([
      { from: "2026-10-19", x: 240, w: 196, label: "" },
      { from: "2026-10-26", x: 436, w: 196, label: "", current: true },
    ]);
    expect(bg.match(/var\(--wn-grid-line\)/g)).toHaveLength(4); // linear-gradient(c, c) : deux fois par séparateur
    expect(bg).toContain("240px 0px / 1px 100%");
    expect(bg).toContain("436px 0px / 1px 100%");
    expect(bg).toContain("436px 0px / 196px 100%");
    expect(bg).toContain("var(--wn-col-current)");
    expect(columnsBackground([{ from: "2026-10-19", x: 240, w: 196, label: "" }])).not.toContain("--wn-col-current");
  });
});

describe("scroller : séparateurs, période courante, week-end (RT-026, RT-027, Q9)", () => {
  const mount = (zoom: "day" | "week" | "month") => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const s = createScroller({
      root, data: snap([person("1")]), today: "2026-10-21", widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, zoom,
      clock: { raf: () => 0, caf: () => {}, idle: () => {} }, reducedMotion: () => true,
    });
    const cell = (d: string) => root.querySelector<HTMLElement>(`[role=columnheader][data-from="${d}"]`);
    return { root, s, cell };
  };

  it("vue jour : aujourd'hui est la colonne courante, samedi et dimanche grisés, pas les autres jours", () => {
    const { s, cell } = mount("day");
    expect(cell("2026-10-21")!.getAttribute("aria-current")).toBe("date");
    expect([...document.querySelectorAll("[aria-current=date]")]).toHaveLength(1);
    expect(cell("2026-10-24")!.classList.contains("wn-colheader-weekend")).toBe(true);
    expect(cell("2026-10-25")!.classList.contains("wn-colheader-weekend")).toBe(true);
    expect(cell("2026-10-23")!.classList.contains("wn-colheader-weekend")).toBe(false);
    s.destroy();
  });

  it("vue semaine : la semaine qui contient aujourd'hui est courante, aucune colonne de week-end ; fond de séparateurs sur la surface", () => {
    const { s, cell } = mount("week");
    expect(cell("2026-10-19")!.getAttribute("aria-current")).toBe("date");
    expect(document.querySelectorAll(".wn-colheader-weekend")).toHaveLength(0);
    const surface = s.host.surface;
    const cells = document.querySelectorAll("[role=columnheader][data-from]").length;
    expect(surface.style.background.match(/var\(--wn-grid-line\)/g)).toHaveLength(2 * cells);
    expect(surface.style.background).toContain("var(--wn-col-current)");
    s.destroy();
  });

  it("vue mois : le mois courant ; changement de date du jour : la marque suit sans recréer le scroller", () => {
    const { s, cell, root } = mount("month");
    expect(cell("2026-10-01")!.getAttribute("aria-current")).toBe("date");
    s.setToday("2026-11-02");
    root.dispatchEvent(new Event("scroll"));
    s.setZoom("day");
    s.setZoom("month");
    expect(cell("2026-11-01")!.getAttribute("aria-current")).toBe("date");
    expect(cell("2026-10-01")!.hasAttribute("aria-current")).toBe(false);
    s.destroy();
  });
});

describe("jauge et jours non travaillés (RT-029, Q10 : non-régression)", () => {
  const week = { from: "2026-10-19", to: "2026-10-25" };
  const gauge = (p: Person, a: Alloc) => {
    const g = buildGrid(snap([p], [a]), range, DEFAULT_PX_PER_DAY.day);
    return gaugeOf(g.rows[0]!, week, g.thresholds);
  };

  it("8 h par jour du lundi au dimanche : 40 h sur 40 h, 100 % (le week-end ne compte ni en charge ni en capacité)", () => {
    expect(gauge(person("1"), alloc("1"))).toMatchObject({ plannedHours: 40, capacityHours: 40, percent: 100 });
  });

  it("100 % du lundi au dimanche (mode pourcentage) : 100 %, pas 140 % ni 71 %", () => {
    expect(gauge(person("1"), alloc("1", { mode: "percentage", hoursPerDay: null, percent: 100 }))).toMatchObject({ plannedHours: 40, capacityHours: 40, percent: 100 });
  });

  it("samedi travaillé (4 h) : compté dans la charge et la capacité, dimanche toujours exclu", () => {
    expect(gauge(person("1", { workDaysHours: [8, 8, 8, 8, 8, 4, 0] }), alloc("1", { mode: "percentage", hoursPerDay: null, percent: 100 })))
      .toMatchObject({ plannedHours: 44, capacityHours: 44, percent: 100 });
  });
});
