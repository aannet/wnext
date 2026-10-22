// @vitest-environment jsdom
// Gestes tactiles (WCAG 2.5.7) : tap = sélection + poignées, tap ailleurs = désélection, appui long = glisser armé, mouvement avant
// l'armement = défilement natif (rien ne bouge), pointercancel = aperçu abandonné. Minuteries simulées (vitest).
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockEditor, type CreateRequest, type EditRequest } from "../src/schedule/block-editor";
import { GUTTER_PX, HEADER_PX, createScroller, type Clock } from "../src/schedule/scroller";

const DAY = DEFAULT_PX_PER_DAY.day;
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, personId: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId, projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null,
    country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
}) as ScheduleResponse;

function setup(enabled = true) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const frames: (() => void)[] = [];
  const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
  const frame = () => { for (const f of frames.splice(0)) f(); };
  const s = createScroller({ root, data: data([alloc("1", "1"), alloc("2", "2")]), today: "2026-10-20", widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, clock, reducedMotion: () => true });
  const commits: EditRequest[] = [];
  const creates: CreateRequest[] = [];
  const ed = createBlockEditor({
    root, host: s.host, clock: { raf: clock.raf, caf: clock.caf }, enabled: () => enabled, onCommit: (r) => { commits.push(r); }, onCreate: (r) => { creates.push(r); },
  });
  const block = (key: string) => root.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
  const ghost = () => root.querySelector<HTMLElement>(".wn-ghost");
  const ptr = (type: string, target: EventTarget, x: number, y: number, pointerType = "touch", pointerId = 7) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerId", { value: pointerId });
    Object.defineProperty(e, "pointerType", { value: pointerType });
    target.dispatchEvent(e);
  };
  /** Case libre : ligne de la personne 1 (jsdom place la grille en (0, 0)), abscisse au milieu du jour. */
  const row = () => root.querySelector<HTMLElement>(".wn-row")!;
  const xOf = (date: string) => s.host.xOfDate(date) + 5;
  const draft = () => root.querySelector<HTMLElement>(".wn-slot-draft");
  const range = () => creates.map((c) => [c.personId, c.startDate, c.endDate]);
  /** Mise en page simulée (jsdom pose la surface en (0, 0)) : grille de GUTTER_PX + 960 × 480 px, surface sous l'en-tête et décalée
   *  du défilement horizontal, comme dans le navigateur. `left()` : bord gauche de la grille dans la fenêtre. */
  const left = () => root.scrollLeft;
  const layout = () => { root.getBoundingClientRect = () => new DOMRect(left(), -HEADER_PX, GUTTER_PX + 960, 480); };
  /** Plus de bloc provisoire visible. */
  const noDraft = () => !draft() || draft()!.style.display === "none";
  return { root, s, ed, commits, creates, block, ghost, ptr, frame, row, xOf, draft, range, layout, left, noDraft };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("toucher", () => {
  it("tap : sélectionne le bloc (aria-selected) et lui pose les poignées ; tap ailleurs : désélection", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 5, 5);
    h.ptr("pointerup", document, 5, 5);
    expect(b.classList.contains("wn-selected")).toBe(true);
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(b.querySelectorAll("[data-handle]")).toHaveLength(3);
    expect(h.commits).toHaveLength(0);
    h.ptr("pointerdown", h.root, 300, 300);
    h.ptr("pointerup", document, 300, 300);
    expect(b.classList.contains("wn-selected")).toBe(false);
    expect(b.hasAttribute("aria-selected")).toBe(false);
    expect(b.querySelector("[data-handle]")).toBeNull();
  });

  it("le survol tactile ne pose pas les poignées (pointerover précède pointerdown)", () => {
    const h = setup();
    h.ptr("pointerover", h.block("1:0"), 0, 0);
    expect(h.block("1:0").querySelector("[data-handle]")).toBeNull();
  });

  it("appui long sans bouger : glisser armé (classe, vibration), puis déplacement validé", () => {
    const h = setup();
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointermove", document, 3, 2);
    vi.advanceTimersByTime(399);
    expect(b.classList.contains("wn-armed")).toBe(false);
    vi.advanceTimersByTime(2);
    expect(b.classList.contains("wn-armed")).toBe(true);
    expect(b.classList.contains("wn-selected")).toBe(true);
    expect(vibrate).toHaveBeenCalledOnce();
    h.ptr("pointermove", document, 3 + 2 * DAY + 10, 2);
    h.frame();
    expect(h.ghost()!.style.display).toBe("");
    h.ptr("pointerup", document, 3 + 2 * DAY + 10, 2);
    expect(h.commits.map((c) => c.patch)).toEqual([{ startDate: "2026-10-22", endDate: "2026-10-23" }]);
    expect(b.classList.contains("wn-armed")).toBe(false);
    expect(b.classList.contains("wn-selected")).toBe(true);
  });

  it("mouvement de plus de 8 px avant l'armement : défilement natif, ni sélection ni geste", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointermove", document, 0, 20);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, 0, 20);
    expect(b.classList.contains("wn-armed")).toBe(false);
    expect(b.classList.contains("wn-selected")).toBe(false);
    expect(h.ghost()).toBeNull();
    expect(h.commits).toHaveLength(0);
    expect(h.ed.busy()).toBe(false);
  });

  it("pointercancel avant l'armement ou pendant le glisser : aperçu abandonné, rien validé", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointercancel", document, 0, 0);
    vi.advanceTimersByTime(1000);
    expect(b.classList.contains("wn-armed")).toBe(false);
    h.ptr("pointerdown", b, 0, 0);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, DAY * 2, 0);
    h.frame();
    expect(h.ghost()!.style.display).toBe("");
    h.ptr("pointercancel", document, DAY * 2, 0);
    expect(h.ghost()!.style.display).toBe("none");
    expect(b.classList.contains("wn-armed")).toBe(false);
    expect(h.commits).toHaveLength(0);
    expect(h.ed.busy()).toBe(false);
  });

  it("bloc sélectionné : glisser tout de suite (sans appui long) ; poignée de fin : étirer", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointerup", document, 0, 0);
    h.ptr("pointerdown", b.querySelector("[data-handle=end]")!, 0, 0);
    h.ptr("pointermove", document, DAY + 5, 0);
    h.frame();
    h.ptr("pointerup", document, DAY + 5, 0);
    expect(h.commits.map((c) => c.patch)).toEqual([{ endDate: "2026-10-22" }]);
  });

  it("la souris garde son comportement : glisser immédiat, pas de sélection tactile", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0, "mouse");
    h.ptr("pointermove", document, DAY + 5, 0, "mouse");
    h.frame();
    h.ptr("pointerup", document, DAY + 5, 0, "mouse");
    expect(h.commits).toHaveLength(1);
    expect(b.classList.contains("wn-selected")).toBe(false);
  });
});

