// @vitest-environment jsdom
// Gestes sur un congé (RT-051, D4) : le congé reçoit les gestes des blocs — glisser (pointeur, toucher), poignées de début et de
// fin (pas de poignée de hauteur), flèches au clavier (Maj, Alt), sélection au clic, ouverture au double clic ou au clic sur le
// congé déjà sélectionné ; au pas de la demi-journée en vue jour, de la journée en vue semaine ; pas de changement de personne.
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY } from "@wnext/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockEditor, type TimeoffEditRequest } from "../src/schedule/block-editor";
import { CAP_PX, ROW_UNIT_PX } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

const DAY = DEFAULT_PX_PER_DAY.day;
const ROW = ROW_UNIT_PX + CAP_PX;
type Timeoff = ScheduleResponse["timeoffs"][number];
const off = (id: string, over: Partial<Timeoff> = {}): Timeoff => ({
  id, version: 1, personId: "1", typeId: "t1", startDate: "2026-10-20", endDate: "2026-10-21", scope: "full_day", startHalf: "am", endHalf: "pm",
  hoursPerDay: null, approvalStatus: "approved", ...over,
});
const data = (timeoffs: Timeoff[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null,
    country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations: [], timeoffs, holidays: [], timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }], departments: [], roles: [],
  projects: [],
}) as ScheduleResponse;

function setup(opts: { enabled?: boolean; commit?: (r: TimeoffEditRequest) => void | Promise<unknown>; timeoffs?: Timeoff[] } = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const frames: (() => void)[] = [];
  const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
  const frame = (n = 1) => { for (let i = 0; i < n; i++) for (const f of frames.splice(0)) f(); };
  const s = createScroller({ root, data: data(opts.timeoffs ?? [off("o1")]), today: "2026-10-20", widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, clock, reducedMotion: () => true });
  const commits: TimeoffEditRequest[] = [];
  const opened: string[] = [];
  const previews: (string | null)[] = [];
  const ed = createBlockEditor({
    root, host: s.host, clock: { raf: clock.raf!, caf: clock.caf! }, enabled: () => opts.enabled ?? true, onCommit: () => {},
    onTimeoffCommit: (r) => { commits.push(r); return opts.commit?.(r); },
    onTimeoffOpen: (r) => opened.push(r.timeoffId),
    onTimeoffPreview: (p) => previews.push(p && `${p.draft.startDate}${p.draft.startHalf}..${p.draft.endDate}${p.draft.endHalf}`),
  });
  const el = (id = "o1") => root.querySelector<HTMLElement>(`.wn-timeoff[data-timeoff="${id}"]`)!;
  const ghost = () => root.querySelector<HTMLElement>(".wn-ghost");
  const ptr = (type: string, target: EventTarget, x: number, y: number, more: { pointerType?: string } = {}) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "pointerType", { value: more.pointerType ?? "mouse" });
    target.dispatchEvent(e);
  };
  const drag = (target: Element, dx: number, dy = 0) => {
    ptr("pointerdown", target, 0, 0);
    ptr("pointermove", document, dx, dy);
    frame();
    ptr("pointerup", document, dx, dy);
  };
  const handle = (which: string) => {
    ptr("pointerover", el(), 0, 0);
    return el().querySelector(`[data-handle=${which}]`);
  };
  const key = (target: Element, k: string, mods: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  const spans = () => commits.map((c) => c.patch);
  return { root, s, ed, commits, opened, previews, el, ghost, ptr, drag, handle, key, frame, spans };
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("pointeur", () => {
  it("glisser d'une demi-journée en vue jour : fantôme pendant le geste, patch des dates et des demi-journées à la fin", () => {
    const h = setup();
    h.ptr("pointerdown", h.el(), 0, 0);
    h.ptr("pointermove", document, DAY / 2 + 5, 0);
    h.frame();
    expect(h.ghost()!.style.display).toBe("");
    expect(h.ghost()!.style.transform).toBe(`translate(${h.s.host.xOfDate("2026-10-20") + DAY / 2}px, 0px)`);
    expect(h.ghost()!.style.width).toBe(`${2 * DAY}px`);
    expect(h.commits).toHaveLength(0);
    h.ptr("pointerup", document, DAY / 2 + 5, 0);
    expect(h.commits.map((c) => [c.timeoffId, c.patch, c.via])).toEqual([["o1", { startHalf: "pm", endDate: "2026-10-22", endHalf: "am" }, "pointer"]]);
    expect(h.ghost()!.style.display).toBe("none");
  });

  it("vers une autre ligne : la personne ne change pas (seules les dates suivent)", () => {
    const h = setup();
    h.drag(h.el(), DAY, ROW);
    expect(h.commits.map((c) => [c.patch, c.draft.personId])).toEqual([[{ startDate: "2026-10-21", endDate: "2026-10-22" }, "1"]]);
  });

  it("poignées de début et de fin seulement (un congé n'a pas d'heures) : étirer la fin, réduire le début", () => {
    const h = setup();
    expect(h.handle("height")).toBeNull();
    h.drag(h.handle("end")!, DAY);
    h.drag(h.handle("start")!, DAY / 2);
    expect(h.spans()).toEqual([{ endDate: "2026-10-22" }, { startHalf: "pm" }]);
  });

  it("vue semaine : le pas est la journée", () => {
    const h = setup();
    h.s.setZoom("week");
    const week = DEFAULT_PX_PER_DAY.week;
    h.drag(h.el(), week * 0.4);
    expect(h.commits).toHaveLength(0);
    h.drag(h.el(), week * 1.2);
    expect(h.spans()).toEqual([{ startDate: "2026-10-21", endDate: "2026-10-22" }]);
  });

  it("clic : sélectionne (poignées) ; clic sur le congé sélectionné ou double clic : ouverture", () => {
    const h = setup();
    h.drag(h.el(), 1);
    expect([h.el().classList.contains("wn-selected"), h.el().getAttribute("aria-selected"), h.opened]).toEqual([true, "true", []]);
    h.drag(h.el(), 1);
    expect(h.opened).toEqual(["o1"]);
    h.el().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(h.opened).toEqual(["o1", "o1"]);
    expect(h.commits).toHaveLength(0);
  });

  it("fantôme figé tant que la promesse rendue par onTimeoffCommit n'est pas réglée (avertissement BR-04)", async () => {
    let done!: () => void;
    const h = setup({ commit: () => new Promise<void>((r) => { done = r; }) });
    h.drag(h.el(), DAY);
    expect([h.ghost()!.style.display, h.ed.busy()]).toEqual(["", true]);
    done();
    await new Promise((r) => setTimeout(r, 0));
    expect([h.ghost()!.style.display, h.ed.busy()]).toEqual(["none", false]);
  });

  it("lecture seule : aucun geste, aucune ouverture", () => {
    const h = setup({ enabled: false });
    h.drag(h.el(), DAY);
    h.drag(h.el(), 1);
    h.drag(h.el(), 1);
    expect([h.commits, h.opened]).toEqual([[], []]);
  });
});

describe("clavier", () => {
  it("flèches cumulées dans un brouillon (demi-journée en vue jour), Maj étire la fin, Alt le début ; Entrée valide", () => {
    const h = setup();
    const t = h.el();
    t.focus();
    h.key(t, "ArrowRight");
    h.key(t, "ArrowRight", { shiftKey: true });
    h.key(t, "ArrowLeft", { altKey: true });
    expect(h.previews.at(-1)).toBe("2026-10-20am..2026-10-22pm");
    expect(h.commits).toHaveLength(0);
    h.key(t, "Enter");
    expect(h.commits.map((c) => [c.patch, c.via])).toEqual([[{ endDate: "2026-10-22" }, "keyboard"]]);
    expect(h.previews.at(-1)).toBeNull();
  });

  it("Échap annule sans écrire ; ↑ ↓ et Ctrl + ↓ ne font rien (ni hauteur ni personne)", () => {
    const h = setup();
    const t = h.el();
    t.focus();
    h.key(t, "ArrowRight");
    h.key(t, "Escape");
    expect(h.previews.at(-1)).toBeNull();
    for (const [k, m] of [["ArrowUp", {}], ["ArrowDown", { ctrlKey: true }]] as const) {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...m });
      t.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(h.commits).toHaveLength(0);
  });

  it("Entrée sans brouillon : ouverture du congé", () => {
    const h = setup();
    h.el().focus();
    h.key(h.el(), "Enter");
    expect(h.opened).toEqual(["o1"]);
  });
});

