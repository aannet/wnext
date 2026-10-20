// Saisie des congés (BR-04) : conflits avec les allocations et temps saisi signalé, report assisté choisi par allocation,
// écritures en une seule action d'annulation (BR-40) rejouée en bloc. Démo locale comme source (écritures immédiates).
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import type { ScheduleEditor } from "../src/data/allocation-edits";
import { createDemoSource } from "../src/data/demo-source";
import type { RecordEditor } from "../src/data/record-edits";
import { historyForSource } from "../src/schedule/history";
import { planResolution, runTimeoffAction, timeoffConflicts, type TimeoffDraft } from "../src/schedule/timeoff-flow";

type Alloc = ScheduleResponse["allocations"][number];
type Timeoff = ScheduleResponse["timeoffs"][number];
// Lundi 19 octobre 2026 .. vendredi 23.
const MON = "2026-10-19", TUE = "2026-10-20", WED = "2026-10-21", THU = "2026-10-22", FRI = "2026-10-23", NEXT_MON = "2026-10-26";
const alloc = (id: string, startDate: string, endDate: string, hoursPerDay = 8, over: Partial<Alloc> = {}): Alloc => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null, startDate, endDate,
  status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay, percent: null, ...over,
}) as Alloc;
const off = (id: string, over: Partial<Timeoff> = {}): Timeoff => ({
  id, version: 1, personId: "1", typeId: "t1", startDate: WED, endDate: WED, scope: "full_day", startHalf: "am", endHalf: "pm",
  hoursPerDay: null, approvalStatus: "approved", ...over,
});
const data = (allocations: Alloc[], timeoffs: Timeoff[] = []): ScheduleResponse => ({
  window: { from: "2026-10-01", to: "2026-12-31" }, changeCursor: "0", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
  allocations, timeoffs, holidays: [], departments: [], roles: [],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }, { id: "t2", version: 1, name: "Télétravail", deducted: false }],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});
const draft = (over: Partial<TimeoffDraft> = {}): TimeoffDraft => {
  const { id: _i, version: _v, ...rest } = off("x");
  return { ...rest, id: null, ...over };
};

describe("conflits d'un congé (BR-04)", () => {
  it("journée entière approuvée sur une allocation : jour, allocation et propositions ; assistant proposé", () => {
    const r = timeoffConflicts(data([alloc("a", MON, FRI)]), draft());
    expect(r.days).toEqual([expect.objectContaining({ day: WED, plannedHours: 8, loggedHours: 0, allocations: [{ allocationId: "a", hours: 8 }] })]);
    expect(r.assistant).toBe(true);
    expect(r.resolutions[0]!.moves).toEqual([{ allocationId: "a", fromDay: WED, toDay: NEXT_MON, hours: 8 }]);
  });
  it("temps saisi signalé ; en attente : avertissement sans assistant ; type non déduit : rien", () => {
    const d = data([alloc("a", WED, WED)]);
    expect(timeoffConflicts(d, draft(), [{ personId: "1", day: WED, hours: 3 }]).days[0]!.loggedHours).toBe(3);
    expect(timeoffConflicts(d, draft({ approvalStatus: "pending" }))).toMatchObject({ assistant: false, days: [{ day: WED }] });
    expect(timeoffConflicts(d, draft({ typeId: "t2" })).days).toEqual([]);
    expect(timeoffConflicts(d, draft({ typeId: "zz" })).days).toEqual([]);
  });
  it("modification : le congé lui-même n'est pas compté deux fois", () => {
    const d = data([alloc("a", WED, WED)], [off("o1", { endHalf: "am" })]);
    expect(timeoffConflicts(d, draft({ id: "o1" })).days[0]).toMatchObject({ capacityHours: 0, timeoffHours: 8 });
  });
});

describe("plan du report", () => {
  it("choix par allocation : garder n'écrit rien, reporter et réduire donnent leurs écritures", () => {
    const d = data([alloc("a", MON, FRI, 4), alloc("b", WED, WED, 4)]);
    const { resolutions } = timeoffConflicts(d, draft());
    expect(planResolution(d, "1", resolutions, { a: "keep", b: "keep" })).toEqual([]);
    const w = planResolution(d, "1", resolutions, { a: "reduce", b: "move" });
    expect(w.map((x) => [x.allocationId, x.update, x.creates.length])).toEqual([["a", { startDate: MON, endDate: TUE }, 1], ["b", { startDate: FRI, endDate: FRI }, 0]]); // jeudi : la marge proposée pour le report de « a »
    expect(planResolution(d, "zz", resolutions, { a: "move" })).toEqual([]);
  });
});

function setup(allocations: Alloc[], timeoffs: Timeoff[] = []) {
  const source = createDemoSource(data(allocations, timeoffs));
  const { history } = historyForSource(source);
  const deps = { editor: source as ScheduleEditor & RecordEditor, data: () => source.getState().data!, record: history.record };
  const view = () => ({
    allocs: source.getState().data!.allocations.map((a) => `${a.startDate}..${a.endDate}:${a.hoursPerDay}`).sort(),
    offs: source.getState().data!.timeoffs.map((t) => `${t.startDate}..${t.endDate}`),
  });
  return { source, history, deps, view };
}

