// @vitest-environment jsdom
// Pop-in du créneau dans l'écran Schedule (RT-011, RT-013 à RT-018) : ouverture au double clic, changement de projet et de
// tâche par le référentiel puis annulation, création multi-personnes (groupe BR-26), contrôles, bloc provisoire annulé par
// Échap, onglet Congé (BR-04), couleur du projet, droits BR-33, erreurs traduites, surcharge signalée, onglets au clavier.
import type { Me, ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoProjectsSource } from "../src/data/projects-source";
import { createDemoSource } from "../src/data/demo-source";
import { demoTasks } from "../src/demo";
import { createI18n } from "../src/i18n";
import { scheduleProjectOf } from "../src/projects/projects-model";
import { historyForSource } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], departments: [], roles: [],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }],
  projects: [
    { id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null },
    { id: "2", version: 1, name: "Audit", projectCode: null, color: "#16A34A", status: "in_progress", nonBillable: false, startDate: null, endDate: null },
  ],
});

let root: Root | null = null;
let host: HTMLElement;
const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; document.body.innerHTML = ""; });

function mount(allocations: Alloc[], opts: { me?: Pick<Me, "role" | "person">; managers?: Record<string, string>; failWith?: "FORBIDDEN" } = {}) {
  const initial = data(allocations);
  const src = createDemoSource(initial);
  if (opts.failWith) src.updateAllocation = async () => ({ ok: false, error: opts.failWith! });
  const catalog = createDemoProjectsSource(initial, { onProject: (p) => src.projectChanged?.(scheduleProjectOf(p)) }, demoTasks(initial));
  if (opts.managers) {
    const list = catalog.listProjects;
    catalog.listProjects = async () => { const r = await list(); return r.ok ? { ok: true, value: r.value.map((p) => ({ ...p, projectManagerId: opts.managers![p.id] ?? null })) } : r; };
  }
  const { history } = historyForSource(src);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      editor={history.editor} history={history} records={src} catalog={catalog} {...(opts.me ? { me: opts.me } : {})} />));
  render();
  src.subscribe(() => { queueMicrotask(render); });
  return { src, history };
}

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const title = () => dialog()?.querySelector("h2")?.textContent;
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const click = async (label: string) => { act(() => button(label)!.click()); await flush(); };
const notice = () => document.body.querySelector(".wn-notice")!.textContent;
const block = (key: string) => host.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
const combo = (label: string) => [...document.body.querySelectorAll<HTMLLabelElement>(".wn-combobox label")].find((l) => l.textContent === label)!
  .parentElement!.querySelector<HTMLInputElement>("input")!;
const field = (label: string) => [...document.body.querySelectorAll("label")].find((l) => l.firstChild?.textContent === label)!.querySelector<HTMLInputElement | HTMLSelectElement>("input, select, textarea")!;
function type(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    // Frappe réelle (inputType) : la Combobox Base UI n'ouvre pas sa liste sur un remplissage automatique.
    el.dispatchEvent(el instanceof HTMLSelectElement ? new Event("change", { bubbles: true }) : new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}
const key = (target: Element, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
/** Choisit `name` dans une Combobox : taper filtre, Entrée prend la première option. */
async function choose(label: string, query: string) {
  const input = combo(label);
  act(() => input.focus());
  type(input, query);
  key(input, "Enter");
  await flush();
}
/** Options proposées par une Combobox : liste ouverte par Flèche bas (portail Base UI), puis refermée par Échap. */
const options = async (label: string) => {
  const input = combo(label);
  act(() => input.focus());
  key(input, "ArrowDown");
  await flush();
  const list = [...document.body.querySelectorAll("[role=listbox] [role=option]")].map((o) => o.textContent);
  key(input, "Escape");
  await flush();
  return list;
};
const dblclick = async (el: Element) => { act(() => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); }); await flush(); };
const submit = async () => { act(() => { dialog()!.querySelector("form")!.requestSubmit(); }); await flush(); };
/** Création au clavier : touche N sur la grille (le bouton « + Allocation » est retiré, RT-060). */
const newAllocation = async () => { const g = host.querySelector<HTMLElement>("[role=grid]")!; act(() => g.focus()); key(g, "n"); await flush(); };