describe("toucher : création en case libre (RT-043, PO-07)", () => {
  it("appui long sur une case libre : bloc provisoire (vibration), relâcher demande la création pour la personne et le jour", () => {
    const h = setup();
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    vi.advanceTimersByTime(399);
    expect(h.draft()).toBeNull();
    vi.advanceTimersByTime(2);
    expect(h.draft()!.style.display).toBe("");
    expect(vibrate).toHaveBeenCalledOnce();
    expect(h.creates).toHaveLength(0);
    h.ptr("pointerup", document, h.xOf("2026-10-23"), 5);
    expect(h.range()).toEqual([["1", "2026-10-23", "2026-10-23"]]);
    expect(h.draft()!.style.display).toBe("");
    expect(h.ed.busy()).toBe(false);
  });

  it("appui long puis glisser : la plage s'étend jusqu'au jour atteint", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, h.xOf("2026-10-26"), 5);
    expect(h.draft()!.style.width).toBe(`${4 * h.s.host.pxPerDay()}px`);
    h.ptr("pointerup", document, h.xOf("2026-10-26"), 5);
    expect(h.range()).toEqual([["1", "2026-10-23", "2026-10-26"]]);
  });

  it("tap sur une case libre : rien n'est créé", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    vi.advanceTimersByTime(200);
    h.ptr("pointerup", document, h.xOf("2026-10-23"), 5);
    vi.advanceTimersByTime(1000);
    expect([h.creates.length, h.draft()]).toEqual([0, null]);
    expect(h.ed.busy()).toBe(false);
  });

  it("glisser avant l'armement : défilement natif, rien n'est créé", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    h.ptr("pointermove", document, h.xOf("2026-10-23") + 20, 5);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, h.xOf("2026-10-23") + 20, 5);
    expect([h.creates.length, h.draft()]).toEqual([0, null]);
    expect(h.ed.busy()).toBe(false);
  });

  it("pendant l'appui long et la création : ni menu contextuel ni défilement ; avant l'armement le doigt défile", () => {
    const h = setup();
    const touchmove = () => { const e = new Event("touchmove", { cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; };
    const contextmenu = () => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); h.row().dispatchEvent(e); return e.defaultPrevented; };
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    expect([touchmove(), contextmenu()]).toEqual([false, true]);
    vi.advanceTimersByTime(401);
    expect([touchmove(), contextmenu()]).toEqual([true, true]);
    h.ptr("pointerup", document, h.xOf("2026-10-23"), 5);
    expect([touchmove(), contextmenu()]).toEqual([false, false]);
  });

  it("pointercancel pendant la création : bloc provisoire retiré, rien n'est créé", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointercancel", document, h.xOf("2026-10-23"), 5);
    expect(h.creates).toHaveLength(0);
    expect(h.draft()!.style.display).toBe("none");
    expect(h.ed.busy()).toBe(false);
  });

  it("lecture seule : l'appui long sur une case libre ne crée rien", () => {
    const h = setup(false);
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, h.xOf("2026-10-23"), 5);
    expect([h.creates.length, h.draft()]).toEqual([0, null]);
  });
});