describe("toucher", () => {
  it("tap : sélection et poignées de début et de fin ; appui long : glisser armé, déplacement validé", () => {
    vi.useFakeTimers();
    const h = setup();
    h.ptr("pointerdown", h.el(), 5, 5, { pointerType: "touch" });
    h.ptr("pointerup", document, 5, 5, { pointerType: "touch" });
    expect(h.el().classList.contains("wn-selected")).toBe(true);
    expect([...h.el().querySelectorAll("[data-handle]")].map((x) => x.getAttribute("data-handle"))).toEqual(["start", "end"]);
    h.ptr("pointerdown", document.body, 900, 900, { pointerType: "touch" });
    h.ptr("pointerup", document, 900, 900, { pointerType: "touch" });
    h.ptr("pointerdown", h.root, 900, 900, { pointerType: "touch" });
    h.ptr("pointerup", document, 900, 900, { pointerType: "touch" });
    expect(h.el().classList.contains("wn-selected")).toBe(false);
    h.ptr("pointerdown", h.el(), 5, 5, { pointerType: "touch" });
    vi.advanceTimersByTime(450);
    expect(h.el().classList.contains("wn-armed")).toBe(true);
    h.ptr("pointermove", document, 5 + DAY, 5, { pointerType: "touch" });
    h.frame();
    h.ptr("pointerup", document, 5 + DAY, 5, { pointerType: "touch" });
    expect(h.spans()).toEqual([{ startDate: "2026-10-21", endDate: "2026-10-22" }]);
  });
});