describe("écritures en une action d'annulation", () => {
  it("poser un congé et reporter : congé créé, allocation coupée et prolongée ; Ctrl+Z défait tout, Ctrl+Maj+Z refait tout", async () => {
    const h = setup([alloc("a", MON, FRI)]);
    const before = h.view();
    const d = h.deps.data();
    const { resolutions } = timeoffConflicts(d, draft());
    const writes = planResolution(d, "1", resolutions, { a: "move" });
    const out = await runTimeoffAction(h.deps, { kind: "create", body: { personId: "1", typeId: "t1", startDate: WED, endDate: WED, approvalStatus: "approved" }, writes });
    expect(out).toMatchObject({ ok: true });
    expect(h.view()).toEqual({ allocs: [`${MON}..${TUE}:8`, `${THU}..${NEXT_MON}:8`], offs: [`${WED}..${WED}`] });
    expect(h.history.getState()).toMatchObject({ canUndo: true, undoLabel: "timeoff.reschedule" });
    expect(await h.history.undo()).toMatchObject({ ok: true, label: "timeoff.reschedule" });
    expect(h.view()).toEqual(before);
    expect(await h.history.redo()).toMatchObject({ ok: true });
    expect(h.view()).toEqual({ allocs: [`${MON}..${TUE}:8`, `${THU}..${NEXT_MON}:8`], offs: [`${WED}..${WED}`] });
  });
  it("réduire jusqu'à supprimer : l'allocation est supprimée puis recréée par l'annulation", async () => {
    const h = setup([alloc("a", WED, WED)]);
    const d = h.deps.data();
    const writes = planResolution(d, "1", timeoffConflicts(d, draft()).resolutions, { a: "reduce" });
    await runTimeoffAction(h.deps, { kind: "create", body: { personId: "1", typeId: "t1", startDate: WED, endDate: WED, approvalStatus: "approved" }, writes });
    expect(h.view().allocs).toEqual([]);
    await h.history.undo();
    expect(h.view()).toEqual({ allocs: [`${WED}..${WED}:8`], offs: [] });
  });
  it("modifier puis supprimer un congé : deux actions, annulées dans l'ordre", async () => {
    const h = setup([], [off("o1")]);
    expect(await runTimeoffAction(h.deps, { kind: "update", id: "o1", patch: { endDate: THU } })).toEqual({ ok: true, timeoffId: "o1" });
    expect(h.history.getState().undoLabel).toBe("timeoff.update");
    expect(await runTimeoffAction(h.deps, { kind: "delete", id: "o1" })).toEqual({ ok: true, timeoffId: null });
    expect(h.view().offs).toEqual([]);
    await h.history.undo();
    expect(h.view().offs).toEqual([`${WED}..${THU}`]);
    await h.history.undo();
    expect(h.view().offs).toEqual([`${WED}..${WED}`]);
  });
  it("refus du congé : rien d'écrit ni d'enregistré ; refus en cours de route : ce qui est écrit reste annulable", async () => {
    const h = setup([alloc("a", MON, FRI)], [off("o1")]);
    expect(await runTimeoffAction(h.deps, { kind: "create", body: { personId: "1", typeId: "t1", startDate: WED, endDate: WED } }))
      .toEqual({ ok: false, error: "TIMEOFF_OVERLAP", partial: false });
    expect(h.history.getState().canUndo).toBe(false);
    expect(await runTimeoffAction(h.deps, { kind: "delete", id: "nope" })).toEqual({ ok: false, error: "NOT_FOUND", partial: false });
    expect(await runTimeoffAction(h.deps, { kind: "update", id: "nope", patch: { endDate: THU } })).toMatchObject({ ok: false, error: "NOT_FOUND" });
    const ghost = [{ allocationId: "gone", update: null, creates: [], movedHours: 0, removedHours: 0 }];
    expect(await runTimeoffAction(h.deps, { kind: "update", id: "o1", patch: { endDate: THU }, writes: ghost }))
      .toEqual({ ok: false, error: "NOT_FOUND", partial: true });
    expect(h.history.getState().undoLabel).toBe("timeoff.reschedule");
  });
});

// @BR-19
describe("plan du report et horaire daté", () => {
  it("les pourcentages sont convertis avec l'horaire en vigueur chaque jour (4 h avant jeudi, 8 h ensuite)", () => {
    const d = data([alloc("a", MON, FRI, 0, { mode: "percentage", hoursPerDay: null, percent: 50 })]);
    d.people[0] = { ...d.people[0]!, workDaysHours: [8, 8, 8, 8, 8, 0, 0], workSchedule: [
      { validFrom: null, validTo: WED, workDaysHours: [4, 4, 4, 4, 4, 0, 0] }, { validFrom: THU, validTo: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
    ] } as typeof d.people[number];
    const resolutions = [{ day: WED, reduce: [{ allocationId: "a", toHours: 0 }], moves: [], unplacedHours: 0 }];
    // mercredi : 50 % de 4 h = 2 h retirées (et non 4 h avec l'horaire de la période ouverte).
    expect(planResolution(d, "1", resolutions, { a: "reduce" })[0]!.removedHours).toBe(2);
  });
});
