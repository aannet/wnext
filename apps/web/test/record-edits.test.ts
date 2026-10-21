// Écritures hors gestes (congés, allocations créées / supprimées par le report assisté BR-04) : optimistes, id du serveur
// rendu à la création, retour arrière et code stable sur refus (TIMEOFF_OVERLAP), If-Match ; temps saisi lu seulement.
// Démo locale : même comportement sans serveur. API simulée.
import type { ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createDemoSource } from "../src/data/demo-source";
import { allocationCreateOf, allocationFromCreate, overlapsTimeoff, timeoffCreateOf, timeoffFromCreate } from "../src/data/record-edits";
import { createScheduleSource } from "../src/data/schedule-source";

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
type Timeoff = ScheduleResponse["timeoffs"][number];
type Alloc = ScheduleResponse["allocations"][number];
const off = (id: string, over: Partial<Timeoff> = {}): Timeoff => ({
  id, version: 2, personId: "1", typeId: "t1", startDate: "2026-10-20", endDate: "2026-10-20", scope: "full_day", startHalf: "am", endHalf: "pm",
  hoursPerDay: null, approvalStatus: "approved", ...over,
});
const alloc = (id: string): Alloc => ({
  id, version: 3, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed", billable: true, priority: 0,
  repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 4, percent: null,
}) as Alloc;
const page = (from: string, to: string, timeoffs: Timeoff[], allocations: Alloc[]): ScheduleResponse => ({
  window: { from, to }, changeCursor: "5", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
  allocations, timeoffs, holidays: [], timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }], departments: [], roles: [],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});

interface Call { method: string; path: string; headers: Record<string, string>; body: any; reply(status: number, body?: unknown): void }

async function harness(timeoffs: Timeoff[] = [off("o1")], allocations: Alloc[] = [alloc("a1")]) {
  const calls: Call[] = [];
  const fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => new Promise<FetchResponse>((res) => {
    const u = new URL(url, "http://x");
    const reply = (status: number, body?: unknown) => res({ status, json: async () => body });
    if (u.pathname === "/api/v1/schedule") return reply(200, page(u.searchParams.get("from")!, u.searchParams.get("to")!, timeoffs, allocations));
    calls.push({ method: init.method, path: u.pathname + u.search, headers: init.headers ?? {}, body: init.body && JSON.parse(init.body), reply });
  });
  const s = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
  s.setViewport(viewAt("2026-10-19", "day", 960));
  s.start();
  await flush();
  const offs = () => s.getState().data!.timeoffs.map((t) => `${t.id}@${t.version}:${t.startDate}..${t.endDate}`).sort();
  const allocs = () => s.getState().data!.allocations.map((a) => `${a.id}@${a.version}`).sort();
  return { s, calls, offs, allocs };
}

