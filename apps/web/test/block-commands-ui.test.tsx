// @vitest-environment jsdom
// Commandes d'un bloc dans l'écran Schedule (RT-047, US-3.2) : supprimer (Suppr, Retour arrière, menu contextuel, drawer ; portée
// série et groupe dans l'étape du drawer), dupliquer (Ctrl+D, menu ; « Dupliquer… » du drawer ouvre la création préremplie,
// plusieurs personnes = une allocation par personne), scinder (S, menu, drawer : étape avec la date de la seconde partie). Chaque
// commande est annulable par Ctrl+Z et annoncée. Lecture seule et chef de projet hors de ses projets (BR-33) : aucune commande.
import type { Me, ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoSource } from "../src/data/demo-source";
import { createDemoProjectsSource } from "../src/data/projects-source";
import { createI18n } from "../src/i18n";
import { historyForSource } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: "à garder",
  startDate: "2026-10-20", endDate: "2026-10-23", status: "tentative" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 4, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], departments: [], roles: [], timeoffTypes: [],
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

interface Opts { readOnly?: boolean; me?: Pick<Me, "role" | "person">; managers?: Record<string, string> }
function mount(allocations: Alloc[], o: Opts = {}) {
  const initial = data(allocations);
  const src = createDemoSource(initial);
  const { history } = historyForSource(src);
  const catalog = createDemoProjectsSource(initial, {});
  if (o.managers) {
    const list = catalog.listProjects;
    catalog.listProjects = async () => { const r = await list(); return r.ok ? { ok: true, value: r.value.map((p) => ({ ...p, projectManagerId: o.managers![p.id] ?? null })) } : r; };
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      {...(o.readOnly ? {} : { editor: history.editor, history, records: src, catalog })} {...(o.me ? { me: o.me } : {})} />));
  render();
  src.subscribe(() => { queueMicrotask(render); });
  const rows = () => src.getState().data!.allocations;
  return { src, history, rows };
}

const block = (key: string) => host.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
const blocks = () => [...host.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((b) => b.style.display !== "none");
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const title = () => dialog()?.querySelector("h2")?.textContent;
const menu = () => document.querySelector<HTMLElement>("[role=menu]");
const items = () => [...(menu()?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
const item = (name: string) => items().find((x) => x.querySelector("[data-label]")?.textContent === name || x.textContent === name);
const button = (label: string) => [...(dialog() ?? document.body).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const click = async (el: HTMLElement) => { act(() => el.click()); await flush(); };
const notice = () => host.querySelector(".wn-notice")!.textContent;
const press = async (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(e); });
  await flush();
  return e;
};
const rightClick = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
const dblclick = async (el: Element) => { act(() => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); }); await flush(); };
const radios = () => [...(dialog()?.querySelectorAll<HTMLElement>("[role=radio]") ?? [])].map((r) => [r.parentElement!.textContent, r.getAttribute("aria-checked"), r.getAttribute("aria-disabled") ?? r.getAttribute("data-disabled") !== null ? "off" : "on"]);
const field = (label: string) => [...document.body.querySelectorAll("label")].find((l) => l.firstChild?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}
const shape = (a: Alloc) => [a.personId, a.startDate, a.endDate, a.projectId, a.notes, a.status, a.hoursPerDay];
const undo = () => press(document.body, { key: "z", ctrlKey: true });