describe("édition d'un bloc (RT-011, RT-013, RT-014)", () => {
  it("double clic : pop-in ancrée, onglet Projet / tâche, champs du bloc", async () => {
    mount([alloc("a")]);
    await dblclick(block("a:0"));
    expect(title()).toBe("Modifier l’allocation");
    expect([...dialog()!.querySelectorAll("[role=tab]")].map((x) => [x.textContent, x.getAttribute("aria-selected")])).toEqual([["Projet / tâche", "true"], ["Congé", "false"]]);
    expect([combo("Personne").value, combo("Projet").value, combo("Tâche").value, field("Du").value, field("Au").value, field("Heures par jour").value])
      .toEqual(["Alice", "Refonte", "Sans tâche", "2026-10-20", "2026-10-21", "8"]);
  });

  it("passer au projet Audit et à sa tâche : bloc mis à jour, annoncé ; Ctrl+Z rend projet et tâche d'origine", async () => {
    const { src, history } = mount([alloc("a")]);
    await dblclick(block("a:0"));
    await choose("Projet", "aud");
    expect(combo("Projet").value).toBe("Audit");
    expect(await options("Tâche")).toEqual(["Sans tâche", "Conception", "Réalisation"]);
    await choose("Tâche", "concep");
    await submit();
    expect(dialog()).toBeNull();
    expect(src.getState().data!.allocations[0]).toMatchObject({ projectId: "2", taskId: "t2-1", version: 2 });
    expect(notice()).toBe("Allocation modifiée. Ctrl+Z annule.");
    await act(async () => { await history.undo(); });
    expect(src.getState().data!.allocations[0]).toMatchObject({ projectId: "1", taskId: null });
  });

  it("refus de l'API : message traduit dans la pop-in, restée ouverte", async () => {
    mount([alloc("a")], { failWith: "FORBIDDEN" });
    await dblclick(block("a:0"));
    type(field("Heures par jour") as HTMLInputElement, "6");
    await submit();
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toBe("Vous n’avez pas le droit d’écrire sur ce projet.");
  });

  it("surcharge signalée, jamais bloquante (BR-01)", async () => {
    const { src } = mount([alloc("a"), alloc("b", { projectId: "2", hoursPerDay: 4 })]);
    await dblclick(block("a:0"));
    expect(dialog()!.querySelector("[role=status]")?.textContent).toBe("Surcharge : Alice dépasse sa capacité sur cette période (signalé, permis).");
    await submit();
    expect(dialog()).toBeNull();
    expect(src.getState().data!.allocations).toHaveLength(2);
  });

  it("BR-33 : un chef de projet ne voit que ses projets (et celui du bloc) ; pas de couleur sur un projet qu'il ne gère pas", async () => {
    mount([alloc("a")], { me: { role: "project_manager", person: { id: "p9", name: "Moi" } }, managers: { "2": "p9" } });
    await dblclick(block("a:0"));
    await flush();
    expect(await options("Projet")).toEqual(["Audit", "Refonte"]);
    expect(button("Couleur du projet…")).toBeUndefined();
    await choose("Projet", "aud");
    expect(button("Couleur du projet…")).toBeDefined();
  });
});

