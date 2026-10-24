// @vitest-environment jsdom
// Gestes sur un congé dans l'écran Schedule (RT-051, D4) : chaque geste passe par le parcours des congés — sans conflit, écrit
// tout de suite (optimiste), annoncé, annulable par Ctrl+Z ; sur des allocations (BR-04), l'avertissement s'ouvre et rien n'est
// supprimé en silence ; chevauchement d'un autre congé refusé avec un message ; refus de l'API : retour arrière et message.
// Suppr / Retour arrière supprime, menu contextuel (Maj+F10, clic droit) : « Modifier… » et « Supprimer ». Démo locale comme source.
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

const TODAY = "2026-10-20"; // mardi
type Alloc = ScheduleResponse["allocations"][number];
type Timeoff = ScheduleResponse["timeoffs"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-23", endDate: "2026-10-23", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const off = (id: string, over: Partial<Timeoff> = {}): Timeoff => ({
  id, version: 1, personId: "1", typeId: "t1", startDate: "2026-10-22", endDate: "2026-10-22", scope: "full_day", startHalf: "am", endHalf: "pm",
  hoursPerDay: null, approvalStatus: "approved", ...over,
});
const data = (allocations: Alloc[], timeoffs: Timeoff[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
    roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs, holidays: [], departments: [], roles: [],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});

let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; frames.length = 0; });

type Src = ReturnType<typeof createDemoSource>;
function mount(allocations: Alloc[], timeoffs: Timeoff[], o: { records?: boolean; wrap?: (s: Src) => Src } = {}) {
  const src = createDemoSource(data(allocations, timeoffs));
  const records = o.wrap ? o.wrap(src) : src;
  const { history } = historyForSource(records);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={src.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      editor={history.editor} history={history} {...(o.records === false ? {} : { records })} />));
  render();
  src.subscribe(() => { queueMicrotask(render); });
  return { src };
}

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const menu = () => document.body.querySelector<HTMLElement>("[role=menu]");
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const click = async (label: string) => { act(() => button(label)!.click()); await flush(); };
const notice = () => document.body.querySelector(".wn-notice")!.textContent;
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const timeoff = (id = "o1") => host.querySelector<HTMLElement>(`.wn-timeoff[data-timeoff="${id}"]`)!;
/** Déplace le congé d'une journée au clavier (vue jour : deux demi-journées), puis Entrée. */
const moveDay = async (id = "o1", dir: "ArrowRight" | "ArrowLeft" = "ArrowRight") => {
  const t = timeoff(id);
  act(() => t.focus());
  press(t, { key: dir });
  press(t, { key: dir });
  press(t, { key: "Enter" });
  await flush();
};
const spans = (src: Src) => src.getState().data!.timeoffs.map((t) => `${t.id}:${t.startDate}${t.startHalf}..${t.endDate}${t.endHalf}`);
const undo = async () => { press(document.body, { key: "z", ctrlKey: true }); await flush(); };

describe("geste sans conflit", () => {
  it("déplacé tout de suite, annoncé ; Ctrl+Z le remet en place", async () => {
    const { src } = mount([], [off("o1")]);
    await flush();
    await moveDay();
    expect(dialog()).toBeNull();
    expect(spans(src)).toEqual(["o1:2026-10-23am..2026-10-23pm"]);
    expect(notice()).toBe("Congé déplacé.");
    await undo();
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-22pm"]);
    expect(notice()).toBe("Modification du congé annulée.");
  });

  it("déplacé d'une demi-journée (→ en vue jour) : même durée, annoncé comme un déplacement", async () => {
    const { src } = mount([], [off("o1")]);
    await flush();
    const t = timeoff();
    act(() => t.focus());
    press(t, { key: "ArrowRight" });
    press(t, { key: "Enter" });
    await flush();
    expect(spans(src)).toEqual(["o1:2026-10-22pm..2026-10-23am"]);
    expect(notice()).toBe("Congé déplacé.");
  });

  it("étiré par la fin d'une demi-journée (Maj + →) : congé modifié, annoncé", async () => {
    const { src } = mount([], [off("o1")]);
    await flush();
    const t = timeoff();
    act(() => t.focus());
    press(t, { key: "ArrowRight", shiftKey: true });
    press(t, { key: "Enter" });
    await flush();
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-23am"]);
    expect(notice()).toBe("Congé modifié.");
  });
});

