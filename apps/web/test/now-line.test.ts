// @vitest-environment jsdom
// Trait « maintenant » (RT-055, cadrage n°4) : trait vertical au début du jour courant, sur toute la hauteur du corps, au-dessus
// des blocs, décoratif (aria-hidden ; aria-current reste dans l'en-tête). En vue semaine et mois, placé au prorata du jour
// dans la colonne. Masqué quand il passe sous la colonne des personnes.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { GUTTER_PX, createScroller } from "../src/schedule/scroller";

type Person = ScheduleResponse["people"][number];
const person = (id: string): Person => ({
  id, version: 1, name: `P${id}`, peopleType: "employee", departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
} as Person);
const range = { from: "2026-10-19", to: "2026-11-01" };
const snap = {
  window: range, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" }, people: [person("1"), person("2")], allocations: [], timeoffs: [], holidays: [],
  projects: [], timeoffTypes: [], departments: [], roles: [],
} as unknown as ScheduleResponse;
const TODAY = "2026-10-21"; // mercredi

const mount = (zoom: "day" | "week" | "month") => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const s = createScroller({
    root, data: snap, today: TODAY, widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, zoom,
    clock: { raf: () => 0, caf: () => {}, idle: () => {} }, reducedMotion: () => true,
  });
  const line = () => s.host.surface.querySelector<HTMLElement>(".wn-now");
  return { root, s, line };
};
const xOf = (el: HTMLElement) => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1]);

describe("trait « maintenant » (RT-055)", () => {
  for (const zoom of ["day", "week", "month"] as const) {
    it(`vue ${zoom} : un trait décoratif au début du jour courant, sur toute la hauteur de la surface`, () => {
      const { s, line, root } = mount(zoom);
      const el = line()!;
      expect(el).not.toBeNull();
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.hidden).toBe(false);
      expect(xOf(el)).toBe(s.host.xOfDate(TODAY));
      expect(el.style.height).toBe(s.host.surface.style.height);
      s.destroy();
      root.remove();
    });
  }

  it("vue semaine : au prorata du jour dans la colonne (mercredi = 2 jours après le début de la semaine)", () => {
    const { s, line, root } = mount("week");
    const col = root.querySelector<HTMLElement>("[role=columnheader][aria-current=date]")!;
    expect(col.getAttribute("data-from")).toBe("2026-10-19");
    expect(xOf(line()!)).toBe(s.host.xOfDate("2026-10-19") + 2 * s.host.pxPerDay());
    s.destroy();
    root.remove();
  });

  it("changement de date du jour : le trait suit ; sous la colonne des personnes : masqué", () => {
    const frames: (() => void)[] = [];
    const root = document.createElement("div");
    document.body.appendChild(root);
    const s = createScroller({
      root, data: snap, today: TODAY, widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, zoom: "day",
      clock: { raf: (cb) => frames.push(cb), caf: () => {}, idle: () => {} }, reducedMotion: () => true,
    });
    const run = () => { for (const f of frames.splice(0)) f(); };
    const line = () => s.host.surface.querySelector<HTMLElement>(".wn-now")!;
    s.setToday("2026-10-22");
    run();
    expect(xOf(line())).toBe(s.host.xOfDate("2026-10-22"));
    // Aujourd'hui passe à gauche de la zone visible, sous la gouttière collée des personnes.
    root.scrollLeft = s.host.xOfDate("2026-10-22") + 3 * s.host.pxPerDay() - GUTTER_PX;
    root.dispatchEvent(new Event("scroll"));
    run();
    expect(line().hidden).toBe(true);
    root.scrollLeft = s.host.xOfDate("2026-10-22") - GUTTER_PX - 2 * s.host.pxPerDay();
    root.dispatchEvent(new Event("scroll"));
    run();
    expect(line().hidden).toBe(false);
    s.destroy();
    root.remove();
  });
});