describe("création (RT-015, RT-016)", () => {
  it("touche N (RT-060) pour deux personnes : un groupe, deux blocs ; Ctrl+Z retire les deux", async () => {
    const { src, history } = mount([]);
    await newAllocation();
    expect(title()).toBe("Nouvelle allocation");
    // N prérempli la première ligne visible (Alice) : on ajoute Bruno.
    act(() => { [...dialog()!.querySelectorAll<HTMLInputElement>(".wn-slot-people input[type=checkbox]")].find((b) => !b.checked)!.click(); });
    expect(dialog()!.textContent).toContain("2 personnes sélectionnées");
    await choose("Projet", "ref");
    expect(field("Heures par jour").value).toBe("8");
    await submit();
    const rows = src.getState().data!.allocations;
    expect(rows.map((a) => a.personId).sort()).toEqual(["1", "2"]);
    expect(new Set(rows.map((a) => a.groupId)).size).toBe(1);
    expect(notice()).toBe("2 allocations créées (groupe). Ctrl+Z annule.");
    await act(async () => { await history.undo(); });
    expect(src.getState().data!.allocations).toEqual([]);
  });

  it("sans personne ni projet : contrôles affichés, rien d'écrit", async () => {
    const { src } = mount([]);
    await newAllocation();
    // La personne préremplie par N (Alice) est décochée.
    act(() => { dialog()!.querySelector<HTMLInputElement>(".wn-slot-people input:checked")!.click(); });
    await submit();
    expect([...dialog()!.querySelectorAll("[role=alert] li")].map((l) => l.textContent)).toEqual(["Choisissez au moins une personne.", "Choisissez un projet."]);
    expect(src.getState().data!.allocations).toEqual([]);
  });

  it("clic en zone libre : bloc provisoire et pop-in de création sur la ligne ; Échap retire tout, rien n'est créé", async () => {
    const { src } = mount([]);
    const row = host.querySelector(".wn-row")!;
    // jsdom : la surface est en (0, 0) quel que soit le défilement ; l'en-tête de colonne du jour donne son abscisse.
    const x = Number(/translateX\((\d+)px\)/.exec(host.querySelector<HTMLElement>(`.wn-colheader[data-from="${TODAY}"]`)!.style.transform)![1]) + 5;
    const ptr = (type: string, target: EventTarget) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 5, button: 0 });
      Object.defineProperty(e, "pointerId", { value: 1 });
      Object.defineProperty(e, "pointerType", { value: "mouse" });
      target.dispatchEvent(e);
    };
    act(() => { ptr("pointerdown", row); ptr("pointerup", document); });
    await flush();
    expect(title()).toBe("Nouvelle allocation");
    expect(host.querySelector<HTMLElement>(".wn-slot-draft")!.style.display).toBe("");
    const checked = [...dialog()!.querySelectorAll<HTMLInputElement>(".wn-slot-people input:checked")].map((b) => b.parentElement!.textContent);
    expect(checked).toEqual(["Alice"]);
    expect([field("Du").value, field("Au").value]).toEqual([TODAY, TODAY]);
    key(dialog()!, "Escape");
    await flush();
    expect(dialog()).toBeNull();
    expect(host.querySelector<HTMLElement>(".wn-slot-draft")!.style.display).toBe("none");
    expect(src.getState().data!.allocations).toEqual([]);
    expect(document.activeElement).toBe(host.querySelector("[role=grid]"));
  });
});

describe("onglet Congé (RT-017) et couleur (RT-018)", () => {
  it("flèche droite sur les onglets : Congé, prérempli (personne, dates du bloc) ; BR-04 avertit, « Garder tel quel » pose le congé", async () => {
    const { src } = mount([alloc("a")]);
    await dblclick(block("a:0"));
    const tab = dialog()!.querySelector<HTMLElement>("[role=tab][aria-selected=true]")!;
    act(() => tab.focus());
    key(tab, "ArrowRight");
    await flush();
    expect(document.activeElement?.textContent).toBe("Congé");
    expect(title()).toBe("Nouveau congé");
    expect([field("Personne").value, field("Du").value, field("Au").value]).toEqual(["1", "2026-10-20", "2026-10-21"]);
    await submit();
    expect(title()).toBe("Ce congé recouvre des allocations de Alice");
    expect(dialog()!.querySelector("[role=tablist]")).toBeNull();
    await click("Garder tel quel");
    expect(dialog()).toBeNull();
    expect(src.getState().data!.timeoffs).toHaveLength(1);
    expect(src.getState().data!.allocations.map((a) => `${a.startDate}..${a.endDate}`)).toEqual(["2026-10-20..2026-10-21"]);
  });

  it("couleur du projet depuis un bloc : tous les blocs du projet changent", async () => {
    const { src } = mount([alloc("a"), alloc("b", { personId: "2" }), alloc("c", { projectId: "2", startDate: "2026-10-22", endDate: "2026-10-22" })]);
    await flush();
    const before = block("c:0").style.backgroundColor;
    const beforeA = block("a:0").style.backgroundColor;
    await dblclick(block("a:0"));
    await flush();
    await click("Couleur du projet…");
    act(() => { dialog()!.querySelector<HTMLButtonElement>(".wn-swatch:not([data-selected])")!.click(); });
    const chosen = dialog()!.querySelector<HTMLButtonElement>(".wn-swatch[data-selected]")!.getAttribute("aria-label");
    await click("Appliquer la couleur");
    await flush();
    const color = src.getState().data!.projects.find((p) => p.id === "1")!.color;
    expect(chosen).toContain(color);
    expect(notice()).toBe("Couleur du projet Refonte changée : tous ses blocs suivent.");
    expect(block("a:0").style.backgroundColor).toBe(block("b:0").style.backgroundColor);
    expect(block("a:0").style.backgroundColor).not.toBe(beforeA);
    expect(block("c:0").style.backgroundColor).toBe(before);
  });
});

