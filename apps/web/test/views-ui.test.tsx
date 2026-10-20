// @vitest-environment jsdom
// Vues sauvegardées dans l'écran Schedule : lignes filtrées côté client, choix d'une vue, enregistrement (nom, partagée),
// mise à jour, renommage, suppression avec confirmation, erreurs traduites, reflet dans l'URL (?view=).
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { demoSchedule } from "../src/demo";
import { createDemoViewsSource, demoSeedViews, type ViewsSource } from "../src/data/views-source";
import { createI18n } from "../src/i18n";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
void DEFAULT_PX_PER_DAY;

const TODAY = "2026-10-20";
let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; frames.length = 0; history.replaceState(null, "", "/"); });

async function mount(views: ViewsSource = createDemoViewsSource(demoSeedViews(), memory())) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // 12 personnes : départements 1, 2, 3 en rotation (4 chacun), rôles par blocs de trois.
  const data = demoSchedule(TODAY, 12);
  act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={data} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock} views={views} />));
  await flush();
  return views;
}

// Grille virtualisée : le nombre de personnes se lit dans la barre d'outils (les lignes DOM ne sont que celles de la fenêtre).
const rows = () => [...host.querySelectorAll("[role=rowheader]")].map((e) => e.textContent).filter(Boolean); // lignes recyclées vides écartées
const count = () => Number(/(\d+) personnes?/.exec(host.querySelector("[role=toolbar]")!.textContent!)![1]);
const viewSelect = () => host.querySelector<HTMLSelectElement>(".wn-views-row select")!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".wn-views button")].find((b) => b.textContent === label);
const status = () => host.querySelector(".wn-views [role=status]")!.textContent;
const optionNames = () => [...viewSelect().options].map((o) => o.textContent);
const zoomPressed = () => [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] [aria-pressed=true]")].map((b) => b.textContent);

