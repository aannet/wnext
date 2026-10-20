// Retrait d'une personne d'un projet (BR-10), couche données : récapitulatif (GET removal-summary), retrait confirmé
// (POST removal avec ce que l'utilisateur a vu), refus traduits en codes stables avec le NOUVEAU récapitulatif (état changé,
// temps verrouillés). Succès : les allocations de la personne sur le projet quittent le magasin (pierres tombales : l'écho
// temps réel n'est pas un changement étranger). Démo locale : même règle (moteur planTeamRemoval), sans temps saisi.
import type { ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createDemoSource } from "../src/data/demo-source";
import { createScheduleSource } from "../src/data/schedule-source";
import { summaryFromParams } from "../src/data/team-removal";

// @BR-10
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}): Alloc => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed", billable: true, priority: 0,
  repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 4, percent: null, ...over,
}) as Alloc;
const ALLOCS = [
  alloc("a1"),
  alloc("a2", { startDate: "2026-10-26", endDate: "2026-10-26", repeatState: "weekly", repeatEndDate: "2026-11-30" }),
  alloc("a3", { projectId: "2" }), // autre projet : gardée
  alloc("a4", { personId: "2" }), // autre personne : gardée
];
const page = (from: string, to: string): ScheduleResponse => ({
  window: { from, to }, changeCursor: "5", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: id === "1" ? "Alice" : "Bruno", peopleType: "employee" as const, departmentId: null, roleId: null,
    country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations: ALLOCS, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
  projects: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, projectCode: null, color: "#3B82F6", status: "in_progress" as const, nonBillable: false, startDate: null, endDate: null })),
});
const SUMMARY = { inTeam: true, allocationCount: 2, firstAllocation: "2026-10-20", lastAllocation: "2026-11-30", logCount: 3, logHours: 7.5, lockedLogCount: 0, canRemove: true };

interface Call { method: string; path: string; body: any; reply(status: number, body?: unknown): void; fail(): void }
async function harness() {
  const calls: Call[] = [];
  const fetch = (url: string, init: { method: string; body?: string }) => new Promise<FetchResponse>((res, rej) => {
    const u = new URL(url, "http://x");
    const reply = (status: number, body?: unknown) => res({ status, json: async () => body });
    if (u.pathname === "/api/v1/schedule") return reply(200, page(u.searchParams.get("from")!, u.searchParams.get("to")!));
    calls.push({ method: init.method, path: u.pathname, body: init.body && JSON.parse(init.body), reply, fail: () => rej(new TypeError("réseau")) });
  });
  const s = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
  s.setViewport(viewAt("2026-10-19", "day", 960));
  s.start();
  await flush();
  const allocs = () => s.getState().data!.allocations.map((a) => a.id).sort();
  return { s, calls, allocs };
}

describe("summaryFromParams : récapitulatif porté par un refus", () => {
  it("dates absentes = null ; params incomplets = undefined", () => {
    const { firstAllocation: _f, lastAllocation: _l, ...rest } = SUMMARY;
    expect(summaryFromParams(rest)).toEqual({ ...rest, firstAllocation: null, lastAllocation: null });
    expect(summaryFromParams(SUMMARY)).toEqual(SUMMARY);
    expect(summaryFromParams({ allocationCount: 1 })).toBeUndefined();
    expect(summaryFromParams(undefined)).toBeUndefined();
  });
});

