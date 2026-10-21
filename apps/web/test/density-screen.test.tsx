// @vitest-environment jsdom
// Écran Schedule : contrôle de densité (groupe radio accessible, application à la volée, mémorisation locale), densité
// portée par les vues sauvegardées (RT-007, Q2), état gardé quand on quitte puis rouvre le Planning (PO-02).
import type { SavedView } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleScreen, type ScheduleMemory } from "../src/ScheduleScreen";
import { demoSchedule } from "../src/demo";
import { createDemoViewsSource, demoSeedViews, type ViewsSource } from "../src/data/views-source";
import { createI18n } from "../src/i18n";
import { DENSITY_METRICS, DENSITY_STORAGE_KEY } from "../src/schedule/density";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: (cb) => cb(), setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const data = demoSchedule(TODAY, 12);

beforeEach(() => localStorage.clear());
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; frames.length = 0; localStorage.clear(); history.replaceState(null, "", "/"); });

async function mount(opts: { views?: ViewsSource; memory?: ScheduleMemory } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={data} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
    {...(opts.views ? { views: opts.views } : {})} {...(opts.memory ? { memory: opts.memory } : {})} />));
  await flush();
}
const unmount = () => { act(() => root?.unmount()); root = null; host.remove(); };

/** Groupe radio de la densité, dans le menu Affichage (RT-025) : le menu est ouvert s'il ne l'est pas. */
const group = () => {
  const open = () => document.body.querySelector<HTMLElement>("[role=dialog][aria-label=Affichage] [role=radiogroup]");
  if (!open()) act(() => { [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => b.textContent === "Affichage")!.click(); });
  return open()!;
};
const radios = () => [...group().querySelectorAll<HTMLButtonElement>("[role=radio]")];
const checked = () => radios().filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);
const density = () => host.querySelector<HTMLElement>(".wn-schedule")!.getAttribute("data-density");
const firstRowHeight = () => host.querySelector<HTMLElement>(".wn-row:not([style*='display: none'])")!.style.height;
const grid = () => host.querySelector<HTMLElement>("[role=grid]")!;
const zoomPressed = () => [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] [aria-pressed=true]")].map((b) => b.textContent);
const click = async (b: HTMLElement | undefined) => { await act(async () => { b!.click(); }); await flush(); };
const key = (k: string) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const minRow = (d: keyof typeof DENSITY_METRICS) => DENSITY_METRICS[d].rowUnitPx + DENSITY_METRICS[d].capPx;

describe("contrôle de densité", () => {
  it("groupe radio libellé dans le menu Affichage, trois niveaux, Standard par défaut (roving tabindex)", async () => {
    await mount();
    expect(group().closest("[role=dialog][aria-label=Affichage]")).not.toBeNull(); // menu Affichage (RT-025)
    expect(group().getAttribute("aria-label")).toBe("Densité");
    expect(radios().map((r) => r.textContent)).toEqual(["Compacte", "Standard", "Aérée"]);
    expect(checked()).toEqual(["Standard"]);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(density()).toBe("standard");
  });

  it("un clic applique à la volée (hauteurs de ligne, data-density) et mémorise dans ce navigateur", async () => {
    await mount();
    const standard = parseFloat(firstRowHeight());
    await click(radios()[2]);
    expect([checked(), density()]).toEqual([["Aérée"], "airy"]);
    expect(parseFloat(firstRowHeight())).toBeGreaterThan(standard);
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("airy");
    await click(radios()[0]);
    expect(parseFloat(firstRowHeight())).toBeLessThan(standard);
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
  });

  it("clavier : flèches (avec retour au début), Début et Fin ; le focus suit le choix", async () => {
    await mount();
    radios()[1]!.focus();
    key("ArrowRight");
    expect([checked(), document.activeElement?.textContent]).toEqual([["Aérée"], "Aérée"]);
    key("ArrowRight");
    expect(checked()).toEqual(["Compacte"]);
    key("ArrowLeft");
    expect(checked()).toEqual(["Aérée"]);
    key("Home");
    expect(checked()).toEqual(["Compacte"]);
    key("End");
    expect([checked(), localStorage.getItem(DENSITY_STORAGE_KEY)]).toEqual([["Aérée"], "airy"]);
  });

  it("densité mémorisée reprise au montage suivant ; valeur illisible : Standard", async () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "compact");
    await mount();
    expect(checked()).toEqual(["Compacte"]);
    expect(parseFloat(firstRowHeight())).toBeGreaterThanOrEqual(minRow("compact"));
    unmount();
    localStorage.setItem(DENSITY_STORAGE_KEY, "géante");
    await mount();
    expect(checked()).toEqual(["Standard"]);
  });
});

