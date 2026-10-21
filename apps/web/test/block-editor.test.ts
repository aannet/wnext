// @vitest-environment jsdom
// Édition des blocs par gestes (ADR-002 §5-6) : pointeur (déplacer, changer de ligne, poignées, hauteur au pas HOURS_STEP),
// Échap, défilement automatique près des bords, clavier (keyGesture cumulé, Entrée / Échap), séries (deux patchs, fantôme
// figé pendant le choix), nombre de nœuds stable après plusieurs gestes.
import type { ScheduleResponse } from "@wnext/contracts";
import { DEFAULT_PX_PER_DAY, HOURS_STEP, addDays } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { patched } from "../src/data/allocation-edits";
import { createBlockEditor, type EditRequest } from "../src/schedule/block-editor";
import { DENSITY_METRICS, type Density } from "../src/schedule/density";
import { CAP_PX, ROW_UNIT_PX } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

const TODAY = "2026-10-20";
const DAY = DEFAULT_PX_PER_DAY.day;
const ROW = ROW_UNIT_PX + CAP_PX;

type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, personId: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId, projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;

function data(allocations: Alloc[], schedule?: Record<string, unknown>): ScheduleResponse {
  return {
    window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 3 },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: ["1", "2", "3"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null,
      country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true, ...(id === "1" && schedule) })),
    allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
    projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
  };
}

