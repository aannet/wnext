// @vitest-environment jsdom
// En-tête du Schedule en deux niveaux (recette n°2, L-J : RT-025, RT-030) : niveau 1 = titre, vue, actions de création ;
// niveau 2 (barre d'outils) = Filtres (compteur, puces retirables, panneau dépliable), navigation, zoom, annuler / rétablir,
// menu Affichage (densité, bascule « Charge » en mémoire seulement, Q11), nombre de personnes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoSource } from "../src/data/demo-source";
import { createDemoViewsSource, demoSeedViews } from "../src/data/views-source";
import { demoSchedule } from "../src/demo";
import { createI18n } from "../src/i18n";
import { historyForSource } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
let root: Root | null = null;
let host: HTMLElement;
const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; document.body.innerHTML = ""; history.replaceState(null, "", "/"); });

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const data = demoSchedule(TODAY, 12);
  const src = createDemoSource(data);
  const { history: h } = historyForSource(src);
  act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={data} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      views={createDemoViewsSource(demoSeedViews(), memory())} records={src} editor={h.editor} history={h} heading={<h1>Planning</h1>} />));
  await flush();
}
const level1 = () => host.querySelector<HTMLElement>(".wn-subheader")!;
const toolbar = () => host.querySelector<HTMLElement>("[role=toolbar]")!;
const buttonIn = (el: ParentNode, label: string | RegExp) => [...el.querySelectorAll<HTMLButtonElement>("button")]
  .find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? "")));
const click = async (b: HTMLElement | undefined) => { if (!b) throw new Error("bouton absent"); await act(async () => { b.click(); }); await flush(); };
async function pick(label: string, values: string[]) {
  const select = [...host.querySelectorAll<HTMLElement>(".wn-filter")].find((l) => l.firstElementChild?.textContent === label)!.querySelector("select")!;
  await act(async () => {
    for (const o of select.options) o.selected = values.includes(o.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

describe("en-tête en deux niveaux (RT-025)", () => {
  it("niveau 1 : titre, vue, + Allocation et Nouveau congé ; niveau 2 : Filtres, navigation, zoom, Affichage, personnes", async () => {
    await mount();
    expect(level1().querySelector("h1")!.textContent).toBe("Planning");
    expect(level1().querySelector(".wn-views select")).not.toBeNull();
    expect(buttonIn(level1(), "+ Allocation")).toBeDefined();
    expect(buttonIn(level1(), "Nouveau congé")).toBeDefined();
    expect(level1().contains(toolbar())).toBe(false);
    for (const label of ["Filtres", "Période précédente", "Aujourd’hui", "Période suivante", "Jour", "Semaine", "Mois", "Annuler", "Rétablir", "Affichage"]) {
      expect(buttonIn(toolbar(), label), label).toBeDefined();
    }
    expect(toolbar().textContent).toContain("12 personnes");
    expect(toolbar().querySelector("[role=radiogroup]")).toBeNull(); // la densité est dans le menu Affichage
  });

  it("Filtres : panneau dépliable (aria-expanded), compteur, une puce par filtre actif, retirable", async () => {
    await mount();
    const filters = buttonIn(toolbar(), "Filtres")!;
    expect(filters.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".wn-filter")).toBeNull();
    await click(filters);
    expect(filters.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(filters.getAttribute("aria-controls")!)!.querySelector(".wn-filter")).not.toBeNull();
    await pick("Département", ["2"]);
    expect(filters.textContent).toBe("Filtres (1)");
    expect(toolbar().textContent).toContain("4 personnes");
    const chip = toolbar().querySelector<HTMLElement>(".wn-chip")!;
    expect(chip.textContent).toContain("Département : Design");
    await click(chip.querySelector<HTMLButtonElement>("button[aria-label='Retirer le filtre Département : Design']")!);
    expect(toolbar().querySelector(".wn-chip")).toBeNull();
    expect(buttonIn(toolbar(), /^Filtres/)!.textContent).toBe("Filtres");
    expect(toolbar().textContent).toContain("12 personnes");
  });

  it("Affichage : menu avec la densité (radios) et la bascule « Charge », éteinte au montage et jamais mémorisée (Q11)", async () => {
    localStorage.clear();
    await mount();
    const display = buttonIn(toolbar(), "Affichage")!;
    expect(display.getAttribute("aria-haspopup")).toBe("dialog");
    await click(display);
    const menu = document.body.querySelector<HTMLElement>("[role=dialog][aria-label=Affichage]")!;
    expect([...menu.querySelectorAll("[role=radiogroup] [role=radio]")].map((r) => r.textContent)).toEqual(["Compacte", "Standard", "Aérée"]);
    const load = menu.querySelector<HTMLButtonElement>("[role=switch]")!;
    expect([load.textContent, load.getAttribute("aria-checked")]).toEqual(["Charge par colonne", "false"]);
    await click(load);
    expect(load.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector(".wn-schedule")!.getAttribute("data-load")).toBe("on");
    expect(JSON.stringify({ ...localStorage })).not.toContain("load");
    act(() => root!.unmount());
    host.remove();
    await mount();
    expect(host.querySelector(".wn-schedule")!.hasAttribute("data-load")).toBe(false);
  });
});

describe("charge chiffrée par colonne (RT-030, Q11)", () => {
  it("texte de chaque cellule : % de la capacité, heures si la capacité est nulle, rien sans capacité ni charge", async () => {
    const { capacityTexter } = await import("../src/schedule/capacity-label");
    const text = capacityTexter(createI18n("fr"));
    const cell = (planned: number, capacity: number) => ({ plannedHours: planned, capacityHours: capacity, state: capacity <= 0 && planned <= 0 ? "none" : "ok" }) as never;
    expect([text(cell(6, 8)), text(cell(12, 8)), text(cell(4, 0)), text(cell(0, 0)), text(cell(0, 8))]).toEqual(["75 %", "150 %", "4 h", "", "0 %"]);
    expect(capacityTexter(createI18n("en"))(cell(6, 8))).toBe("75%");
  });

  it("chaque cellule de capacité porte son texte (data-load) ; la bascule l'affiche par CSS, sans redessin", async () => {
    await mount();
    const caps = [...host.querySelectorAll<HTMLElement>(".wn-cap")].filter((c) => c.style.display !== "none");
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((c) => /^(\d+ %|\d+(,\d)? h|)$/.test(c.dataset.load ?? "x"))).toBe(true);
    expect(caps.some((c) => /%$/.test(c.dataset.load ?? ""))).toBe(true);
  });
});