describe("source API", () => {
  it("récapitulatif : GET removal-summary du projet et de la personne", async () => {
    const h = await harness();
    const p = h.s.teamRemovalSummary("1", "1");
    expect(h.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/projects/1/team/1/removal-summary" });
    h.calls[0]!.reply(200, SUMMARY);
    expect(await p).toEqual({ ok: true, summary: SUMMARY });
  });

  it("retrait confirmé : POST avec la confirmation vue ; les allocations de la personne sur le projet quittent l'écran, pas les autres", async () => {
    const h = await harness();
    let foreign = 0;
    h.s.onForeignChange(() => { foreign++; });
    const p = h.s.removeFromTeam("1", "1", { allocationCount: 2, logCount: 3, logHours: 7.5 });
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/projects/1/team/1/removal", body: { confirmation: { allocationCount: 2, logCount: 3, logHours: 7.5 } } });
    expect(h.allocs()).toEqual(["a1", "a2", "a3", "a4"]); // rien avant la réponse : la suppression est confirmée, pas optimiste
    h.calls[0]!.reply(200, { removedAllocations: 2, removedLogs: 3, removedLogHours: 7.5, wasInTeam: true });
    expect(await p).toEqual({ ok: true, removedAllocations: 2, removedLogs: 3, removedLogHours: 7.5 });
    expect(h.allocs()).toEqual(["a3", "a4"]);
    expect(foreign).toBe(0);
  });

  it("état changé entre-temps : TEAM_REMOVAL_STALE_CONFIRMATION avec le nouveau récapitulatif ; rien ne quitte l'écran", async () => {
    const h = await harness();
    const p = h.s.removeFromTeam("1", "1", { allocationCount: 1, logCount: 0, logHours: 0 });
    h.calls[0]!.reply(409, { code: "TEAM_REMOVAL_STALE_CONFIRMATION", params: SUMMARY, requestId: "r" });
    expect(await p).toEqual({ ok: false, error: "TEAM_REMOVAL_STALE_CONFIRMATION", summary: SUMMARY });
    expect(h.allocs()).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("temps verrouillés, droits, réseau : codes stables", async () => {
    const h = await harness();
    const locked = h.s.removeFromTeam("1", "1", { allocationCount: 2, logCount: 3, logHours: 7.5 });
    h.calls[0]!.reply(409, { code: "TEAM_REMOVAL_LOCKED_LOGS", params: { ...SUMMARY, lockedLogCount: 1, canRemove: false }, requestId: "r" });
    expect(await locked).toEqual({ ok: false, error: "TEAM_REMOVAL_LOCKED_LOGS", summary: { ...SUMMARY, lockedLogCount: 1, canRemove: false } });
    const denied = h.s.teamRemovalSummary("2", "1");
    h.calls[1]!.reply(403, { code: "FORBIDDEN", params: { role: "project_manager", scope: "project" }, requestId: "r" });
    expect(await denied).toEqual({ ok: false, error: "FORBIDDEN" });
    const lost = h.s.removeFromTeam("1", "1", { allocationCount: 2, logCount: 3, logHours: 7.5 });
    h.calls[2]!.fail();
    expect(await lost).toEqual({ ok: false, error: "NETWORK" });
    expect(h.allocs()).toEqual(["a1", "a2", "a3", "a4"]);
  });
});

describe("démo locale", () => {
  const demo = () => createDemoSource(page("2026-09-01", "2026-12-31"));
  const ids = (s: ReturnType<typeof demo>) => s.getState().data!.allocations.map((a) => a.id).sort();

  it("récapitulatif calculé sur les allocations locales (fin de série incluse), sans temps saisi", async () => {
    expect(await demo().teamRemovalSummary("1", "1")).toEqual({
      ok: true, summary: { inTeam: false, allocationCount: 2, firstAllocation: "2026-10-20", lastAllocation: "2026-11-30", logCount: 0, logHours: 0, lockedLogCount: 0, canRemove: true },
    });
  });

  it("retrait confirmé : supprime exactement les allocations de la personne sur le projet", async () => {
    const s = demo();
    expect(await s.removeFromTeam("1", "1", { allocationCount: 2, logCount: 0, logHours: 0 })).toEqual({ ok: true, removedAllocations: 2, removedLogs: 0, removedLogHours: 0 });
    expect(ids(s)).toEqual(["a3", "a4"]);
  });

  it("confirmation périmée (une allocation de plus entre-temps) : refus avec le nouveau récapitulatif, rien de supprimé", async () => {
    const s = demo();
    const r = await s.removeFromTeam("1", "1", { allocationCount: 1, logCount: 0, logHours: 0 });
    expect(r).toMatchObject({ ok: false, error: "TEAM_REMOVAL_STALE_CONFIRMATION", summary: { allocationCount: 2 } });
    expect(ids(s)).toEqual(["a1", "a2", "a3", "a4"]);
  });
});