describe("portée à l'enregistrement : série et groupe (RT-042, PO-08)", () => {
  const series = () => alloc("s", { startDate: "2026-10-20", endDate: "2026-10-20", repeatState: "daily", repeatEndDate: "2026-10-23" });
  const group = () => [alloc("g1", { groupId: "G" }), alloc("g2", { personId: "2", groupId: "G" })];
  const legend = () => dialog()!.querySelector("[role=radiogroup]") && dialog()!.querySelector("legend")?.textContent;
  const radio = (label: string) => [...dialog()!.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))?.querySelector<HTMLElement>("[role=radio]");
  const checked = () => dialog()!.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.closest("label")?.textContent;
  const pick = async (label: string) => { act(() => radio(label)!.click()); await flush(); };
  const rows = (src: ReturnType<typeof mount>["src"]) => src.getState().data!.allocations
    .map((a) => `${a.startDate}..${a.endDate} ${a.repeatState === "none" ? "-" : `${a.repeatState}->${a.repeatEndDate}`} ${a.hoursPerDay}h p${a.projectId}`).sort();

  it("série ouverte sur une occurrence : ses dates ; « Cette occurrence » choisie et focalisée ; Confirmer la découpe, annoncée non annulable", async () => {
    const { src, history } = mount([series()]);
    await dblclick(block("s:1"));
    expect([field("Du").value, field("Au").value]).toEqual(["2026-10-21", "2026-10-21"]);
    type(field("Heures par jour"), "4");
    await submit();
    expect(legend()).toBe("Cette allocation se répète. Que modifier ?");
    expect(checked()).toBe("Cette occurrence");
    expect(document.activeElement).toBe(radio("Cette occurrence"));
    expect(rows(src)).toEqual(["2026-10-20..2026-10-20 daily->2026-10-23 8h p1"]);
    await click("Confirmer");
    expect(dialog()).toBeNull();
    expect(rows(src)).toEqual([
      "2026-10-20..2026-10-20 daily->2026-10-20 8h p1", "2026-10-21..2026-10-21 - 4h p1", "2026-10-22..2026-10-22 daily->2026-10-23 8h p1",
    ]);
    expect(notice()).toBe("Occurrence modifiée. La découpe d’une occurrence ne peut pas être annulée.");
    expect(history.getState().canUndo).toBe(false);
  });

  it("« Toute la série » : la série se décale comme l'occurrence ; Ctrl+Z la rend", async () => {
    const { src, history } = mount([series()]);
    await dblclick(block("s:1"));
    type(field("Du"), "2026-10-22");
    type(field("Au"), "2026-10-22");
    await submit();
    await pick("Toute la série");
    await click("Confirmer");
    // La fin de série suit le déplacement (comme un geste) : la série garde ses quatre occurrences.
    expect(rows(src)).toEqual(["2026-10-21..2026-10-21 daily->2026-10-24 8h p1"]);
    expect(notice()).toBe("Allocation modifiée. Ctrl+Z annule.");
    await act(async () => { await history.undo(); });
    expect(rows(src)).toEqual(["2026-10-20..2026-10-20 daily->2026-10-23 8h p1"]);
  });

  it("série mensuelle, dates d'une occurrence changées : « Toute la série » indisponible avec la raison ; « Cette occurrence » reste possible", async () => {
    const { src } = mount([alloc("m", { startDate: "2026-09-21", endDate: "2026-09-21", repeatState: "monthly", repeatEndDate: "2027-01-31" })]);
    await dblclick(block("m:1"));
    type(field("Du"), "2026-10-22");
    type(field("Au"), "2026-10-22");
    await submit();
    expect(radio("Toute la série")!.getAttribute("aria-disabled")).toBe("true");
    expect(dialog()!.textContent).toContain("Indisponible : une série mensuelle ne se déplace que depuis sa première occurrence.");
    expect(checked()).toBe("Cette occurrence");
    await click("Confirmer");
    expect(rows(src)).toContain("2026-10-22..2026-10-22 - 8h p1");
  });

  it("aucun choix possible (série mensuelle aux blocs chevauchants, dates changées) : l'étape le dit, Confirmer est désactivé", async () => {
    const { src } = mount([alloc("m", { startDate: "2026-09-21", endDate: "2026-10-30", repeatState: "monthly", repeatEndDate: "2027-01-31" })]);
    await dblclick(block("m:1"));
    expect([field("Du").value, field("Au").value]).toEqual(["2026-10-21", "2026-11-30"]);
    type(field("Du"), "2026-10-22");
    await submit();
    expect([radio("Cette occurrence")!.getAttribute("aria-disabled"), radio("Toute la série")!.getAttribute("aria-disabled")]).toEqual(["true", "true"]);
    expect(dialog()!.querySelector("[role=status]")?.textContent).toBe("Aucun choix possible pour cette modification : revenez au formulaire pour l’ajuster.");
    expect(button("Confirmer")!.disabled).toBe(true);
    expect(src.getState().data!.allocations).toHaveLength(1);
  });

  it("Échap ou Retour dans l'étape : retour au formulaire, sans question ni écriture ; rien de changé : pas d'étape", async () => {
    const { src } = mount([series()]);
    await dblclick(block("s:1"));
    type(field("Heures par jour"), "4");
    await submit();
    key(dialog()!, "Escape");
    await flush();
    expect(document.body.querySelector("[role=alertdialog]")).toBeNull();
    expect(field("Heures par jour").value).toBe("4");
    expect(document.activeElement?.textContent).toBe("Enregistrer");
    await submit();
    await click("Retour");
    expect(field("Heures par jour").value).toBe("4");
    type(field("Heures par jour"), "8");
    await submit();
    expect(dialog()).toBeNull();
    expect(rows(src)).toEqual(["2026-10-20..2026-10-20 daily->2026-10-23 8h p1"]);
  });

  it("ligne d'un groupe : « Cette ligne » par défaut ; « Tout le groupe » change chaque ligne ; Ctrl+Z les rend toutes", async () => {
    const { src, history } = mount(group());
    await dblclick(block("g1:0"));
    await choose("Projet", "aud");
    await submit();
    expect(legend()).toBe("Cette allocation fait partie d’un groupe de 2 personnes. Que modifier ?");
    expect(checked()).toBe("Cette ligne");
    await pick("Tout le groupe");
    await click("Confirmer");
    expect(dialog()).toBeNull();
    expect(src.getState().data!.allocations.map((a) => [a.id, a.projectId])).toEqual([["g1", "2"], ["g2", "2"]]);
    expect(notice()).toBe("Groupe modifié : 2 allocations. Ctrl+Z annule.");
    await act(async () => { await history.undo(); });
    expect(src.getState().data!.allocations.map((a) => [a.id, a.projectId])).toEqual([["g1", "1"], ["g2", "1"]]);
  });

  it("groupe : charge et statut changés ensemble, « Tout le groupe » indisponible (raison donnée) ; charge seule : pas d'étape, cette ligne", async () => {
    const { src } = mount(group());
    await dblclick(block("g1:0"));
    type(field("Heures par jour"), "6");
    type(field("Statut"), "tentative");
    await submit();
    expect(radio("Tout le groupe")!.getAttribute("aria-disabled")).toBe("true");
    expect(dialog()!.textContent).toContain("Indisponible : la personne et la charge sont propres à chaque ligne.");
    await click("Confirmer");
    expect(src.getState().data!.allocations.map((a) => [a.id, a.hoursPerDay, a.status])).toEqual([["g1", 6, "tentative"], ["g2", 8, "confirmed"]]);

    await dblclick(block("g2:0"));
    type(field("Heures par jour"), "3");
    await submit();
    expect(dialog()).toBeNull();
    expect(src.getState().data!.allocations.map((a) => [a.id, a.hoursPerDay])).toEqual([["g1", 6], ["g2", 3]]);
  });
});

