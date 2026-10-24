// @vitest-environment jsdom
// Palette de recherche dans le Planning (RT-038 ; RT-059 : bouton et palette montés par la coque, le Planning en est la cible) :
// Ctrl+K / ⌘K et bouton, résultats groupés, personne lointaine amenée dans la vue et
// mise en évidence, personne masquée par un filtre (filtres retirés puis ligne montrée), projet confié à onOpenProject, Échap,
// raccourci ignoré dans une autre fenêtre modale, FR et EN.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { SearchButton, SearchProvider } from "../src/shell/global-search";
import { demoSchedule } from "../src/demo";
import { createDemoViewsSource, demoSeedViews } from "../src/data/views-source";
import { createI18n } from "../src/i18n";
import { isSearchShortcut, searchShortcutLabel } from "../src/schedule/search-ui";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; frames.length = 0; });

async function mount(opts: { onOpenProject?: (id: string) => void; locale?: "fr" | "en"; views?: boolean } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const data = demoSchedule(TODAY, 40);
  const views = opts.views ? createDemoViewsSource(demoSeedViews(), memory()) : undefined;
  const i18n = createI18n(opts.locale ?? "fr");
  // RT-059 : la palette et son bouton appartiennent à la coque (en-tête commun) ; le Planning s'y inscrit comme cible.
  act(() => root!.render(
    <SearchProvider i18n={i18n}>
      <header className="wn-appheader"><div className="wn-appheader-end"><SearchButton i18n={i18n} /></div></header>
      <ScheduleScreen i18n={i18n} data={data} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
        {...(views ? { views } : {})} {...(opts.onOpenProject ? { onOpenProject: opts.onOpenProject } : {})} />
    </SearchProvider>));
  await flush();
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const input = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const optionTexts = () => options().map((o) => o.textContent);
const groupLabels = () => [...document.body.querySelectorAll('[role="group"][aria-labelledby]')].map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent);
const grid = () => host.querySelector<HTMLElement>("[role=grid]")!;
const searchButton = () => [...host.querySelectorAll<HTMLButtonElement>(".wn-appheader-end button")].find((b) => /^(Rechercher|Search)/.test(b.textContent ?? ""))!;
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await flush();
}
const lit = () => [...host.querySelectorAll<HTMLElement>(".wn-row[data-highlight]")].map((e) => e.dataset.person);
const announced = () => host.querySelector(".wn-notice[aria-live]")?.textContent ?? "";