describe("congés : écritures optimistes", () => {
  it("création : affichée tout de suite sous un id temporaire, puis remplacée par celle du serveur dont l'id est rendu", async () => {
    const h = await harness([]);
    const p = h.s.createTimeoff({ personId: "1", typeId: "t1", startDate: "2026-10-22", endDate: "2026-10-23", approvalStatus: "approved" });
    expect(h.offs()).toEqual(["tmp-timeoffs-1@0:2026-10-22..2026-10-23"]);
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/timeoffs", body: { personId: "1", startDate: "2026-10-22" } });
    h.calls[0]!.reply(201, off("9", { version: 1, startDate: "2026-10-22", endDate: "2026-10-23" }));
    expect(await p).toEqual({ ok: true, id: "9" });
    expect(h.offs()).toEqual(["9@1:2026-10-22..2026-10-23"]);
  });
  it("chevauchement refusé (TIMEOFF_OVERLAP) : retour arrière, code stable", async () => {
    const h = await harness();
    const p = h.s.createTimeoff({ personId: "1", typeId: "t1", startDate: "2026-10-20", endDate: "2026-10-20" });
    expect(h.offs()).toHaveLength(2);
    h.calls[0]!.reply(409, { code: "TIMEOFF_OVERLAP", message: "x" });
    expect(await p).toEqual({ ok: false, error: "TIMEOFF_OVERLAP" });
    expect(h.offs()).toEqual(["o1@2:2026-10-20..2026-10-20"]);
  });
  it("modification : If-Match de la version lue, état optimiste puis réponse ; réseau : retour arrière", async () => {
    const h = await harness();
    const p = h.s.updateTimeoff("o1", { endDate: "2026-10-21" });
    expect(h.offs()).toEqual(["o1@2:2026-10-20..2026-10-21"]);
    expect(h.calls[0]).toMatchObject({ method: "PATCH", path: "/api/v1/timeoffs/o1", headers: { "If-Match": '"2"' }, body: { endDate: "2026-10-21" } });
    expect(await h.s.updateTimeoff("o1", { endDate: "2026-10-22" })).toEqual({ ok: false, error: "BUSY" });
    h.calls[0]!.reply(200, off("o1", { version: 3, endDate: "2026-10-21" }));
    expect(await p).toEqual({ ok: true });
    expect(h.offs()).toEqual(["o1@3:2026-10-20..2026-10-21"]);
    const q = h.s.updateTimeoff("o1", { endDate: "2026-10-23" });
    h.calls[1]!.reply(409, { code: "VERSION_CONFLICT", message: "x" });
    expect(await q).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    expect(h.offs()).toEqual(["o1@3:2026-10-20..2026-10-21"]);
    expect(await h.s.updateTimeoff("nope", { endDate: "2026-10-23" })).toEqual({ ok: false, error: "NOT_FOUND" });
  });
  it("suppression : disparaît tout de suite, DELETE avec If-Match ; 204 la confirme", async () => {
    const h = await harness();
    const p = h.s.deleteTimeoff("o1");
    expect(h.offs()).toEqual([]);
    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: "/api/v1/timeoffs/o1", headers: { "If-Match": '"2"' } });
    h.calls[0]!.reply(204);
    expect(await p).toEqual({ ok: true });
    expect(h.offs()).toEqual([]);
  });
});

describe("allocations créées / supprimées (report assisté)", () => {
  it("création puis suppression ; refus de suppression : l'allocation revient", async () => {
    const h = await harness([]);
    const p = h.s.createAllocation(allocationCreateOf({ ...alloc("x"), startDate: "2026-10-26", endDate: "2026-10-26" }));
    expect(h.allocs()).toEqual(["a1@3", "tmp-allocations-1@0"]);
    expect(h.calls[0]!.body).toMatchObject({ projectId: "1", startDate: "2026-10-26", load: { mode: "hours", hoursPerDay: 4 } });
    h.calls[0]!.reply(201, { ...alloc("7"), version: 1, startDate: "2026-10-26", endDate: "2026-10-26" });
    expect(await p).toEqual({ ok: true, id: "7" });
    const d = h.s.deleteAllocation("a1");
    expect(h.allocs()).toEqual(["7@1"]);
    h.calls[1]!.reply(403, { code: "FORBIDDEN", message: "x" });
    expect(await d).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(h.allocs()).toEqual(["7@1", "a1@3"]);
  });
  it("temps saisi : lu par personne et fenêtre (jour, heures) ; erreur : null", async () => {
    const h = await harness();
    const p = h.s.loggedTime("1", "2026-10-20", "2026-10-21");
    expect(h.calls[0]!.path).toBe("/api/v1/logged-time?personId=1&from=2026-10-20&to=2026-10-21");
    h.calls[0]!.reply(200, { items: [{ id: "l", version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, allocationId: null, workDate: "2026-10-20", hours: 3, billable: true, notes: null, status: "submitted" }] });
    expect(await p).toEqual([{ personId: "1", day: "2026-10-20", hours: 3 }]);
    const q = h.s.loggedTime("1", "2026-10-20", "2026-10-21");
    h.calls[1]!.reply(500, { code: "INTERNAL_ERROR", message: "x" });
    expect(await q).toBeNull();
  });
  it("sans écritures dans l'API : UNSUPPORTED, sans temps saisi : null", async () => {
    const s = createScheduleSource({ api: { getSchedule: async () => ({ ok: false, status: 500, error: { code: "INTERNAL_ERROR", message: "" } }), createRealtimeTicket: async () => ({ ok: false, status: 500, error: { code: "INTERNAL_ERROR", message: "" } }) } as never });
    expect(await s.createTimeoff({ personId: "1", typeId: "t1", startDate: "2026-10-20", endDate: "2026-10-20" })).toEqual({ ok: false, error: "UNSUPPORTED" });
    expect(await s.deleteAllocation("a")).toEqual({ ok: false, error: "UNSUPPORTED" });
    expect(await s.loggedTime("1", "2026-10-20", "2026-10-20")).toBeNull();
  });
});

