// @vitest-environment jsdom
// Gestes tactiles (WCAG 2.5.7) : tap = sélection + poignées, tap ailleurs = désélection, appui long = glisser armé, mouvement avant
// l'armement = défilement natif (rien ne bouge), pointercancel = aperçu abandonné. Minuteries simulées (vitest).
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockEditor, type EditRequest } from "../src/schedule/block-editor";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

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

function setup() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const frames: (() => void)[] = [];
  const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
  const frame = () => { for (const f of frames.splice(0)) f(); };
  const s = createScroller({ root, data: data([alloc("1", "1"), alloc("2", "2")]), today: "2026-10-20", widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, clock, reducedMotion: () => true });
  const commits: EditRequest[] = [];
  const ed = createBlockEditor({ root, host: s.host, clock: { raf: clock.raf, caf: clock.caf }, onCommit: (r) => { commits.push(r); } });
  const block = (key: string) => root.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
  const ghost = () => root.querySelector<HTMLElement>(".wn-ghost");
  const ptr = (type: string, target: EventTarget, x: number, y: number, pointerType = "touch") => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 7 });
    Object.defineProperty(e, "pointerType", { value: pointerType });
    target.dispatchEvent(e);
  };
  return { root, s, ed, commits, block, ghost, ptr, frame };
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