describe("raccourci et bouton", () => {
  it("isSearchShortcut : Ctrl+K et ⌘K, ni Alt ni Maj ; libellé du bouton selon la plateforme", () => {
    const k = (init: Partial<KeyboardEvent>) => isSearchShortcut({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
    expect([k({ ctrlKey: true }), k({ metaKey: true }), k({ ctrlKey: true, key: "K" })]).toEqual([true, true, true]);
    expect([k({}), k({ ctrlKey: true, altKey: true }), k({ ctrlKey: true, shiftKey: true }), k({ ctrlKey: true, key: "j" })]).toEqual([false, false, false, false]);
    expect([searchShortcutLabel("MacIntel"), searchShortcutLabel("Linux x86_64")]).toEqual(["⌘K", "Ctrl K"]);
  });

  it("le bouton « Rechercher » de l'en-tête commun affiche le raccourci et ouvre la fenêtre, focus dans le champ ; le Planning n'en a plus", async () => {
    await mount();
    expect([...host.querySelectorAll(".wn-schedule button")].some((b) => /^Rechercher/.test(b.textContent ?? ""))).toBe(false);
    expect(searchButton().textContent).toMatch(/^Rechercher(Ctrl K|⌘K)$/);
    expect(searchButton().getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    await act(async () => { searchButton().click(); });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Rechercher");
    expect(document.activeElement).toBe(input());
  });

  it("Ctrl+K ouvre la fenêtre depuis la grille ; Échap la ferme et rend le focus à la grille", async () => {
    await mount();
    act(() => grid().focus());
    await press(grid(), { key: "k", ctrlKey: true });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    await press(input(), { key: "Escape" });
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(grid());
  });

  it("⌘K aussi ; un deuxième Ctrl+K dans la fenêtre ne la referme pas ni n'en ouvre une autre", async () => {
    await mount();
    await press(document.body, { key: "k", metaKey: true });
    await flush();
    await press(input(), { key: "k", ctrlKey: true });
    await flush();
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("sans focus dans la page, Échap rend le focus au bouton « Rechercher »", async () => {
    await mount();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await press(input(), { key: "Escape" });
    await flush();
    expect(document.activeElement).toBe(searchButton());
  });

  it("ignoré quand une autre fenêtre modale est ouverte ; un menu ancré (aria-modal=false) ne le bloque pas", async () => {
    await mount();
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    modal.setAttribute("aria-modal", "false");
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    modal.remove();
  });
});

describe("Ctrl+K selon l'endroit où se trouve le focus", () => {
  async function pressOn(el: HTMLElement) {
    const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { el.dispatchEvent(ev); });
    await flush();
    return ev;
  }
  const outside = (el: HTMLElement) => { document.body.appendChild(el); return el; };

  it("dans un champ de saisie (input) : la palette s'ouvre", async () => {
    await mount();
    const field = outside(document.createElement("input"));
    field.focus();
    const ev = await pressOn(field);
    expect(dialog()).not.toBeNull();
    expect(ev.defaultPrevented).toBe(true);
    field.remove();
  });

  it("dans une zone de texte (textarea) ou un élément contenteditable : ignoré, la touche garde son sens d'édition", async () => {
    await mount();
    const area = outside(document.createElement("textarea"));
    const ev1 = await pressOn(area);
    const editable = outside(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    const inner = editable.appendChild(document.createElement("span"));
    const ev2 = await pressOn(inner);
    expect([dialog(), ev1.defaultPrevented, ev2.defaultPrevented]).toEqual([null, false, false]);
    area.remove(); editable.remove();
  });

  it("contenteditable=\"false\" n'est pas une zone d'édition", async () => {
    await mount();
    const frozen = outside(document.createElement("div"));
    frozen.setAttribute("contenteditable", "false");
    await pressOn(frozen);
    expect(dialog()).not.toBeNull();
    frozen.remove();
  });

  it("événement déjà traité (defaultPrevented) : ignoré", async () => {
    await mount();
    const target = outside(document.createElement("button"));
    target.addEventListener("keydown", (e) => e.preventDefault());
    await pressOn(target);
    expect(dialog()).toBeNull();
    target.remove();
  });
});

describe("résultats", () => {
  it("« per » : personnes, sans casse ni accents ; sans onOpenProject, pas de groupe Projets", async () => {
    await mount();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("PERSONNE 4");
    expect(optionTexts()).toEqual(["Personne 4", "Personne 40", "Personne 14", "Personne 24", "Personne 34"]);
    expect(groupLabels()).toEqual(["Personnes"]);
    await type("projet");
    expect(optionTexts()).toEqual([]);
    expect(dialog()!.textContent).toContain("Aucun résultat");
  });

  it("sans résultat : aria-expanded du champ à false, « Aucun résultat » dans une région de statut qui reste la même ; il redevient true avec des résultats", async () => {
    await mount();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    const status = dialog()!.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("");
    await type("zzz");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(dialog()!.querySelector('[role="listbox"]')).toBeNull();
    expect(dialog()!.querySelector('[role="status"]')).toBe(status); // même nœud : la région existait avant le texte, il est annoncé
    expect(status.textContent).toBe("Aucun résultat");
    await type("personne 1");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(status.textContent).toBe("");
  });

  it("avec onOpenProject : groupes Personnes puis Projets", async () => {
    await mount({ onOpenProject: () => {} });
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("p");
    expect(groupLabels()).toEqual(["Personnes", "Projets"]);
    await type("projet c");
    expect(optionTexts()).toEqual(["Projet C"]);
  });

  it("EN : titre, groupes et état vide traduits", async () => {
    await mount({ locale: "en", onOpenProject: () => {} });
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("p");
    expect(groupLabels()).toEqual(["People", "Projects"]);
    await type("zzz");
    expect(dialog()!.textContent).toContain("No results");
  });
});

describe("choix", () => {
  it("personne lointaine (Entrée) : fenêtre fermée, ligne dessinée et en évidence, focus à la grille, annonce", async () => {
    await mount();
    expect(host.querySelector('.wn-row[data-person="40"]')).toBeNull();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("personne 40");
    expect(optionTexts()).toEqual(["Personne 40"]);
    await press(input(), { key: "Enter" });
    await flush();
    expect(dialog()).toBeNull();
    expect(lit()).toEqual(["40"]);
    expect(grid().scrollTop).toBeGreaterThan(0);
    expect(document.activeElement).toBe(grid());
    expect(announced()).toContain("Personne 40 : ligne affichée dans le planning");
  });

  it("personne choisie au clic : même effet", async () => {
    await mount();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("personne 33");
    await act(async () => { options()[0]!.click(); });
    await flush();
    expect(lit()).toEqual(["33"]);
  });

  /** Filtre « Département : Produit » posé par le panneau : la personne 2 (département 2) est écartée. */
  async function filterOnProduct() {
    const filtersButton = [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => /^Filtres/.test(b.textContent ?? ""))!;
    await act(async () => { filtersButton.click(); });
    const select = [...host.querySelectorAll<HTMLElement>(".wn-filter")].find((l) => l.firstElementChild?.textContent === "Département")!.querySelector("select")!;
    await act(async () => {
      for (const o of select.options) o.selected = o.textContent === "Produit";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    return select;
  }
  const count = () => Number(/(\d+) personnes?/.exec(host.querySelector(".wn-corner")!.textContent!)![1]); // compteur dans le coin de la grille (RT-061)
  const dialogButton = (label: string | RegExp) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? "")));
  const restoreButton = () => [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => b.textContent === "Rétablir les filtres");
  async function searchHidden() {
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("personne 2");
    const two = options().find((o) => o.textContent!.startsWith("Personne 2masquée"));
    expect(two?.textContent).toBe("Personne 2masquée par les filtres");
    expect(options().find((o) => o.textContent === "Personne 4")).toBeUndefined();
    await act(async () => { two!.click(); });
    await flush();
  }

  it("personne masquée par un filtre : l'option le dit ; la choisir demande confirmation, sans toucher aux filtres ni à la grille", async () => {
    await mount({ views: true });
    await filterOnProduct();
    expect(count()).toBe(14);
    await searchHidden();
    expect(dialog()!.textContent).toContain("Personne 2 est masquée par les filtres actuels");
    expect(dialogButton("Retirer les filtres et afficher Personne 2")).toBeDefined();
    expect(document.activeElement).toBe(dialogButton("Retirer les filtres et afficher Personne 2"));
    expect(count()).toBe(14);
    expect(lit()).toEqual([]);
    expect(restoreButton()).toBeUndefined();
  });

  it("Annuler (ou Échap) : retour à la liste, même recherche, focus dans le champ ; filtres intacts", async () => {
    await mount({ views: true });
    await filterOnProduct();
    await searchHidden();
    await act(async () => { dialogButton("Annuler")!.click(); });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(input().value).toBe("personne 2");
    expect(document.activeElement).toBe(input());
    expect(count()).toBe(14);
    // Deuxième tentative, abandonnée par Échap : une étape en arrière, la fenêtre reste ouverte.
    await act(async () => { options().find((o) => o.textContent!.startsWith("Personne 2masquée"))!.click(); });
    await flush();
    await press(document.activeElement!, { key: "Escape" });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(count()).toBe(14);
    expect(restoreButton()).toBeUndefined();
    await press(input(), { key: "Escape" });
    await flush();
    expect(dialog()).toBeNull();
  });

  it("confirmer : filtres retirés, ligne montrée et annoncée ; « Rétablir les filtres » restaure exactement les critères d'avant", async () => {
    await mount({ views: true });
    const select = await filterOnProduct();
    await searchHidden();
    await act(async () => { dialogButton("Retirer les filtres et afficher Personne 2")!.click(); });
    await flush();
    expect(dialog()).toBeNull();
    expect(count()).toBe(40);
    expect(host.querySelector(".wn-chip")).toBeNull();
    expect(lit()).toEqual(["2"]);
    expect(document.activeElement).toBe(grid());
    expect(announced()).toContain("filtres retirés");
    expect(restoreButton()).toBeDefined();
    await act(async () => { restoreButton()!.click(); });
    await flush();
    expect(count()).toBe(14);
    expect([...select.selectedOptions].map((o) => o.textContent)).toEqual(["Produit"]);
    expect(host.querySelector(".wn-chip")!.textContent).toContain("Produit");
    expect(restoreButton()).toBeUndefined();
    expect(announced()).toContain("Filtres rétablis");
  });

  it("« Rétablir les filtres » disparaît au prochain changement de filtre", async () => {
    await mount({ views: true });
    const select = await filterOnProduct();
    await searchHidden();
    await act(async () => { dialogButton(/^Retirer les filtres/)!.click(); });
    await flush();
    expect(restoreButton()).toBeDefined();
    await act(async () => {
      for (const o of select.options) o.selected = o.textContent === "Design";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(restoreButton()).toBeUndefined();
    expect(count()).toBe(13);
  });

  it("vue sauvegardée : « modifiée » après le retrait, état d'origine après le rétablissement ; un changement de vue enterre le bouton", async () => {
    await mount({ views: true });
    // Les vues sont en tête du panneau Filtres (RT-058), ouvert ici avant de choisir.
    const viewSelect = () => host.querySelector<HTMLSelectElement>(".wn-filters-panel .wn-views-pick select")!;
    const modified = () => host.querySelector(".wn-views-modified");
    if (!host.querySelector(".wn-filters-panel")) {
      await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => /^Filtres/.test(b.textContent ?? ""))!.click(); });
      await flush();
    }
    const choose = async (id: string) => {
      await act(async () => { viewSelect().value = id; viewSelect().dispatchEvent(new Event("change", { bubbles: true })); });
      await flush();
    };
    await choose("demo-view-1"); // Design seniors : département 2, rôle 1
    const before = count();
    expect(before).toBeLessThan(40);
    expect(modified()).toBeNull();
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("personne 1");
    const hidden = options().find((o) => o.textContent === "Personne 1masquée par les filtres")!;
    await act(async () => { hidden.click(); });
    await flush();
    await act(async () => { dialogButton(/^Retirer les filtres/)!.click(); });
    await flush();
    expect(count()).toBe(40);
    expect(modified()).not.toBeNull();
    await act(async () => { restoreButton()!.click(); });
    await flush();
    expect(count()).toBe(before);
    expect(modified()).toBeNull();
    expect(viewSelect().value).toBe("demo-view-1");
    // Nouveau retrait puis changement de vue : plus rien à rétablir.
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("personne 1");
    await act(async () => { options().find((o) => o.textContent === "Personne 1masquée par les filtres")!.click(); });
    await flush();
    await act(async () => { dialogButton(/^Retirer les filtres/)!.click(); });
    await flush();
    expect(restoreButton()).toBeDefined();
    await choose("demo-view-3");
    expect(restoreButton()).toBeUndefined();
  });

  it("projet : confié à onOpenProject avec son identifiant, rien n'est défilé", async () => {
    const open = vi.fn();
    await mount({ onOpenProject: open });
    await press(document.body, { key: "k", ctrlKey: true });
    await flush();
    await type("projet c");
    await press(input(), { key: "Enter" });
    await flush();
    expect(open).toHaveBeenCalledWith("3");
    expect(lit()).toEqual([]);
    expect(dialog()).toBeNull();
  });
});