describe("BR-04 et chevauchement", () => {
  it("déplacé sur une allocation : avertissement, rien d'écrit avant le choix ; fermer n'écrit rien ; « Garder tel quel » déplace sans toucher l'allocation", async () => {
    const { src } = mount([alloc("a")], [off("o1")]);
    await flush();
    await moveDay();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Ce congé recouvre des allocations de Alice");
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-22pm"]);
    await click("Retour");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Modifier le congé");
    press(dialog()!, { key: "Escape" });
    await flush();
    if (dialog()) await click("Abandonner");
    expect(dialog()).toBeNull();
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-22pm"]);
    await moveDay();
    await click("Garder tel quel");
    expect(spans(src)).toEqual(["o1:2026-10-23am..2026-10-23pm"]);
    expect(src.getState().data!.allocations.map((a) => `${a.startDate}..${a.endDate}`)).toEqual(["2026-10-23..2026-10-23"]);
    expect(notice()).toMatch(/^Congé enregistré ; les allocations sont gardées telles quelles/);
  });

  it("« Reprogrammer… » puis « Appliquer » : allocation reportée ; Ctrl+Z défait le tout", async () => {
    const { src } = mount([alloc("a")], [off("o1")]);
    await flush();
    await moveDay();
    await click("Reprogrammer…");
    await click("Appliquer");
    expect(spans(src)).toEqual(["o1:2026-10-23am..2026-10-23pm"]);
    expect(src.getState().data!.allocations.map((a) => `${a.startDate}..${a.endDate}`)).toEqual(["2026-10-26..2026-10-26"]);
    await undo();
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-22pm"]);
    expect(src.getState().data!.allocations.map((a) => `${a.startDate}..${a.endDate}`)).toEqual(["2026-10-23..2026-10-23"]);
  });

  it("sur un autre congé : refusé avec un message, rien d'écrit, aucune fenêtre", async () => {
    const { src } = mount([], [off("o1"), off("o2", { startDate: "2026-10-23", endDate: "2026-10-23" })]);
    await flush();
    await moveDay();
    expect(dialog()).toBeNull();
    expect(notice()).toBe("Ce congé chevauche un autre congé de cette personne : changez les dates.");
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-22pm", "o2:2026-10-23am..2026-10-23pm"]);
  });

  it("refus de l'API : retour arrière (optimiste) et message", async () => {
    const { src } = mount([], [off("o1")], { wrap: (s) => ({ ...s, updateTimeoff: async () => ({ ok: false as const, error: "NETWORK" as const }) }) });
    await flush();
    await moveDay();
    expect(notice()).toBe("Congé non enregistré (connexion impossible).");
    expect(spans(src)).toEqual(["o1:2026-10-22am..2026-10-22pm"]);
  });
});

describe("commandes", () => {
  it("Suppr sur un congé focalisé : supprimé et annoncé ; Ctrl+Z le rend", async () => {
    const { src } = mount([], [off("o1")]);
    await flush();
    act(() => timeoff().focus());
    press(timeoff(), { key: "Delete" });
    await flush();
    expect(spans(src)).toEqual([]);
    expect(notice()).toBe("Congé supprimé.");
    await undo();
    expect(spans(src)).toEqual([expect.stringMatching(/:2026-10-22am\.\.2026-10-22pm$/)]);
  });

  it("menu contextuel (Maj+F10, clic droit) : « Modifier… » ouvre le congé, « Supprimer » le supprime", async () => {
    const { src } = mount([], [off("o1")]);
    await flush();
    act(() => timeoff().focus());
    press(timeoff(), { key: "F10", shiftKey: true });
    expect([...menu()!.querySelectorAll("[role=menuitem] [data-label]")].map((x) => x.textContent)).toEqual(["Modifier…", "Supprimer"]);
    act(() => menu()!.querySelector<HTMLElement>("[role=menuitem]")!.click());
    await flush();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Modifier le congé");
    press(dialog()!, { key: "Escape" });
    await flush();
    expect(dialog()).toBeNull();
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    act(() => { timeoff().dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    act(() => [...menu()!.querySelectorAll<HTMLElement>("[role=menuitem]")][1]!.click());
    await flush();
    expect(spans(src)).toEqual([]);
  });

  it("lecture seule (sans écritures) : ni geste, ni suppression, ni menu", async () => {
    const { src } = mount([], [off("o1")], { records: false });
    await flush();
    await moveDay();
    press(timeoff(), { key: "Delete" });
    press(timeoff(), { key: "F10", shiftKey: true });
    await flush();
    expect([spans(src), menu(), dialog()]).toEqual([["o1:2026-10-22am..2026-10-22pm"], null, null]);
  });
});
