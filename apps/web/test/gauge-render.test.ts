// @vitest-environment jsdom
// Jauge par personne dans la colonne de gauche (RT-008, Q3) et densité dans le scroller (RT-005) : avatar, nom, rôle,
// département, jauge (▲ en dépassement), recalcul seulement quand la période change, période = jours visibles au
// défilement, changement de densité qui garde la personne en haut de la vue.
import type { ScheduleResponse } from "@wnext/contracts";
import { visibleRange } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { DENSITY_METRICS } from "../src/schedule/density";
import { createGridRenderer } from "../src/schedule/grid-dom";
import { buildGrid } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string, name: string, extra: { roleId?: string; departmentId?: string } = {}) => ({
  id, version: 1, name, peopleType: "employee" as const, departmentId: extra.departmentId ?? null, roleId: extra.roleId ?? null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, personId: string, from: string, to: string, hoursPerDay: number, status: "confirmed" | "tentative" = "confirmed"): Alloc => ({
  id, version: 1, personId, projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: from, endDate: to, status, billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay, percent: null,
} as Alloc);
// Semaine du lundi 2 mars 2026. Alice : 10 h lundi et mardi, 4 h mercredi (24 h sur 40). Bruno : rien.
const snap: ScheduleResponse = {
  window: { from: "2026-03-02", to: "2026-03-15" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" },
  people: [person("1", "Alice Martin", { roleId: "r1", departmentId: "d1" }), person("2", "Bruno")],
  allocations: [alloc("1", "1", "2026-03-02", "2026-03-03", 10), alloc("2", "1", "2026-03-04", "2026-03-04", 4)],
  timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [{ id: "d1", name: "Design" }], roles: [{ id: "r1", name: "Designer" }],
} as ScheduleResponse;
const range = { from: "2026-03-02", to: "2026-03-15" };

describe("jauge : rendu dans la colonne de gauche", () => {
  const rendered = () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    return { root, r };
  };
  const heads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".wn-rowheader")].filter((h) => h.querySelector(".wn-person-name")!.textContent);

  it("avatar, nom, rôle, département en pastille, jauge (barre + valeur) ; ▲ et classe over en dépassement", () => {
    const { root, r } = rendered();
    const m = buildGrid(snap, range, 96, "day");
    r.render(m, 0, 400, undefined, { from: "2026-03-02", to: "2026-03-03" });
    const [a, b] = heads(root);
    expect(a!.querySelector(".wn-person-avatar")!.textContent).toBe("AM");
    expect(a!.querySelector(".wn-person-avatar")!.getAttribute("aria-hidden")).toBe("true");
    expect([a!.querySelector(".wn-person-role")!.textContent, a!.querySelector(".wn-person-dept")!.textContent]).toEqual(["Designer", "Design"]);
    expect((b!.querySelector(".wn-person-dept") as HTMLElement).hidden).toBe(true);
    const gauge = a!.querySelector<HTMLElement>(".wn-gauge")!;
    expect(gauge.className).toBe("wn-gauge wn-gauge-over");
    expect(gauge.querySelector(".wn-gauge-value")!.textContent).toBe("▲ 125 % +4 h");
    expect(gauge.querySelector<HTMLElement>(".wn-gauge-fill")!.style.width).toBe("100%");
    expect(gauge.getAttribute("role")).toBe("img");
    expect(gauge.title).toBe("2026-03-02 – 2026-03-03 : 20 h / 16 h");
    expect(gauge.getAttribute("aria-label")).toContain("▲ 125 % +4 h");
    r.destroy();
  });

  it("recalculée quand la période change, et seulement alors (même modèle, même période : nœuds intacts)", () => {
    const { root, r } = rendered();
    const m = buildGrid(snap, range, 96, "day");
    r.render(m, 0, 400, undefined, { from: "2026-03-02", to: "2026-03-08" });
    const value = () => heads(root)[0]!.querySelector(".wn-gauge-value")!;
    expect(value().textContent).toBe("▲ 60 % +4 h"); // lundi et mardi en surcharge (RT-063)
    const text = value().firstChild!;
    let writes = 0;
    new MutationObserver((l) => { writes += l.length; }).observe(root, { subtree: true, characterData: true, attributes: true });
    r.render(m, 0, 400, undefined, { from: "2026-03-02", to: "2026-03-08" });
    return Promise.resolve().then(() => {
      expect(writes).toBe(0);
      r.render(m, 0, 400, undefined, { from: "2026-03-09", to: "2026-03-15" });
      expect(value().textContent).toBe("0 %");
      expect(value().firstChild).toBe(text); // nœud texte recyclé, pas recréé
      r.destroy();
    });
  });
});

describe("jauge et densité dans le scroller", () => {
  const manual = () => {
    const frames: (() => void)[] = [];
    const clock: Partial<Clock> = { raf: (cb) => frames.push(cb), caf: () => {}, now: () => 0, setTimer: () => 0, clearTimer: () => {}, idle: (cb) => cb() };
    return { clock, run: () => { for (const f of frames.splice(0)) f(); } };
  };
  const setup = (density?: "compact" | "standard" | "airy") => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const m = manual();
    // 7 jours visibles à 96 px en zoom jour.
    const s = createScroller({ root, data: snap, today: "2026-03-05", widthPx: GUTTER_PX + 7 * 96, heightPx: 400, label: (c) => c.from, clock: m.clock, ...(density ? { density } : {}) });
    return { root, s, m };
  };
  const title = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".wn-gauge")].find((g) => g.title)!.title;

  it("période de la jauge = jours visibles ; un défilement d'une semaine la décale", () => {
    const { root, s, m } = setup();
    expect(visibleRange(s.view())).toEqual({ from: "2026-03-02", to: "2026-03-08" });
    expect(title(root)).toBe("2026-03-02 – 2026-03-08 : 24 h / 40 h");
    root.scrollLeft += 7 * 96;
    root.dispatchEvent(new Event("scroll"));
    m.run();
    expect(visibleRange(s.view())).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(title(root)).toBe("2026-03-09 – 2026-03-15 : 0 h / 40 h");
    s.destroy();
    root.remove();
  });

  it("setDensity : hauteurs reconstruites, la personne en haut de la vue y reste", () => {
    const { root, s } = setup("compact");
    expect(s.density()).toBe("compact");
    const rowH = () => root.querySelector<HTMLElement>(".wn-row:not([style*='display: none'])")!.style.height;
    expect(rowH()).toMatch(/^\d+px$/);
    const rowsAt = (d: "compact" | "airy") => buildGrid(snap, range, 96, "day", DENSITY_METRICS[d]).rows;
    // Haut de la vue dans la 2e ligne (Bruno), à 10 px de son haut (la surface commence sous l'en-tête collant).
    root.scrollTop = rowsAt("compact")[1]!.top + 10;
    s.setDensity("airy");
    expect(s.density()).toBe("airy");
    const bruno = rowsAt("airy")[1]!;
    expect(rowH()).toBe(`${rowsAt("airy")[0]!.heightPx}px`);
    expect(root.scrollTop).toBeGreaterThan(bruno.top);
    expect(root.scrollTop).toBeLessThan(bruno.top + bruno.heightPx);
    s.destroy();
    root.remove();
  });
});
