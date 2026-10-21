// @vitest-environment jsdom
// Déclencheurs de la pop-in du créneau dans l'éditeur de gestes : Q5 (clic = sélection, clic sur le bloc sélectionné, double
// clic ou Entrée = ouverture ; glisser = geste) et RT-015 (clic ou glisser en zone libre = bloc provisoire puis création ;
// Échap annule ; clearDraft ne retire que le bloc provisoire visé).
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createBlockEditor, type CreateRequest, type EditRequest, type OpenRequest } from "../src/schedule/block-editor";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

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
});

function setup(enabled = true) {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.appendChild(root);
  const frames: (() => void)[] = [];
  const clock: Partial<Clock> = { raf: (cb) => (frames.push(cb), frames.length), caf: () => {}, now: () => 0, idle: () => {}, setTimer: () => 0, clearTimer: () => {} };
  const frame = () => { for (const f of frames.splice(0)) f(); };
  const s = createScroller({
    root, data: data([alloc("1", "1"), alloc("2", "2", { repeatState: "weekly", repeatEndDate: "2026-11-30" })]), today: "2026-10-20",
    widthPx: GUTTER_PX + 960, heightPx: 480, label: (c) => c.from, clock, reducedMotion: () => true,
  });
  const commits: EditRequest[] = [];
  const opens: OpenRequest[] = [];
  const creates: CreateRequest[] = [];
  const ed = createBlockEditor({
    root, host: s.host, clock, enabled: () => enabled, onCommit: (r) => { commits.push(r); },
    onOpen: (r) => opens.push(r), onCreate: (r) => creates.push(r),
  });
  const block = (key: string) => root.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`)!;
  const draft = () => root.querySelector<HTMLElement>(".wn-slot-draft");
  const ptr = (type: string, target: EventTarget, x: number, y: number, pointerType = "mouse") => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "pointerType", { value: pointerType });
    target.dispatchEvent(e);
  };
  const click = (target: EventTarget, x = 5, y = 5, pointerType = "mouse") => { ptr("pointerdown", target, x, y, pointerType); ptr("pointerup", document, x, y, pointerType); };
  const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  /** Abscisse (fenêtre) du milieu d'un jour : jsdom place la grille en (0, 0). */
  const xOf = (date: string) => s.host.xOfDate(date) + 5;
  const row = () => root.querySelector<HTMLElement>(".wn-row")!;
  return { root, s, ed, commits, opens, creates, block, draft, ptr, click, key, frame, xOf, row };
}

describe("Q5 : sélection puis ouverture", () => {
  it("clic : sélection seule ; second clic sur le bloc sélectionné : ouverture (clé, allocation, occurrence)", () => {
    const h = setup();
    h.click(h.block("1:0"));
    expect(h.block("1:0").classList.contains("wn-selected")).toBe(true);
    expect(h.opens).toHaveLength(0);
    h.click(h.block("1:0"));
    expect(h.opens.map((o) => [o.key, o.allocationId, o.occurrence])).toEqual([["1:0", "1", null]]);
    expect(h.commits).toHaveLength(0);
  });

  it("double clic : ouverture, rang de l'occurrence pour une série", () => {
    const h = setup();
    h.block("2:0").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(h.opens.map((o) => [o.allocationId, o.occurrence])).toEqual([["2", 0]]);
    expect(h.block("2:0").getAttribute("aria-selected")).toBe("true");
  });

  it("Entrée sur le bloc focalisé : ouverture ; avec un brouillon clavier, Entrée valide le geste sans ouvrir", () => {
    const h = setup();
    const b = h.block("1:0");
    b.focus();
    h.key(b, "Enter");
    expect(h.opens).toHaveLength(1);
    h.key(b, "ArrowRight");
    h.key(b, "Enter");
    expect(h.opens).toHaveLength(1);
    expect(h.commits.map((c) => c.patch)).toEqual([{ startDate: "2026-10-21", endDate: "2026-10-22" }]);
  });

  it("glisser un bloc déjà sélectionné : geste validé, pas d'ouverture", () => {
    const h = setup();
    h.click(h.block("1:0"));
    h.ptr("pointerdown", h.block("1:0"), 0, 0);
    h.ptr("pointermove", document, 200, 0);
    h.frame();
    h.ptr("pointerup", document, 200, 0);
    expect(h.commits).toHaveLength(1);
    expect(h.opens).toHaveLength(0);
  });

  it("toucher : un tap sélectionne, un tap sur le bloc sélectionné ouvre", () => {
    const h = setup();
    h.click(h.block("1:0"), 5, 5, "touch");
    expect(h.opens).toHaveLength(0);
    h.click(h.block("1:0"), 5, 5, "touch");
    expect(h.opens.map((o) => o.key)).toEqual(["1:0"]);
  });

  it("lecture seule : ni ouverture ni création", () => {
    const h = setup(false);
    h.block("1:0").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    h.click(h.row(), h.xOf("2026-10-23"));
    expect([h.opens.length, h.creates.length, h.draft()]).toEqual([0, 0, null]);
  });
});

describe("RT-015 : bloc provisoire en zone libre", () => {
  it("clic en zone libre : bloc provisoire d'un jour sur la ligne, puis demande de création", () => {
    const h = setup();
    h.click(h.row(), h.xOf("2026-10-23"));
    expect(h.creates.map((c) => [c.personId, c.startDate, c.endDate])).toEqual([["1", "2026-10-23", "2026-10-23"]]);
    expect(h.draft()!.style.display).toBe("");
    expect(h.draft()!.style.transform).toBe(`translate(${h.s.host.xOfDate("2026-10-23")}px, 0px)`);
  });

  it("glisser vers la gauche : la plage va du jour atteint au jour de départ", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-26"), 5);
    h.ptr("pointermove", document, h.xOf("2026-10-23"), 5);
    expect(h.draft()!.style.width).toBe(`${4 * h.s.host.pxPerDay()}px`);
    h.ptr("pointerup", document, h.xOf("2026-10-23"), 5);
    expect(h.creates.map((c) => [c.startDate, c.endDate])).toEqual([["2026-10-23", "2026-10-26"]]);
  });

  it("Échap pendant le glisser : rien n'est demandé, bloc provisoire retiré", () => {
    const h = setup();
    h.ptr("pointerdown", h.row(), h.xOf("2026-10-23"), 5);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    h.ptr("pointerup", document, h.xOf("2026-10-24"), 5);
    expect(h.creates).toHaveLength(0);
    expect(h.draft()!.style.display).toBe("none");
  });

  it("clearDraft : retire le bloc visé, ignore un identifiant périmé (nouveau bloc déjà posé)", () => {
    const h = setup();
    h.click(h.row(), h.xOf("2026-10-23"));
    const first = h.creates[0]!.draft;
    h.click(h.row(), h.xOf("2026-10-27"));
    h.ed.clearDraft(first);
    expect(h.draft()!.style.display).toBe("");
    h.ed.clearDraft(h.creates[1]!.draft);
    expect(h.draft()!.style.display).toBe("none");
  });

  it("pas de création sur un bloc, la colonne des personnes ni la bande de capacité", () => {
    const h = setup();
    h.click(h.row(), 100);
    h.click(h.root.querySelector(".wn-rowheader")!, GUTTER_PX + 10);
    const cap = h.root.querySelector(".wn-cap");
    if (cap) h.click(cap, h.xOf("2026-10-23"));
    expect(h.creates).toHaveLength(0);
  });
});