describe("toucher : création en case libre, annulations (RT-043, revue croisée)", () => {
  const X = (h: ReturnType<typeof setup>) => h.xOf("2026-10-23");
  const nothing = (h: ReturnType<typeof setup>) => {
    expect([h.creates.length, h.noDraft(), h.ed.busy()]).toEqual([0, true, false]);
  };

  it("deuxième contact avant l'armement, même hors grille : minuteur annulé, rien n'est créé", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), X(h), 5);
    h.ptr("pointerdown", document.body, 900, 700, "touch", 8);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, X(h), 5);
    h.ptr("pointerup", document, 900, 700, "touch", 8);
    nothing(h);
  });

  it("deuxième contact après l'armement, même hors grille : bloc provisoire retiré, relâcher ne crée rien", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    expect(h.draft()!.style.display).toBe("");
    h.ptr("pointerdown", document.body, 900, 700, "touch", 8);
    expect(h.noDraft()).toBe(true);
    h.ptr("pointerup", document, X(h), 5);
    h.ptr("pointerup", document, 900, 700, "touch", 8);
    nothing(h);
  });

  it("pincement sur deux cases libres : rien n'est armé, ni par le premier doigt ni par le second resté posé", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), X(h), 5);
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-27"), 5, "touch", 8);
    h.ptr("pointermove", document, X(h) - 3, 5);
    h.ptr("pointermove", document, h.xOf("2026-10-27") + 3, 5, "touch", 8);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, X(h) - 3, 5);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, h.xOf("2026-10-27") + 3, 5, "touch", 8);
    nothing(h);
    // Les contacts relâchés sont oubliés : un nouvel appui long crée de nouveau.
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointerup", document, X(h), 5);
    expect(h.range()).toEqual([["1", "2026-10-23", "2026-10-23"]]);
  });

  it("deuxième contact pendant l'appui long sur un bloc : minuteur annulé, rien n'est armé", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointerdown", document.body, 900, 700, "touch", 8);
    vi.advanceTimersByTime(1000);
    expect(b.classList.contains("wn-armed")).toBe(false);
    h.ptr("pointerup", document, 0, 0);
    h.ptr("pointerup", document, 900, 700, "touch", 8);
    expect(h.commits).toHaveLength(0);
  });

  it("deuxième contact pendant le déplacement armé d'un bloc, même hors grille : déplacement annulé, rien n'est écrit (RT-046)", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, 2 * DAY + 10, 0);
    h.frame();
    expect(h.ghost()!.style.display).toBe("");
    h.ptr("pointerdown", document.body, 900, 700, "touch", 8);
    expect([h.ghost()!.style.display, b.classList.contains("wn-armed"), h.ed.busy()]).toEqual(["none", false, false]);
    h.ptr("pointermove", document, 3 * DAY + 10, 0);
    h.frame();
    h.ptr("pointerup", document, 3 * DAY + 10, 0);
    h.ptr("pointerup", document, 900, 700, "touch", 8);
    expect(h.commits).toHaveLength(0);
    expect(h.ghost()!.style.display).toBe("none");
  });

  it("deuxième contact pendant l'étirement au toucher d'un bloc sélectionné : geste annulé, rien n'est écrit (RT-046)", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointerup", document, 0, 0);
    h.ptr("pointerdown", b.querySelector("[data-handle=end]")!, 0, 0);
    h.ptr("pointermove", document, DAY + 5, 0);
    h.frame();
    h.ptr("pointerdown", h.row(), 600, 5, "touch", 8);
    h.ptr("pointerup", document, DAY + 5, 0);
    h.ptr("pointerup", document, 600, 5, "touch", 8);
    expect([h.commits.length, h.ghost()!.style.display, h.ed.busy()]).toEqual([0, "none", false]);
  });

  it("après l'armement, sortir de la zone des blocs vers la droite : création abandonnée", () => {
    const h = setup();
    h.layout();
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, h.xOf("2026-10-24"), 5);
    expect(h.draft()!.style.display).toBe("");
    h.ptr("pointermove", document, h.left() + GUTTER_PX + 970, 5);
    expect(h.noDraft()).toBe(true);
    h.ptr("pointermove", document, h.xOf("2026-10-24"), 5);
    h.ptr("pointerup", document, h.xOf("2026-10-24"), 5);
    nothing(h);
  });

  it("après l'armement, sortir vers la colonne des personnes : création abandonnée", () => {
    const h = setup();
    h.layout();
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, h.left() + GUTTER_PX - 10, 5);
    h.ptr("pointerup", document, h.left() + GUTTER_PX - 10, 5);
    nothing(h);
  });

  it("après l'armement, sortir vers le bas puis vers l'en-tête : création abandonnée", () => {
    const h = setup();
    h.layout();
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, X(h), 480 - HEADER_PX + 10);
    expect(h.noDraft()).toBe(true);
    h.ptr("pointerup", document, X(h), 5);
    nothing(h);
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, X(h), -10);
    h.ptr("pointerup", document, X(h), -10);
    nothing(h);
  });

  it("relâcher hors de la zone des blocs sans mouvement signalé : rien n'est créé", () => {
    const h = setup();
    h.layout();
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointerup", document, X(h), 600);
    nothing(h);
  });

  it("dans la zone des blocs, changer de ligne ne fait rien perdre : la création reste sur la ligne de départ", () => {
    const h = setup();
    h.layout();
    h.ptr("pointerdown", h.row(), X(h), 5);
    vi.advanceTimersByTime(401);
    h.ptr("pointermove", document, h.xOf("2026-10-24"), 200);
    h.ptr("pointerup", document, h.xOf("2026-10-24"), 200);
    expect(h.range()).toEqual([["1", "2026-10-23", "2026-10-24"]]);
  });

  it("pointercancel avant l'armement sur une case libre : minuteur annulé, rien n'est créé", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), X(h), 5);
    h.ptr("pointercancel", document, X(h), 5);
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, X(h), 5);
    nothing(h);
  });

  it("démontage pendant l'appui long ou la création : aucune création tardive, aucun bloc provisoire restant", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), X(h), 5);
    h.ed.destroy();
    vi.advanceTimersByTime(1000);
    h.ptr("pointerup", document, X(h), 5);
    expect([h.creates.length, h.draft()]).toEqual([0, null]);

    const k = setup();
    k.ptr("pointerdown", k.row(), X(k), 5);
    vi.advanceTimersByTime(401);
    expect(k.draft()).not.toBeNull();
    k.ed.destroy();
    k.ptr("pointerup", document, X(k), 5);
    vi.advanceTimersByTime(1000);
    expect([k.creates.length, k.draft()]).toEqual([0, null]);
  });
});