describe("densité et vues sauvegardées", () => {
  const viewSelect = () => host.querySelector<HTMLSelectElement>(".wn-views-row select")!;
  const choose = async (id: string) => {
    await act(async () => { viewSelect().value = id; viewSelect().dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
  };
  const withDensity = (): ViewsSource => {
    const seed = demoSeedViews();
    const aired: SavedView = { ...seed[0]!, id: "demo-view-airy", name: "Revue aérée", filters: { density: "airy" }, position: 9 };
    return createDemoViewsSource([...seed, aired], store());
  };

  it("une vue avec densité l'applique ; une vue sans densité garde la densité courante", async () => {
    await mount({ views: withDensity() });
    await choose("demo-view-airy");
    expect([checked(), density()]).toEqual([["Aérée"], "airy"]);
    await choose("demo-view-2"); // projet A, zoom semaine, sans densité
    expect(checked()).toEqual(["Aérée"]);
    expect(zoomPressed()).toEqual(["Semaine"]);
  });

  it("vue sauvegardée avec densité dans l'URL : appliquée au chargement", async () => {
    history.replaceState(null, "", "/?view=demo-view-airy");
    await mount({ views: withDensity() });
    expect(checked()).toEqual(["Aérée"]);
  });

  it("enregistrer la vue courante y met la densité ; la changer ensuite marque la vue modifiée", async () => {
    const views = createDemoViewsSource(demoSeedViews(), store());
    await mount({ views });
    await click(radios()[0]);
    await click([...host.querySelectorAll<HTMLButtonElement>(".wn-views button")].find((b) => b.textContent === "Enregistrer la vue…"));
    const input = document.body.querySelector<HTMLInputElement>(".wn-views-form input[type=text]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Compacte");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((b) => b.textContent === "Enregistrer"));
    const list = await views.list();
    expect(list.ok && list.value.find((v) => v.name === "Compacte")?.filters).toEqual({ zoom: "day", density: "compact" });
    expect(host.querySelector(".wn-views-modified")).toBeNull();
    await click(radios()[1]);
    expect(host.querySelector(".wn-views-modified")).not.toBeNull();
  });
});

describe("PO-02 : quitter puis rouvrir le Planning", () => {
  it("zoom, jour au centre et défilement vertical repris au remontage (densité : par la mémoire locale)", async () => {
    const memory: ScheduleMemory = {};
    await mount({ memory });
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => b.textContent === "Semaine"));
    await click(radios()[2]);
    act(() => { grid().scrollLeft += 7 * 24 * 5; grid().scrollTop = 300; grid().dispatchEvent(new Event("scroll")); for (const f of frames.splice(0)) f(); });
    const left = grid().scrollLeft;
    unmount();
    expect(memory).toMatchObject({ zoom: "week", scrollTop: 300 });
    expect(typeof memory.center).toBe("number");
    await mount({ memory });
    expect(zoomPressed()).toEqual(["Semaine"]);
    expect(checked()).toEqual(["Aérée"]);
    expect(grid().scrollTop).toBe(300);
    expect(Math.abs(grid().scrollLeft - left)).toBeLessThanOrEqual(1);
  });

  it("sans mémoire : l'écran repart d'aujourd'hui, zoom jour", async () => {
    await mount();
    expect(zoomPressed()).toEqual(["Jour"]);
  });
});
