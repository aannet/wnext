// @vitest-environment jsdom
// Écran Schedule et gestes : choix de portée d'une série (cette occurrence -> découpe, toute la série -> PATCH, Annuler),
// découpe impossible, avertissements BR-37 / BR-01 non bloquants, erreurs traduites, clavier, démo locale sans réseau.
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleScreen } from "../src/ScheduleScreen";
import type { EditOutcome, ScheduleEditor } from "../src/data/allocation-edits";
import { createDemoSource } from "../src/data/demo-source";
import { createI18n } from "../src/i18n";
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

function data(allocations: Alloc[], projectEnd: string | null = null): ScheduleResponse {
  return {
    window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null,
      roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
    allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
    projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: projectEnd }],
  };
}

const WEEKLY = alloc("2", { personId: "2", startDate: "2026-10-19", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-30" });

let root: Root | null = null;
let host: HTMLElement;
const frames: (() => void)[] = [];
const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
const frame = () => { for (const f of frames.splice(0)) f(); };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function mount(d: ScheduleResponse, editor?: ScheduleEditor) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={d} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock} editor={editor} />));
}
const rerender = (d: ScheduleResponse, editor?: ScheduleEditor) =>
  act(() => root!.render(<ScheduleScreen i18n={createI18n("fr")} data={d} today={TODAY} widthPx={GUTTER_PX + 960} heightPx={480} clock={clock} editor={editor} />));
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; frames.length = 0; });

const block = (key: string) => host.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
const notice = () => host.querySelector(".wn-notice")!.textContent;
const buttons = () => [...host.querySelectorAll("[role=dialog] button")].map((b) => b.textContent);
const click = (label: string) => act(() => { [...host.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((b) => b.textContent === label)!.click(); });
function drag(target: Element, dx: number, dy = 0) {
  const ptr = (type: string, t: EventTarget, x: number, y: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    t.dispatchEvent(e);
  };
  act(() => {
    ptr("pointerdown", target, 0, 0);
    ptr("pointermove", document, dx, dy);
    frame();
    ptr("pointerup", document, dx, dy);
  });
}

function fakeEditor(update: EditOutcome = { ok: true }, split: EditOutcome = { ok: true }) {
  return { updateAllocation: vi.fn(async () => update), splitOccurrence: vi.fn(async () => split) } satisfies ScheduleEditor;
}

describe("série : choix de portée", () => {
  it("cette occurrence : découpe avec le rang et le patch de l'occurrence", async () => {
    const ed = fakeEditor();
    mount(data([WEEKLY]), ed);
    drag(block("2:1"), DAY);
    expect(buttons()).toEqual(["Cette occurrence", "Toute la série", "Annuler"]);
    expect(host.querySelector(".wn-ghost")!.getAttribute("style")).not.toContain("display: none");
    click("Cette occurrence");
    await flush();
    expect(ed.splitOccurrence).toHaveBeenCalledWith("2", 1, { startDate: "2026-10-27", endDate: "2026-10-28" });
    expect(ed.updateAllocation).not.toHaveBeenCalled();
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(notice()).toBe("Modification enregistrée.");
  });

  it("toute la série : PATCH de la série entière", async () => {
    const ed = fakeEditor();
    mount(data([WEEKLY]), ed);
    drag(block("2:1"), DAY);
    click("Toute la série");
    await flush();
    expect(ed.updateAllocation).toHaveBeenCalledWith("2", { startDate: "2026-10-20", endDate: "2026-10-21", repeatEndDate: "2026-12-01" });
  });

  it("Annuler : aucune écriture, fantôme masqué, bloc à sa place", async () => {
    const ed = fakeEditor();
    mount(data([WEEKLY]), ed);
    const before = block("2:1").style.transform;
    drag(block("2:1"), DAY);
    click("Annuler");
    await flush();
    expect(ed.updateAllocation).not.toHaveBeenCalled();
    expect(ed.splitOccurrence).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLElement>(".wn-ghost")!.style.display).toBe("none");
    expect(block("2:1").style.transform).toBe(before);
    expect(notice()).toBe("Modification annulée.");
  });

  it("SERIES_SPLIT_UNSUPPORTED : message traduit avec la raison, « toute la série » proposée", async () => {
    const ed = fakeEditor({ ok: true }, { ok: false, error: "SERIES_SPLIT_UNSUPPORTED", reason: "monthly_clamped" });
    mount(data([WEEKLY]), ed);
    drag(block("2:1"), DAY);
    click("Cette occurrence");
    await flush();
    expect(host.querySelector("[role=dialog] p")!.textContent).toContain("la répétition mensuelle tombe en fin de mois");
    expect(buttons()).toEqual(["Toute la série", "Annuler"]);
    click("Toute la série");
    await flush();
    expect(ed.updateAllocation).toHaveBeenCalledTimes(1);
  });
});