async function choose(id: string) {
  await act(async () => { viewSelect().value = id; viewSelect().dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
}
async function pickOptions(label: string, values: string[]) {
  const select = [...host.querySelectorAll<HTMLElement>(".wn-filter")].find((l) => l.firstElementChild?.textContent === label)!.querySelector("select")!;
  await act(async () => {
    for (const o of select.options) o.selected = values.includes(o.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function click(b: HTMLButtonElement | undefined) { await act(async () => { b!.click(); }); await flush(); }
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function saveCurrent(name: string, shared = false) {
  await click(button("Enregistrer la vue…"));
  await type(host.querySelector<HTMLInputElement>(".wn-views-form input[type=text]")!, name);
  if (shared) await act(async () => { host.querySelector<HTMLInputElement>(".wn-views-form input[type=checkbox]")!.click(); });
  await click(button("Enregistrer"));
}

describe("vues sauvegardées dans l'écran", () => {
  it("par défaut « Tout le monde » : toutes les lignes, vues de la source listées (partagées signalées)", async () => {
    await mount();
    expect(count()).toBe(12);
    expect(viewSelect().value).toBe("");
    expect(optionNames()).toEqual(["Tout le monde", "Design seniors (partagée)", "Projet A", "Équipe Produit par rôle (partagée)"]);
  });

  it("un filtre de département réduit les lignes, le résumé des filtres et le compteur de personnes suivent ; « Effacer » les rend", async () => {
    await mount();
    await pickOptions("Département", ["2"]);
    expect(count()).toBe(4);
    expect(rows()).toEqual(["Personne 2", "Personne 5", "Personne 8", "Personne 11"]);
    expect(host.querySelector(".wn-filters summary")!.textContent).toBe("Filtres (1)");
    expect(host.querySelector("[role=toolbar]")!.textContent).toContain("4 personnes");
    await pickOptions("Rôle", ["1"]);
    expect(count()).toBeLessThan(4);
    await click(button("Effacer les filtres"));
    expect(count()).toBe(12);
  });

  it("choisir une vue applique ses filtres et son zoom, annonce le résultat ; « Tout le monde » revient à tout", async () => {
    await mount();
    await choose("demo-view-2"); // projet A, zoom semaine
    expect(zoomPressed()).toEqual(["Semaine"]);
    expect(count()).toBeLessThan(12);
    expect(status()).toMatch(/Vue « Projet A » appliquée, \d+ personnes?\./);
    expect(new URLSearchParams(location.search).get("view")).toBe("demo-view-2");
    await choose("");
    expect(count()).toBe(12);
    expect(status()).toBe("Tout le monde affiché.");
    expect(new URLSearchParams(location.search).has("view")).toBe(false);
  });

  it("une vue modifiée est signalée, et « Mettre à jour la vue » l'enregistre", async () => {
    const views = await mount();
    await choose("demo-view-1");
    expect(host.querySelector(".wn-views-modified")).toBeNull();
    expect(button("Mettre à jour la vue")!.disabled).toBe(true);
    await pickOptions("Département", ["1", "2"]);
    expect(host.querySelector(".wn-views-modified")!.textContent).toBe("Modifications non enregistrées");
    await click(button("Mettre à jour la vue"));
    expect(status()).toBe("Vue « Design seniors » mise à jour.");
    expect(host.querySelector(".wn-views-modified")).toBeNull();
    const list = await views.list();
    expect(list.ok && list.value.find((v) => v.id === "demo-view-1")).toMatchObject({ version: 2, filters: { departmentIds: ["1", "2"] } });
  });

  it("enregistre la vue courante (nom, partagée), la sélectionne et la met dans l'URL", async () => {
    const views = await mount();
    await pickOptions("Département", ["3"]);
    await saveCurrent("Ingénierie", true);
    expect(status()).toBe("Vue « Ingénierie » enregistrée.");
    expect(viewSelect().selectedOptions[0]!.textContent).toBe("Ingénierie (partagée)");
    expect(host.querySelector(".wn-views-form")).toBeNull();
    const list = await views.list();
    const saved = list.ok && list.value.find((v) => v.name === "Ingénierie");
    expect(saved).toMatchObject({ shared: true, filters: { departmentIds: ["3"], zoom: "day" } });
    expect(new URLSearchParams(location.search).get("view")).toBe((saved as { id: string }).id);
  });

  it("nom déjà pris : erreur traduite, le formulaire reste ouvert ; Échap l'annule", async () => {
    await mount();
    await saveCurrent("Projet A");
    expect(status()).toBe("Une de vos vues porte déjà ce nom.");
    expect(host.querySelector(".wn-views-form")).not.toBeNull();
    await act(async () => { host.querySelector(".wn-views-form input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector(".wn-views-form")).toBeNull();
  });

  it("renomme, puis supprime après confirmation", async () => {
    await mount();
    await choose("demo-view-2");
    await click(button("Renommer…"));
    expect(host.querySelector<HTMLInputElement>(".wn-views-form input[type=text]")!.value).toBe("Projet A");
    await type(host.querySelector<HTMLInputElement>(".wn-views-form input[type=text]")!, "Projet Alpha");
    await click(button("Renommer"));
    expect(status()).toBe("Vue renommée en « Projet Alpha ».");
    expect(optionNames()).toContain("Projet Alpha");
    await click(button("Supprimer…"));
    expect(host.querySelector(".wn-views-form")!.textContent).toContain("Supprimer la vue « Projet Alpha » ?");
    await click(button("Supprimer"));
    expect(status()).toBe("Vue « Projet Alpha » supprimée.");
    expect(optionNames()).not.toContain("Projet Alpha");
    expect(viewSelect().value).toBe("");
  });

  it("une vue que l'on ne peut pas gérer n'offre ni mise à jour, ni renommage, ni suppression", async () => {
    await mount();
    await choose("demo-view-3");
    expect(button("Renommer…")).toBeUndefined();
    expect(button("Supprimer…")).toBeUndefined();
    expect(button("Mettre à jour la vue")).toBeUndefined();
    expect(button("Enregistrer la vue…")).toBeDefined();
  });

  it("?view=<id> à l'ouverture applique la vue (rechargement) ; id inconnu ignoré", async () => {
    history.replaceState(null, "", "/?view=demo-view-1");
    await mount();
    expect(viewSelect().value).toBe("demo-view-1");
    expect(count()).toBeLessThan(12);
    act(() => root!.unmount());
    host.remove();
    history.replaceState(null, "", "/?view=nope");
    await mount();
    expect(viewSelect().value).toBe("");
    expect(count()).toBe(12);
  });

  it("sans source de vues, ni barre ni filtres", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={demoSchedule(TODAY, 3)} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock} />));
    await flush();
    expect(host.querySelector(".wn-views")).toBeNull();
    expect(count()).toBe(3);
  });

  it("source en échec au chargement : message d'indisponibilité, l'écran reste utilisable", async () => {
    const down: ViewsSource = { ...createDemoViewsSource([], memory()), list: async () => ({ ok: false, error: "INTERNAL_ERROR" }) };
    await mount(down);
    expect(status()).toBe("Vues indisponibles.");
    expect(count()).toBe(12);
  });
});
