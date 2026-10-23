// @vitest-environment jsdom
// Écran Schedule (coquille React) : barre d'outils traduite, zooms, « Aujourd'hui », clavier, grille montée.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createI18n, type UiLocale } from "../src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: ScheduleResponse = {
  window: { from: "2026-09-01", to: "2026-11-30" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["Alice", "Bruno"].map((name, i) => ({
    id: String(i + 1), version: 1, name, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
  })),
  allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
};

let root: Root | null = null;
let host: HTMLElement;
let frames: (() => void)[] = [];
let now = 0;
const clock = { raf: (cb: () => void) => frames.push(cb), caf: () => {}, now: () => now, idle: (cb: () => void) => cb() };
/** Laisse passer `n` images (défilement doux). */
const run = (n = 30) => act(() => { for (let i = 0; i < n; i++) { now += 16; for (const f of frames.splice(0)) f(); } });
function mount(locale: UiLocale) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  frames = [];
  act(() => root!.render(<ScheduleScreen i18n={createI18n(locale)} data={data} today="2026-10-19" widthPx={960} heightPx={480} clock={clock} />));
}
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
const headers = () => [...host.querySelectorAll("[role=columnheader][data-from]")]; // dates (le coin est l’en-tête des personnes, RT-061)
const grid = () => host.querySelector("[role=grid]") as HTMLElement;
const key = (k: string) => act(() => grid().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("ScheduleScreen", () => {
  it("taille de la grille : suit le ResizeObserver sans recréer le scroller", () => {
    const observers: { cb: ResizeObserverCallback; target: Element | null }[] = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      rec: { cb: ResizeObserverCallback; target: Element | null };
      constructor(cb: ResizeObserverCallback) { this.rec = { cb, target: null }; observers.push(this.rec); }
      observe(t: Element) { this.rec.target = t; }
      disconnect() {}
      unobserve() {}
    };
    try {
      mount("fr");
      const before = headers().length;
      const rowEl = grid().querySelector("[role=row]");
      const notify = (width: number, height: number) => act(() => {
        for (const o of observers) if (o.target === grid()) o.cb([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
      });
      notify(520, 300);
      expect(headers().length).toBeLessThan(before);
      notify(1400, 300);
      expect(headers().length).toBeGreaterThan(before);
      expect(grid().querySelector("[role=row]")).toBe(rowEl);
      expect(grid().style.height).toBe("");
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  it("pseudo-locale : tout le texte de l'interface passe par le catalogue (seuls les noms restent)", () => {
    mount("pseudo");
    // Seule exception : la pastille du raccourci de recherche (kbd[data-shortcut], un nom de touche et non un texte traduit),
    // dont le contenu doit être exactement l'une des deux valeurs autorisées.
    const shortcuts = [...host.querySelectorAll("kbd[data-shortcut]")];
    expect(shortcuts).toHaveLength(1);
    expect(["Ctrl K", "⌘K"]).toContain(shortcuts[0]!.textContent);
    const texts = [...host.querySelectorAll("button, [role=toolbar] span")].map((e) => [...e.childNodes].filter((n) => !(n as Element).matches?.("kbd[data-shortcut]")).map((n) => n.textContent).join(""));
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t).toMatch(/^\[.*\]$/);
    expect(host.querySelector("[role=grid]")!.getAttribute("aria-label")).toMatch(/^\[.*\]$/);
  });

  it("grille montée : une ligne par personne, compteur au pluriel", () => {
    mount("fr");
    expect([...host.querySelectorAll("[role=rowheader] .wn-person-name")].map((e) => e.textContent)).toEqual(["Alice", "Bruno"]);
    expect(grid().querySelector("[role=row]")!.querySelectorAll("[role=columnheader]").length).toBeGreaterThan(7); // en-tête dans la grille
    expect(host.textContent).toContain("2 personnes");
  });

  it("zoom semaine : bouton pressé, en-têtes par semaine ; précédent puis Aujourd'hui recentre", () => {
    mount("fr");
    const days = headers().length;
    act(() => button("Semaine").click());
    expect(button("Semaine").getAttribute("aria-pressed")).toBe("true");
    expect(headers().length).toBeLessThan(days);
    const centered = headers().map((h) => h.getAttribute("data-from"));
    const left = grid().scrollLeft;
    act(() => button("Période précédente").click());
    run();
    expect(left - grid().scrollLeft).toBe(7 * 28); // une semaine au zoom semaine
    act(() => button("Aujourd’hui").click());
    run();
    expect(grid().scrollLeft).toBe(left);
    expect(headers().map((h) => h.getAttribute("data-from"))).toEqual(centered);
  });

  it("clavier : flèches gauche / droite défilent d'un jour, T revient à aujourd'hui", () => {
    mount("en");
    const left = grid().scrollLeft;
    key("ArrowRight");
    key("ArrowRight");
    run(1);
    expect(grid().scrollLeft - left).toBe(2 * 96);
    key("ArrowLeft");
    expect(grid().scrollLeft - left).toBe(96);
    act(() => button("Next period").click());
    run();
    key("t");
    run();
    expect(grid().scrollLeft).toBe(left);
  });

  it("nouveau jour : la grille n'est pas recréée, la position est gardée, T va au nouveau jour", () => {
    mount("fr");
    const surface = host.querySelector(".wn-surface");
    const left = grid().scrollLeft;
    key("ArrowRight");
    run(1);
    act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={data} today="2026-10-20" widthPx={960} heightPx={480} clock={clock} />));
    expect(host.querySelector(".wn-surface")).toBe(surface);
    expect(grid().scrollLeft).toBe(left + 96);
    key("ArrowRight");
    run(1);
    key("t");
    run();
    expect(grid().scrollLeft).toBe(left + 96);
  });

  it("changement de locale : grille gardée (même surface, même position), en-têtes et barre traduits", () => {
    mount("fr");
    const surface = host.querySelector(".wn-surface");
    key("ArrowRight");
    run(1);
    const left = grid().scrollLeft;
    const before = headers()[0]!.textContent;
    act(() => root!.render(<ScheduleScreen i18n={createI18n("en")} data={data} today="2026-10-19" widthPx={960} heightPx={480} clock={clock} />));
    run(1);
    expect(host.querySelector(".wn-surface")).toBe(surface);
    expect(grid().scrollLeft).toBe(left);
    expect(button("Next period")).toBeDefined();
    expect(headers()[0]!.textContent).not.toBe(before);
  });
});
