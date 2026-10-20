// @vitest-environment jsdom
// Retirer une personne d'un projet depuis le Schedule (BR-10) : menu contextuel d'un bloc (clic droit, touche Menu ou
// Maj+F10) -> « Retirer … du projet … » -> récapitulatif (allocations, dates, temps saisis et heures) -> confirmation ->
// suppression annoncée. État changé entre-temps : message et nouveau récapitulatif, rien supprimé. Temps verrouillés :
// retrait impossible, pas de bouton. Échap ferme et rend le focus. Démo locale comme source.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoSource } from "../src/data/demo-source";
import type { RemovalSummary } from "../src/data/team-removal";
import { createI18n } from "../src/i18n";
import { historyForSource, type History } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

// @BR-10
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 4, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], departments: [], roles: [], timeoffTypes: [],
  projects: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Refonte" : "Mobile", projectCode: null, color: "#3B82F6", status: "in_progress" as const, nonBillable: false, startDate: null, endDate: null })),
});

let root: Root | null = null;
let host: HTMLElement;
const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });

type Src = ReturnType<typeof createDemoSource>;
function mount(allocations: Alloc[], wrap: (s: Src) => Src = (s) => s, withHistory?: (h: History) => void) {
  const src = wrap(createDemoSource(data(allocations)));
  const history = withHistory ? historyForSource(src).history : undefined;
  if (history) withHistory!(history);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock} records={src}{...(history && { history, editor: history.editor })} />));
  render();
  src.subscribe(() => { queueMicrotask(render); });
  return src;
}

const block = (key: string) => host.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
const menu = () => document.querySelector<HTMLElement>("[role=menu]");
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const button = (label: string) => [...(dialog() ?? document.body).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const click = async (el: HTMLElement) => { act(() => el.click()); await flush(); };
const notice = () => host.querySelector(".wn-notice")!.textContent;
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const rightClick = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
const ids = (s: Src) => s.getState().data!.allocations.map((a) => a.id).sort();

describe("menu contextuel d'un bloc", () => {
  it("clic droit sur un bloc : menu « Retirer Alice du projet Refonte… », sans menu du navigateur ; hors bloc : rien", () => {
    mount([alloc("a")]);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { block("a:0").dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()?.querySelector("[role=menuitem]")?.textContent).toBe("Retirer Alice du projet Refonte…");
    press(menu()!, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(block("a:0"));
    const grid = host.querySelector<HTMLElement>("[role=grid]")!;
    const outside = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { grid.dispatchEvent(outside); });
    expect([menu(), outside.defaultPrevented]).toEqual([null, false]);
  });

  it("clavier : Maj+F10 (ou la touche Menu) sur un bloc focalisé ouvre le menu, l'élément a le focus", () => {
    mount([alloc("a")]);
    block("a:0").focus();
    press(block("a:0"), { key: "F10", shiftKey: true });
    expect(document.activeElement).toBe(menu()?.querySelector("[role=menuitem]"));
    press(menu()!, { key: "Escape" });
    press(block("a:0"), { key: "ContextMenu" });
    expect(menu()).not.toBeNull();
  });
});

describe("historique d'annulation (BR-40)", () => {
  it("après un retrait, les actions sur les allocations retirées sont invalidées (pas de NOT_FOUND au Ctrl+Z) ; les autres restent", async () => {
    let h!: History;
    mount([alloc("a"), alloc("d", { personId: "2" })], (s) => s, (x) => { h = x; });
    await act(async () => { await h.editor.updateAllocation("d", { hoursPerDay: 6 }); await h.editor.updateAllocation("a", { hoursPerDay: 2 }); });
    expect(h.getState().undoLabel).toBe("allocation.load");
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    await click(button("Retirer du projet")!);
    expect(dialog()).toBeNull();
    // Il reste l'action sur « d » (autre personne) ; celle sur « a » a disparu.
    let undone = 0;
    while (h.getState().canUndo) { await act(async () => { await h.undo(); }); undone++; }
    expect(undone).toBe(1);
  });
});

describe("récapitulatif et confirmation", () => {
  it("récapitulatif (nombre, dates, temps saisis), « Retirer du projet » supprime les allocations de la personne sur ce projet seulement", async () => {
    const src = mount([alloc("a"), alloc("b", { startDate: "2026-10-26", endDate: "2026-10-26", repeatState: "weekly", repeatEndDate: "2026-11-30" }),
      alloc("c", { projectId: "2" }), alloc("d", { personId: "2" })]);
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    expect(menu()).toBeNull();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Retirer Alice du projet Refonte ?");
    expect([...dialog()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "2 allocations supprimées (du mar. 20 oct. au lun. 30 nov.)",
      "Aucun temps saisi supprimé",
    ]);
    await click(button("Retirer du projet")!);
    expect(dialog()).toBeNull();
    expect(ids(src)).toEqual(["c", "d"]);
    expect(notice()).toBe("Alice n’est plus sur le projet Refonte : 2 allocations et 0 temps saisi supprimés.");
  });

  it("Annuler ou Échap : rien n'est supprimé, le focus revient au bloc", async () => {
    const src = mount([alloc("a")]);
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    press(dialog()!, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(block("a:0"));
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    await click(button("Annuler")!);
    expect([dialog(), ids(src)]).toEqual([null, ["a"]]);
  });

  it("état changé entre-temps : message, nouveau récapitulatif, rien supprimé ; une seconde confirmation retire tout", async () => {
    const src = mount([alloc("a")]);
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    expect(dialog()!.querySelector("li")?.textContent).toBe("1 allocation supprimée (du mar. 20 oct. au mer. 21 oct.)");
    await act(async () => { await src.createAllocation({ personId: "1", projectId: "1", startDate: "2026-10-27", endDate: "2026-10-27", load: { mode: "hours", hoursPerDay: 2 } }); });
    await click(button("Retirer du projet")!);
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toBe("La situation a changé depuis l’ouverture : voici le récapitulatif à jour. Confirmez à nouveau.");
    expect(dialog()!.querySelector("li")?.textContent).toBe("2 allocations supprimées (du mar. 20 oct. au mar. 27 oct.)");
    expect(ids(src)).toHaveLength(2);
    await click(button("Retirer du projet")!);
    expect([dialog(), ids(src)]).toEqual([null, []]);
  });

  it("temps verrouillés : retrait impossible, pas de bouton ; refus de droits : message traduit", async () => {
    const locked: RemovalSummary = { inTeam: true, allocationCount: 1, firstAllocation: "2026-10-20", lastAllocation: "2026-10-21", logCount: 2, logHours: 3.5, lockedLogCount: 1, canRemove: false };
    mount([alloc("a")], (s) => ({ ...s, teamRemovalSummary: async () => ({ ok: true, summary: locked }) }));
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    expect([...dialog()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "1 allocation supprimée (du mar. 20 oct. au mer. 21 oct.)",
      "2 temps saisis supprimés (3,5 h)",
    ]);
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toBe("Retrait impossible : 1 temps saisi n’est plus un brouillon (soumis, approuvé ou verrouillé).");
    expect(button("Retirer du projet")).toBeUndefined();
    act(() => root?.unmount());
    host.remove();
    mount([alloc("a")], (s) => ({ ...s, teamRemovalSummary: async () => ({ ok: false, error: "FORBIDDEN" }) }));
    rightClick(block("a:0"));
    await click(menu()!.querySelector("[role=menuitem]")!);
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toBe("Vous n’avez pas le droit de retirer cette personne de ce projet.");
    expect(button("Retirer du projet")).toBeUndefined();
  });
});