describe("éditeur en drawer (RT-024, Q8) et formulaire modifié (Q7)", () => {
  const alert = () => document.body.querySelector<HTMLElement>("[role=alertdialog]");

  it("édition et création s'ouvrent dans le même drawer latéral, jamais dans une modale ancrée", async () => {
    mount([alloc("a")]);
    await dblclick(block("a:0"));
    expect(dialog()!.dataset.variant).toBe("drawer");
    expect(dialog()!.style.position).toBe("");
    await click("Annuler");
    await newAllocation();
    expect(title()).toBe("Nouvelle allocation");
    expect(dialog()!.dataset.variant).toBe("drawer");
  });

  it("formulaire intact : Échap ferme sans question ; modifié : Échap demande « Abandonner les modifications ? »", async () => {
    const { src } = mount([alloc("a")]);
    await dblclick(block("a:0"));
    type(field("Heures par jour"), "6");
    key(dialog()!, "Escape");
    await flush();
    expect(alert()?.querySelector("h2")?.textContent).toBe("Abandonner les modifications ?");
    expect(dialog()).not.toBeNull();
    await click("Continuer");
    expect(alert()).toBeNull();
    expect(field("Heures par jour").value).toBe("6");
    key(dialog()!, "Escape");
    await flush();
    await click("Abandonner");
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(src.getState().data!.allocations[0]).toMatchObject({ hoursPerDay: 8, version: 1 });
  });

  it("revenir à la valeur d'origine rend le formulaire intact ; × sur un formulaire modifié demande aussi", async () => {
    mount([alloc("a")]);
    await dblclick(block("a:0"));
    type(field("Heures par jour"), "6");
    type(field("Heures par jour"), "8");
    key(dialog()!, "Escape");
    await flush();
    expect(alert()).toBeNull();
    expect(dialog()).toBeNull();
    await dblclick(block("a:0"));
    type(field("Au"), "2026-10-23");
    act(() => dialog()!.querySelector<HTMLButtonElement>("button[aria-label='Fermer la fenêtre']")!.click());
    await flush();
    expect(alert()).not.toBeNull();
  });

  it("onglet Congé modifié : Échap demande ; avertissement BR-04 : Échap revient au formulaire sans question", async () => {
    mount([alloc("a")]);
    await dblclick(block("a:0"));
    act(() => dialog()!.querySelector<HTMLButtonElement>("[role=tab]:not([aria-selected=true])")!.click());
    await flush();
    expect(title()).toBe("Nouveau congé");
    type(field("Au"), "2026-10-22");
    key(dialog()!, "Escape");
    await flush();
    expect(alert()).not.toBeNull();
    await click("Continuer");
    await click("Enregistrer");
    expect(title()).toBe("Ce congé recouvre des allocations de Alice");
    key(dialog()!, "Escape");
    await flush();
    expect(alert()).toBeNull();
    expect(title()).toBe("Nouveau congé");
  });
});