const BASE = [
  alloc("1", "1"),
  alloc("2", "2", { startDate: "2026-10-19", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-30" }),
  alloc("3", "3", { mode: "percentage", hoursPerDay: null, percent: 50 } as Partial<Alloc>),
];

function setup(onCommit: (r: EditRequest) => void | Promise<unknown> = () => {}, schedule?: Record<string, unknown>, density?: Density) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const frames: (() => void)[] = [];
  const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
  const frame = (n = 1) => { for (let i = 0; i < n; i++) for (const f of frames.splice(0)) f(); };
  const s = createScroller({ root, data: data(BASE, schedule), today: TODAY, widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, clock, reducedMotion: () => true, ...(density ? { density } : {}) });
  const commits: EditRequest[] = [];
  const previews: (string | null)[] = [];
  const ed = createBlockEditor({
    root, host: s.host, clock, onCommit: (r) => { commits.push(r); return onCommit(r); },
    onPreview: (p) => previews.push(p && `${p.draft.personId}:${p.draft.startDate}..${p.draft.endDate}:${p.draft.hoursPerDay ?? p.draft.percent}`),
  });
  const block = (key: string) => root.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
  const ghost = () => root.querySelector<HTMLElement>(".wn-ghost");
  const ptr = (type: string, target: EventTarget, x: number, y: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    target.dispatchEvent(e);
  };
  /** Glisser de (0, 0) à (dx, dy) depuis `target` (bloc ou poignée). */
  const drag = (target: Element, dx: number, dy: number) => {
    ptr("pointerdown", target, 0, 0);
    ptr("pointermove", document, dx, dy);
    frame();
    ptr("pointerup", document, dx, dy);
  };
  const key = (target: Element, k: string, mods: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  /** Poignée du bloc survolé (un seul jeu de poignées, posé au survol). */
  const handle = (k: string, which: string) => {
    ptr("pointerover", block(k), 0, 0);
    return block(k).querySelector(`[data-handle=${which}]`)!;
  };
  return { root, s, ed, commits, previews, block, ghost, ptr, drag, key, frame, handle };
}

describe("pointeur", () => {
  it("glisser de deux jours : fantôme pendant le geste, patch des dates à la fin", () => {
    const h = setup();
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointermove", document, 2 * DAY + 10, 0);
    h.frame();
    expect(h.ghost()!.style.display).toBe("");
    expect(h.ghost()!.style.transform).toBe(`translate(${h.s.host.xOfDate("2026-10-22")}px, 0px)`);
    expect(h.commits).toHaveLength(0);
    h.ptr("pointerup", document, 2 * DAY + 10, 0);
    expect(h.commits.map((c) => [c.allocationId, c.patch, c.occurrence, c.via])).toEqual([["1", { startDate: "2026-10-22", endDate: "2026-10-23" }, null, "pointer"]]);
    expect(h.ghost()!.style.display).toBe("none");
  });

  it("glisser vers la ligne suivante : changement de personne", () => {
    const h = setup();
    h.drag(h.block("1:0"), 0, ROW);
    expect(h.commits[0]!.patch).toEqual({ personId: "2" });
  });

  it("poignées : étirer la fin, avancer le début", () => {
    const h = setup();
    h.drag(h.handle("1:0", "end"), DAY, 0);
    h.drag(h.handle("1:0", "start"), -DAY, 0);
    expect(h.commits.map((c) => c.patch)).toEqual([{ endDate: "2026-10-22" }, { startDate: "2026-10-19" }]);
  });

  it("poignée basse : hauteur aimantée au pas de HOURS_STEP (et de PERCENT_STEP en %)", () => {
    const h = setup();
    // 4 px vers le haut sur 48 px pour 8 h = 0,67 h, aimanté à 0,5 h.
    h.drag(h.handle("1:0", "height"), 0, 4);
    h.drag(h.handle("3:0", "height"), 0, -12);
    expect(h.commits.map((c) => c.patch)).toEqual([{ hoursPerDay: 8 - HOURS_STEP }, { percent: 75 }]);
  });

  it("densité aérée (RT-005) : la conversion pixels -> heures et le changement de ligne suivent les hauteurs de la densité", () => {
    const { rowUnitPx, capPx } = DENSITY_METRICS.airy;
    const h = setup(() => {}, undefined, "airy");
    // Un quart de la hauteur d'une journée aérée = 2 h de plus ; avec les 48 px de la densité compacte, ce serait 3 h.
    h.drag(h.handle("1:0", "height"), 0, -rowUnitPx / 4);
    h.drag(h.block("1:0"), 0, rowUnitPx + capPx);
    expect(h.commits.map((c) => c.patch)).toEqual([{ hoursPerDay: 10 }, { personId: "2" }]);
  });

  // @BR-19
  it("poignée basse : la conversion pixels -> heures suit l'horaire daté en vigueur au début du bloc", () => {
    const four = [4, 4, 4, 4, 4, 0, 0];
    const h = setup(() => {}, { workSchedule: [
      { validFrom: null, validTo: "2026-10-24", workDaysHours: four }, { validFrom: "2026-10-25", validTo: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
    ] });
    // 12 px sur 48 px = un quart de la journée de référence : 1 h sur 4 h (et non 2 h sur la période ouverte de 8 h).
    h.drag(h.handle("1:0", "height"), 0, -12);
    expect(h.commits.map((c) => c.patch)).toEqual([{ hoursPerDay: 9 }]);
  });

  it("simple clic : rien ; Échap pendant le glisser : annulé, fantôme masqué", () => {
    const h = setup();
    h.drag(h.block("1:0"), 1, 1);
    const b = h.block("1:0");
    h.ptr("pointerdown", b, 0, 0);
    h.ptr("pointermove", document, 3 * DAY, 0);
    h.frame();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(h.ghost()!.style.display).toBe("none");
    h.ptr("pointerup", document, 3 * DAY, 0);
    expect(h.commits).toHaveLength(0);
    expect(h.ed.busy()).toBe(false);
  });

  it("près du bord droit : la grille défile seule et le geste suit", () => {
    const h = setup();
    h.root.getBoundingClientRect = () => ({ left: 0, top: 0, right: GUTTER_PX + 960, bottom: 480, width: GUTTER_PX + 960, height: 480, x: 0, y: 0, toJSON: () => ({}) });
    const sl = h.root.scrollLeft;
    h.ptr("pointerdown", h.block("1:0"), 300, 100);
    h.ptr("pointermove", document, GUTTER_PX + 958, 100);
    h.frame(20);
    expect(h.root.scrollLeft).toBeGreaterThan(sl);
    h.ptr("pointerup", document, GUTTER_PX + 958, 100);
    const moved = Math.round((GUTTER_PX + 958 - 300 + h.root.scrollLeft - sl) / DAY);
    expect(h.commits[0]!.patch).toEqual({ startDate: addDays("2026-10-20", moved), endDate: addDays("2026-10-21", moved) });
  });
});

describe("série", () => {
  it("geste sur une occurrence : patch de la série et patch de l'occurrence ; fantôme figé jusqu'au choix", async () => {
    let choose!: () => void;
    const h = setup(() => new Promise<void>((r) => { choose = r; }));
    h.drag(h.block("2:1"), DAY, 0);
    const c = h.commits[0]!;
    expect([c.occurrence, c.patch, c.occurrencePatch]).toEqual([1,
      { startDate: "2026-10-20", endDate: "2026-10-21", repeatEndDate: "2026-12-01" }, { startDate: "2026-10-27", endDate: "2026-10-28" }]);
    expect(h.ghost()!.style.display).toBe("");
    expect(h.ed.busy()).toBe(true);
    choose();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.ghost()!.style.display).toBe("none");
    expect(h.ed.busy()).toBe(false);
  });
});

describe("clavier", () => {
  it("flèches cumulées dans un brouillon annoncé, Entrée valide, focus rendu au bloc", () => {
    const h = setup();
    const b = h.block("1:0");
    b.focus();
    h.key(b, "ArrowRight");
    h.key(b, "ArrowRight");
    h.key(b, "ArrowRight", { shiftKey: true });
    h.key(b, "ArrowUp");
    expect(h.previews.at(-1)).toBe("1:2026-10-22..2026-10-24:8.5");
    expect(h.commits).toHaveLength(0);
    h.key(b, "Enter");
    expect(h.commits.map((c) => [c.patch, c.via])).toEqual([[{ startDate: "2026-10-22", endDate: "2026-10-24", hoursPerDay: 8.5 }, "keyboard"]]);
    expect(h.previews.at(-1)).toBeNull();
    h.frame(2);
    expect(document.activeElement).toBe(h.block("1:0"));
  });

  it("Ctrl + ↓ change de personne ; Échap annule sans écrire", () => {
    const h = setup();
    const b = h.block("1:0");
    b.focus();
    h.key(b, "ArrowDown", { ctrlKey: true });
    expect(h.previews.at(-1)).toBe("2:2026-10-20..2026-10-21:8");
    h.key(b, "Escape");
    expect(h.previews.at(-1)).toBeNull();
    h.key(b, "Enter");
    expect(h.commits).toHaveLength(0);
    h.key(b, "ArrowDown", { ctrlKey: true });
    h.key(b, "Enter");
    expect(h.commits[0]!.patch).toEqual({ personId: "2" });
  });

  it("les flèches d'un bloc ne font pas défiler la grille (propagation arrêtée)", () => {
    const h = setup();
    let reached = 0;
    h.root.parentElement!.addEventListener("keydown", () => reached++);
    h.key(h.block("1:0"), "ArrowLeft");
    expect(reached).toBe(0);
  });
});

it("nombre de nœuds stable après plusieurs gestes validés (recyclage, un seul fantôme)", () => {
  let current = BASE;
  const h = setup((r) => {
    current = current.map((a) => (a.id === r.allocationId ? patched({ ...a, version: a.version + 1 }, r.patch) : a));
    h.s.setData(data(current));
  });
  h.drag(h.block("1:0"), DAY, 0);
  h.drag(h.handle("1:0", "height"), 0, -6); // poignées et fantôme créés une fois pour toutes
  const nodes = h.s.stats().nodes;
  for (let i = 0; i < 6; i++) {
    h.drag(h.block("1:0"), i % 2 ? DAY : -DAY, 0);
    h.drag(h.handle("1:0", "height"), 0, i % 2 ? 6 : -6);
  }
  expect(h.commits).toHaveLength(14);
  expect(h.s.stats().nodes).toBe(nodes);
  expect(h.root.querySelectorAll(".wn-ghost")).toHaveLength(1);
  const g = h.root.querySelector<HTMLElement>(".wn-ghost")!.style;
  expect([g.top, g.left]).toEqual(["0px", "0px"]); // même origine que les blocs : seul le transform place le fantôme
  expect(h.root.querySelectorAll("[data-handle]")).toHaveLength(3);
});