describe("conversions et chevauchement", () => {
  it("défauts du serveur pour un congé ; aller-retour entité <-> corps", () => {
    const t = timeoffFromCreate({ personId: "1", typeId: "t1", startDate: "2026-10-20", endDate: "2026-10-20" }, "x");
    expect(t).toMatchObject({ scope: "full_day", startHalf: "am", endHalf: "pm", approvalStatus: "approved", hoursPerDay: null, version: 0 });
    expect(timeoffFromCreate(timeoffCreateOf(off("o", { scope: "partial", hoursPerDay: 2 })), "o", 2)).toEqual(off("o", { scope: "partial", hoursPerDay: 2 }));
    const pct = { ...alloc("p"), mode: "percentage", hoursPerDay: null, percent: 50 } as Alloc;
    expect(allocationFromCreate(allocationCreateOf(pct), "p", 3)).toEqual(pct);
  });
  it("à la demi-journée près ; refusés et partiels ne comptent pas ; autre personne non plus", () => {
    const list = [off("a", { endHalf: "am" })];
    expect(overlapsTimeoff(list, off("b", { startHalf: "pm" }))).toBe(false);
    expect(overlapsTimeoff(list, off("b"))).toBe(true);
    expect(overlapsTimeoff(list, off("b", { approvalStatus: "declined" }))).toBe(false);
    expect(overlapsTimeoff(list, off("b", { personId: "2" }))).toBe(false);
    expect(overlapsTimeoff([off("a", { scope: "partial", hoursPerDay: 2 })], off("b"))).toBe(false);
    expect(overlapsTimeoff(list, off("a"))).toBe(false); // lui-même (modification)
  });
});

describe("démo locale", () => {
  it("créer, modifier, supprimer un congé ; chevauchement refusé ; allocations créées et supprimées", async () => {
    const s = createDemoSource(page("2026-10-01", "2026-10-31", [off("o1")], [alloc("a1")]));
    expect(await s.createTimeoff({ personId: "1", typeId: "t1", startDate: "2026-10-20", endDate: "2026-10-20" })).toEqual({ ok: false, error: "TIMEOFF_OVERLAP" });
    const c = await s.createTimeoff({ personId: "1", typeId: "t1", startDate: "2026-10-22", endDate: "2026-10-22" });
    expect(c.ok).toBe(true);
    const id = (c as { id: string }).id;
    expect(await s.updateTimeoff(id, { endDate: "2026-10-23" })).toEqual({ ok: true });
    expect(await s.updateTimeoff(id, { startDate: "2026-10-20" })).toEqual({ ok: false, error: "TIMEOFF_OVERLAP" });
    expect(s.getState().data!.timeoffs.find((t) => t.id === id)).toMatchObject({ version: 2, endDate: "2026-10-23" });
    expect(await s.deleteTimeoff(id)).toEqual({ ok: true });
    expect(await s.deleteTimeoff(id)).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await s.updateTimeoff(id, { endDate: "2026-10-23" })).toEqual({ ok: false, error: "NOT_FOUND" });
    const a = await s.createAllocation(allocationCreateOf(alloc("z")));
    expect(s.getState().data!.allocations).toHaveLength(2);
    expect(await s.deleteAllocation((a as { id: string }).id)).toEqual({ ok: true });
    expect(await s.deleteAllocation("nope")).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await s.loggedTime("1", "2026-10-01", "2026-10-31")).toEqual([]);
  });
});