describe("résultat d'une écriture", () => {
  it("BR-37 : fin après celle du projet, avertissement non bloquant", async () => {
    const ed = fakeEditor();
    mount(data([alloc("1")], "2026-10-22"), ed);
    drag(block("1:0"), 2 * DAY);
    await flush();
    expect(ed.updateAllocation).toHaveBeenCalledWith("1", { startDate: "2026-10-22", endDate: "2026-10-23" });
    expect(notice()).toBe("Modification enregistrée. Attention : l’allocation se termine après la fin du projet.");
  });

  it("BR-01 : surcharge signalée, jamais bloquée", async () => {
    const ed = fakeEditor();
    mount(data([alloc("1", { hoursPerDay: 6 }), alloc("3", { startDate: "2026-10-22", endDate: "2026-10-22", hoursPerDay: 6 })]), ed);
    drag(block("1:0"), 2 * DAY);
    await flush();
    expect(notice()).toContain("Attention : Alice est en surcharge sur cette période");
  });

  it("VERSION_CONFLICT : message « modifié par quelqu'un d'autre »", async () => {
    mount(data([alloc("1")]), fakeEditor({ ok: false, error: "VERSION_CONFLICT" }));
    drag(block("1:0"), DAY);
    await flush();
    expect(notice()).toBe("Cette allocation a été modifiée par quelqu’un d’autre : la version à jour est affichée.");
  });

  it("sans éditeur : lecture seule, aucun geste", async () => {
    mount(data([alloc("1")]));
    drag(block("1:0"), DAY);
    expect(host.querySelector(".wn-ghost")).toBeNull();
  });
});

describe("clavier", () => {
  it("Entrée sur la grille : focus sur un bloc ; flèche annoncée ; Entrée écrit ; Échap rend le focus à la grille", async () => {
    const ed = fakeEditor();
    mount(data([alloc("1")]), ed);
    const grid = host.querySelector<HTMLElement>("[role=grid]")!;
    grid.focus();
    const key = (t: Element, k: string) => act(() => { t.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    key(grid, "Enter");
    const b = document.activeElement as HTMLElement;
    expect(b.getAttribute("data-key")).toBe("1:0");
    key(b, "ArrowRight");
    expect(notice()).toMatch(/^Alice : du .+ au .+, 4 h par jour\. Entrée pour valider, Échap pour annuler\.$/);
    key(b, "Enter");
    await flush();
    expect(ed.updateAllocation).toHaveBeenCalledWith("1", { startDate: "2026-10-21", endDate: "2026-10-22" });
    key(block("1:0"), "Escape");
    expect(document.activeElement).toBe(grid);
  });
});

describe("démo locale (?demo=1)", () => {
  it("les gestes s'appliquent sans réseau : nouvelle version, découpe locale", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const src = createDemoSource(data([alloc("1"), WEEKLY]));
    expect(await src.updateAllocation("1", { startDate: "2026-10-22", endDate: "2026-10-23" })).toEqual({ ok: true });
    expect(src.getState().data!.allocations.find((a) => a.id === "1")).toMatchObject({ version: 2, startDate: "2026-10-22" });
    expect(await src.splitOccurrence("2", 1, { hoursPerDay: 6 })).toEqual({ ok: true });
    expect(src.getState().data!.allocations.filter((a) => a.personId === "2").map((a) => [a.startDate, a.repeatState, a.hoursPerDay]))
      .toEqual(expect.arrayContaining([["2026-10-19", "weekly", 4], ["2026-10-26", "none", 6], ["2026-11-02", "weekly", 4]]));
    expect(fetchSpy).not.toHaveBeenCalled();
    mount(src.getState().data!, src);
    drag(block("1:0"), DAY);
    rerender(src.getState().data!, src);
    expect(src.getState().data!.allocations.find((a) => a.id === "1")).toMatchObject({ version: 3, startDate: "2026-10-23" });
    fetchSpy.mockRestore();
  });
});
