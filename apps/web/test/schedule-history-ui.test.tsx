// @vitest-environment jsdom
// Annuler / Rétablir dans l'écran Schedule : boutons de la barre d'outils (désactivés si pile vide), raccourcis
// Ctrl+Z / Ctrl+Maj+Z / Ctrl+Y (Cmd sur Mac) ignorés dans un champ de saisie, annonces aria-live, conflit, découpe.
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import type { EditOutcome, ScheduleEditor } from "../src/data/allocation-edits";
import { createDemoSource } from "../src/data/demo-source";
import type { ScheduleSource } from "../src/data/schedule-source";
import { createI18n } from "../src/i18n";
import { createHistory, historyForSource, type History } from "../src/schedule/history";
import { GUTTER_PX, type Clock } from "../src/schedule/scroller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
const DAY = DEFAULT_PX_PER_DAY.day;
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 4, percent: null, ...over,
}) as Alloc;

const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
  allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});

let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const frame = () => { for (const f of frames.splice(0)) f(); };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; frames.length = 0; });

/** Écran sur la démo locale ; `sync` redonne les données à jour (rôle du conteneur). */
function mountDemo(allocations: Alloc[] = [alloc("1")]) {
  const src = createDemoSource(data(allocations));
  const { history } = historyForSource(src);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (s: ScheduleSource, h: History) => act(() => root!.render(
    <ScheduleScreen i18n={createI18n("fr")} data={s.getState().data!} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock}
      editor={h.editor} history={h} />));
  render(src, history);
  return { src, history, sync: async () => { await flush(); render(src, history); } };
}

function mountWith(history: History) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={data([alloc("1")])} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480}
    clock={clock} editor={history.editor} history={history} />));
}

const block = (key: string) => host.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
const notice = () => host.querySelector(".wn-notice")!.textContent;
const toolbarButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => b.textContent === label)!;
const start = (s: ScheduleSource) => s.getState().data!.allocations.find((a) => a.id === "1")!.startDate;
function drag(target: Element, dx: number) {
  const ptr = (type: string, t: EventTarget, x: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 0, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    t.dispatchEvent(e);
  };
  act(() => { ptr("pointerdown", target, 0); ptr("pointermove", document, dx); frame(); ptr("pointerup", document, dx); });
}
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

describe("boutons Annuler / Rétablir", () => {
  it("désactivés tant que la pile est vide ; un déplacement s'annule puis se rétablit, annoncé", async () => {
    const t = mountDemo();
    expect(toolbarButton("Annuler").disabled).toBe(true);
    expect(toolbarButton("Rétablir").disabled).toBe(true);
    drag(block("1:0"), DAY);
    await t.sync();
    expect(start(t.src)).toBe("2026-10-21");
    expect(toolbarButton("Annuler").disabled).toBe(false);
    act(() => toolbarButton("Annuler").click());
    await t.sync();
    expect(start(t.src)).toBe("2026-10-20");
    expect(notice()).toBe("Déplacement annulé.");
    expect(toolbarButton("Annuler").disabled).toBe(true);
    expect(toolbarButton("Rétablir").disabled).toBe(false);
    act(() => toolbarButton("Rétablir").click());
    await t.sync();
    expect(start(t.src)).toBe("2026-10-21");
    expect(notice()).toBe("Déplacement rétabli.");
  });

  it("sans historique : pas de boutons", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={data([alloc("1")])} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock} />));
    expect(toolbarButton("Annuler")).toBeUndefined();
  });
});

describe("raccourcis", () => {
  it("Ctrl+Z annule, Ctrl+Maj+Z rétablit, Ctrl+Y rétablit, Cmd+Z annule", async () => {
    const t = mountDemo();
    drag(block("1:0"), DAY);
    await t.sync();
    press(document.body, { key: "z", ctrlKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-20");
    press(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-21");
    press(document.body, { key: "z", metaKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-20");
    press(document.body, { key: "y", ctrlKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-21");
  });

  it("raccourci depuis un bloc focalisé : pris en compte, sans déclencher de geste", async () => {
    const t = mountDemo();
    drag(block("1:0"), DAY);
    await t.sync();
    block("1:0").focus();
    press(block("1:0"), { key: "z", ctrlKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-20");
  });

  it("ignorés quand le focus est dans un champ de saisie", async () => {
    const t = mountDemo();
    drag(block("1:0"), DAY);
    await t.sync();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press(input, { key: "z", ctrlKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-21");
    input.remove();
  });

  it("Z seul, ou Ctrl+Alt+Z : rien", async () => {
    const t = mountDemo();
    drag(block("1:0"), DAY);
    await t.sync();
    press(document.body, { key: "z" });
    press(document.body, { key: "z", ctrlKey: true, altKey: true });
    await t.sync();
    expect(start(t.src)).toBe("2026-10-21");
  });
});

describe("échecs et découpe", () => {
  it("VERSION_CONFLICT pendant un undo : message traduit, action retirée", async () => {
    let next: EditOutcome = { ok: true };
    const editor: ScheduleEditor = { updateAllocation: async () => next, splitOccurrence: async () => ({ ok: true }) };
    const history = createHistory({ editor, read: () => alloc("1") });
    mountWith(history);
    drag(block("1:0"), DAY);
    await flush();
    next = { ok: false, error: "VERSION_CONFLICT" };
    press(document.body, { key: "z", ctrlKey: true });
    await flush();
    expect(notice()).toBe("Impossible d’annuler : l’allocation a été modifiée par quelqu’un d’autre entre-temps. L’action est retirée de l’historique.");
    expect(toolbarButton("Annuler").disabled).toBe(true);
    expect(toolbarButton("Rétablir").disabled).toBe(true);
  });

  it("découpe d'une occurrence : enregistrée, annoncée comme non annulable", async () => {
    const t = mountDemo([alloc("1", { startDate: "2026-10-19", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-30" })]);
    drag(block("1:1"), DAY);
    act(() => { [...document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((b) => b.textContent === "Cette occurrence")!.click(); });
    await t.sync();
    expect(notice()).toBe("Modification enregistrée. La découpe d’une occurrence ne peut pas être annulée.");
    expect(toolbarButton("Annuler").disabled).toBe(true);
  });
});
