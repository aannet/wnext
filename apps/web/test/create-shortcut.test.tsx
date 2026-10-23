// @vitest-environment jsdom
// Création au clavier (recette n°4, D1 : RT-057, RT-060 ; ADR-002 §5 amendé) : plus de barre de saisie rapide ni de boutons
// « + Allocation » / « Nouveau congé » dans l'en-tête du Planning. La touche N ouvre le drawer de création prérempli (personne du
// bloc focalisé, sinon première ligne visible ; jour du bloc, sinon aujourd'hui), C ouvre le congé ; les deux sont annoncés par
// aria-keyshortcuts sur la grille. Fermé, le drawer rend le focus au bloc d'origine, sinon à la grille. Une grille sans aucun
// bloc porte une indication unique.
import type { ScheduleResponse } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import { createDemoSource } from "../src/data/demo-source";
import { createI18n } from "../src/i18n";
import { historyForSource } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-22", endDate: "2026-10-23", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], departments: [], roles: [],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});

let root: Root | null = null;
let host: HTMLElement;
const clock: Partial<Clock> = { raf: () => 0, caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; document.body.innerHTML = ""; });

function mount(allocations: Alloc[], writable = true) {
  const src = createDemoSource(data(allocations));
  const { history } = historyForSource(src);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      {...(writable ? { editor: history.editor, history, records: src } : {})} />));
  render();
  src.subscribe(() => { queueMicrotask(render); });
  return { src };
}

const grid = () => host.querySelector<HTMLElement>("[role=grid]")!;
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const title = () => dialog()?.querySelector("h2")?.textContent;
const press = (target: EventTarget, key: string) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const field = (label: string) => [...document.body.querySelectorAll("label")].find((l) => l.firstChild?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
const checkedPeople = () => [...dialog()!.querySelectorAll<HTMLInputElement>(".wn-slot-people input:checked")].map((b) => b.parentElement!.textContent);

describe("en-tête du Planning sans création (RT-057, RT-060)", () => {
  it("ni barre de saisie rapide, ni « + Allocation », ni « Nouveau congé » ; N et C annoncés sur la grille", async () => {
    mount([alloc("a")]);
    await flush();
    expect(host.querySelector(".wn-quick")).toBeNull();
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("+ Allocation");
    expect(labels).not.toContain("Nouveau congé");
    expect(grid().getAttribute("aria-keyshortcuts")?.split(" ")).toEqual(expect.arrayContaining(["N", "C"]));
  });

  it("lecture seule : la grille n'annonce ni N ni C, N n'ouvre rien", async () => {
    mount([alloc("a")], false);
    await flush();
    expect(grid().getAttribute("aria-keyshortcuts") ?? "").not.toMatch(/\bN\b/);
    press(grid(), "n");
    expect(dialog()).toBeNull();
  });
});

describe("touche N : drawer de création prérempli (RT-060)", () => {
  it("sur la grille : première ligne visible et aujourd'hui ; Échap rend le focus à la grille", async () => {
    mount([alloc("a", { personId: "2" })]);
    await flush();
    act(() => grid().focus());
    press(grid(), "n");
    await flush();
    expect(title()).toBe("Nouvelle allocation");
    expect(checkedPeople()).toEqual(["Alice"]);
    expect([field("Du").value, field("Au").value]).toEqual([TODAY, TODAY]);
    press(dialog()!, "Escape");
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(grid());
  });

  it("sur un bloc : sa personne et son premier jour ; Échap rend le focus au bloc", async () => {
    mount([alloc("a", { personId: "2" })]);
    await flush();
    const b = host.querySelector<HTMLElement>('.wn-block[data-key="a:0"]')!;
    act(() => b.focus());
    press(b, "N");
    await flush();
    expect(title()).toBe("Nouvelle allocation");
    expect(checkedPeople()).toEqual(["Bruno"]);
    expect([field("Du").value, field("Au").value]).toEqual(["2026-10-22", "2026-10-22"]);
    press(dialog()!, "Escape");
    await flush();
    expect(document.activeElement).toBe(host.querySelector('.wn-block[data-key="a:0"]'));
  });
});

describe("grille vide (RT-060)", () => {
  const HINT = "Cliquez ou glissez dans la grille pour planifier";
  it("aucun bloc : une seule indication ; elle disparaît au premier bloc", async () => {
    mount([]);
    await flush();
    expect([...host.querySelectorAll(".wn-grid-hint")].map((e) => e.textContent)).toEqual([HINT]);
    act(() => root!.unmount());
    host.remove();
    mount([alloc("a")]);
    await flush();
    expect(host.querySelector(".wn-grid-hint")).toBeNull();
  });

  it("lecture seule : pas d'indication", async () => {
    mount([], false);
    await flush();
    expect(host.querySelector(".wn-grid-hint")).toBeNull();
  });
});