describe("supprimer (Suppr, Retour arrière)", () => {
  it("Suppr sur un bloc : supprimé sans confirmation, annoncé, focus à la grille ; Ctrl+Z le rend avec ses champs", async () => {
    const { rows } = mount([alloc("a"), alloc("b", { personId: "2" })]);
    block("a:0").focus();
    const e = await press(block("a:0"), { key: "Delete" });
    expect(e.defaultPrevented).toBe(true);
    expect(dialog()).toBeNull();
    expect(rows().map((a) => a.id)).toEqual(["b"]);
    expect(notice()).toBe("Allocation supprimée. Ctrl+Z annule.");
    expect(document.activeElement).toBe(host.querySelector("[role=grid]"));
    await undo();
    expect(notice()).toBe("Suppression annulée.");
    expect(rows().map(shape)).toEqual([shape(alloc("b", { personId: "2" })), shape(alloc("a"))]);
  });

  it("Retour arrière fait de même ; hors d'un bloc (grille), rien", async () => {
    const { rows } = mount([alloc("a")]);
    await press(host.querySelector("[role=grid]")!, { key: "Delete" });
    expect(rows()).toHaveLength(1);
    block("a:0").focus();
    await press(block("a:0"), { key: "Backspace" });
    expect(rows()).toHaveLength(0);
  });

  it("série : étape « Que supprimer ? » dans le drawer (Cette occurrence choisie) ; Supprimer découpe, annoncé non annulable ; Annuler ferme sans rien écrire", async () => {
    const s = alloc("s", { startDate: "2026-10-20", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-10" });
    const { rows } = mount([s]);
    block("s:0").focus();
    await press(block("s:0"), { key: "Delete" });
    expect(title()).toBe("Supprimer l’allocation");
    expect(dialog()!.querySelector("legend")?.textContent).toBe("Cette allocation se répète. Que supprimer ?");
    expect(radios().map(([l, c]) => [l, c])).toEqual([["Cette occurrence", "true"], ["Toute la série", "false"]]);
    expect(document.activeElement?.getAttribute("role")).toBe("radio");
    await click(button("Annuler")!);
    expect([dialog(), rows()]).toEqual([null, [s]]);
    expect(document.activeElement).toBe(block("s:0"));
    await press(block("s:0"), { key: "Delete" });
    await click(button("Supprimer")!);
    expect(dialog()).toBeNull();
    expect(rows().map((a) => [a.startDate, a.repeatEndDate])).toEqual([["2026-10-27", "2026-11-10"]]);
    expect(notice()).toBe("Occurrence supprimée. La suppression d’une occurrence ne peut pas être annulée.");
  });

  it("groupe : « Tout le groupe » retire toutes les lignes, Ctrl+Z les rend ; « Cette ligne » ne retire qu'elle", async () => {
    const { rows } = mount([alloc("a", { groupId: "G" }), alloc("b", { personId: "2", groupId: "G" })]);
    block("a:0").focus();
    await press(block("a:0"), { key: "Delete" });
    expect(dialog()!.querySelector("legend")?.textContent).toBe("Cette allocation fait partie d’un groupe de 2 personnes. Que supprimer ?");
    expect(radios().map(([l, c]) => [l, c])).toEqual([["Cette ligne", "true"], ["Tout le groupe", "false"]]);
    act(() => { dialog()!.querySelectorAll<HTMLElement>("[role=radio]")[1]!.click(); });
    await click(button("Supprimer")!);
    expect(rows()).toEqual([]);
    expect(notice()).toBe("2 allocations supprimées. Ctrl+Z annule.");
    await undo();
    expect(rows().map((a) => a.personId).sort()).toEqual(["1", "2"]);
  });
});

describe("dupliquer (Ctrl+D) et scinder (S)", () => {
  it("Ctrl+D : copie juste après le bloc, mêmes champs, sélectionnée et focalisée ; Ctrl+Z la retire", async () => {
    const { rows } = mount([alloc("a")]);
    block("a:0").focus();
    const e = await press(block("a:0"), { key: "d", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(rows().map(shape)).toEqual([shape(alloc("a")), ["1", "2026-10-24", "2026-10-27", "1", "à garder", "tentative", 4]]);
    const copy = rows()[1]!;
    expect(notice()).toBe("Allocation dupliquée. Ctrl+Z annule.");
    expect(document.activeElement).toBe(block(`${copy.id}:0`));
    expect(block(`${copy.id}:0`).getAttribute("aria-selected")).toBe("true");
    await undo();
    expect(rows().map((a) => a.id)).toEqual(["a"]);
    expect(notice()).toBe("Duplication annulée.");
  });

  it("S : étape « Scinder » (date au milieu, parties décrites) ; Scinder crée deux allocations, Ctrl+Z les refond", async () => {
    const { rows } = mount([alloc("a")]);
    block("a:0").focus();
    await press(block("a:0"), { key: "s" });
    expect(title()).toBe("Scinder l’allocation");
    const date = field("Début de la seconde partie");
    expect(date.value).toBe("2026-10-22");
    expect(document.activeElement).toBe(date);
    expect(dialog()!.querySelector("[data-split-parts]")?.textContent).toBe("Première partie : du mar. 20 oct. au mer. 21 oct. ; seconde partie : du jeu. 22 oct. au ven. 23 oct.");
    type(date, "2026-10-21");
    await click(button("Scinder")!);
    expect(dialog()).toBeNull();
    expect(rows().map(shape)).toEqual([
      ["1", "2026-10-20", "2026-10-20", "1", "à garder", "tentative", 4], ["1", "2026-10-21", "2026-10-23", "1", "à garder", "tentative", 4],
    ]);
    expect(notice()).toBe("Allocation scindée en deux. Ctrl+Z annule.");
    await undo();
    expect(rows().map(shape)).toEqual([shape(alloc("a"))]);
    expect(notice()).toBe("Scission annulée.");
  });

  it("S : date hors du bloc refusée (message, rien écrit) ; bloc d'un jour ou série : annoncé, pas d'étape", async () => {
    const { rows } = mount([alloc("a"), alloc("j", { personId: "2", endDate: "2026-10-20" })]);
    block("a:0").focus();
    await press(block("a:0"), { key: "S" });
    type(field("Début de la seconde partie"), "2026-10-20");
    await click(button("Scinder")!);
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toBe("Choisissez un jour après le premier jour du bloc, au plus tard son dernier jour.");
    expect(rows()).toHaveLength(2);
    await click(button("Annuler")!);
    block("j:0").focus();
    await press(block("j:0"), { key: "s" });
    expect(dialog()).toBeNull();
    expect(notice()).toBe("Impossible de scinder un bloc d’un seul jour.");
  });
});

describe("menu contextuel et drawer", () => {
  it("menu du bloc : Dupliquer, Scinder…, Supprimer (raccourcis annoncés) puis le retrait du projet (BR-10)", async () => {
    const { rows } = mount([alloc("a")]);
    rightClick(block("a:0"));
    expect(items().map((x) => [x.querySelector("[data-label]")?.textContent ?? x.textContent, x.getAttribute("aria-keyshortcuts")])).toEqual([
      ["Dupliquer", "Control+D Meta+D"], ["Scinder…", "S"], ["Supprimer", "Delete Backspace"], ["Retirer Alice du projet Refonte…", null],
    ]);
    await click(item("Supprimer")!);
    expect(rows()).toEqual([]);
    expect(notice()).toBe("Allocation supprimée. Ctrl+Z annule.");
  });

  it("menu : Dupliquer crée la copie ; Scinder… ouvre l'étape ; bloc d'un jour : pas de Scinder…", async () => {
    const { rows } = mount([alloc("a"), alloc("j", { personId: "2", endDate: "2026-10-20" })]);
    rightClick(block("a:0"));
    await click(item("Dupliquer")!);
    expect(rows()).toHaveLength(3);
    rightClick(block("a:0"));
    await click(item("Scinder…")!);
    expect(title()).toBe("Scinder l’allocation");
    await click(button("Annuler")!);
    rightClick(block("j:0"));
    expect(item("Scinder…")).toBeUndefined();
  });

  it("drawer d'édition : Supprimer (danger) supprime et ferme ; Scinder… ouvre l'étape, Retour revient au formulaire", async () => {
    const { rows } = mount([alloc("a")]);
    await dblclick(block("a:0"));
    const group = dialog()!.querySelector<HTMLElement>("[role=group][aria-label='Actions sur l’allocation']")!;
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dupliquer…", "Scinder…", "Supprimer"]);
    await click(button("Scinder…")!);
    expect(title()).toBe("Scinder l’allocation");
    await click(button("Retour")!);
    expect(title()).toBe("Modifier l’allocation");
    await click(button("Supprimer")!);
    expect([dialog(), rows()]).toEqual([null, []]);
  });

  it("drawer : Dupliquer… ouvre la création préremplie ; deux personnes cochées : une allocation par personne (groupe), Ctrl+Z les retire", async () => {
    const { rows } = mount([alloc("a")]);
    await dblclick(block("a:0"));
    await click(button("Dupliquer…")!);
    expect(title()).toBe("Nouvelle allocation");
    expect([field("Du").value, field("Au").value]).toEqual(["2026-10-20", "2026-10-23"]);
    const bruno = [...dialog()!.querySelectorAll("label")].find((l) => l.textContent === "Bruno")!.querySelector("input")!;
    act(() => { bruno.click(); });
    await click(button("Créer")!);
    expect(rows().map(shape)).toEqual([shape(alloc("a")), ...["1", "2"].map((p) => [p, "2026-10-20", "2026-10-23", "1", "à garder", "tentative", 4])]);
    expect(new Set(rows().slice(1).map((a) => a.groupId)).size).toBe(1);
    await undo();
    expect(rows().map((a) => a.id)).toEqual(["a"]);
  });
});

describe("lecture seule (BR-33)", () => {
  it("sans écriture : ni Suppr, ni Ctrl+D, ni S, ni menu", async () => {
    mount([alloc("a")], { readOnly: true });
    block("a:0").focus();
    for (const k of [{ key: "Delete" }, { key: "d", ctrlKey: true }, { key: "s" }]) expect((await press(block("a:0"), k)).defaultPrevented).toBe(false);
    rightClick(block("a:0"));
    expect([menu(), dialog(), blocks().length]).toEqual([null, null, 1]);
  });

  it("chef de projet : commandes sur ses projets seulement (ni menu, ni touches, ni boutons du drawer ailleurs)", async () => {
    const { rows } = mount([alloc("a"), alloc("b", { personId: "2", projectId: "2" })], { me: { role: "project_manager", person: { id: "p9", name: "Moi" } }, managers: { "2": "p9" } });
    await flush();
    block("a:0").focus();
    await press(block("a:0"), { key: "Delete" });
    rightClick(block("a:0"));
    expect([rows().length, menu()]).toEqual([2, null]);
    await dblclick(block("a:0"));
    expect(dialog()!.querySelector("[role=group][aria-label='Actions sur l’allocation']")).toBeNull();
    await click(button("Annuler")!);
    block("b:0").focus();
    await press(block("b:0"), { key: "Delete" });
    expect(rows().map((a) => a.id)).toEqual(["a"]);
  });
});
