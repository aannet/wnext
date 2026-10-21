// Écritures de la pop-in du créneau (RT-014, RT-016, RT-018) : patch élargi (projet, tâche, statut, note, mode), annulation
// de ces changements, création de groupe (BR-26) en démo et sur l'API (optimiste, tout ou rien), projet d'arrivée ajouté au
// magasin, projet modifié ailleurs appliqué aux blocs.
import type { ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { patched, toApiPatch } from "../src/data/allocation-edits";
import { createDemoSource } from "../src/data/demo-source";
import { createScheduleSource } from "../src/data/schedule-source";
import { historyForSource, labelOf } from "../src/schedule/history";

type Alloc = ScheduleResponse["allocations"][number];
type Project = ScheduleResponse["projects"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: "ph1", taskId: "t1", groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, version: 1, name: `Projet ${id}`, projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null, ...over,
});
const data = (allocations: Alloc[], projects = [project("1"), project("2", { color: "#16A34A" })]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null,
    country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [], projects,
});

describe("patch élargi de la pop-in", () => {
  it("changer de projet remet phase et tâche à zéro (comme l'API), sauf tâche précisée", () => {
    expect(patched(alloc("a"), { projectId: "2" })).toMatchObject({ projectId: "2", phaseId: null, taskId: null });
    expect(patched(alloc("a"), { projectId: "2", taskId: "t9" })).toMatchObject({ projectId: "2", phaseId: null, taskId: "t9" });
    expect(patched(alloc("a"), { status: "tentative", notes: "x" })).toMatchObject({ status: "tentative", notes: "x", projectId: "1", taskId: "t1" });
  });

  it("changer de mode : la quantité du nouveau mode, l'autre à null ; le corps porte `load`, jamais `mode`", () => {
    expect(patched(alloc("a"), { mode: "percentage", percent: 50 })).toMatchObject({ mode: "percentage", percent: 50, hoursPerDay: null });
    expect(toApiPatch({ mode: "percentage", percent: 50, hoursPerDay: null, projectId: "2", taskId: null }))
      .toEqual({ load: { mode: "percentage", percent: 50 }, projectId: "2", taskId: null });
  });

  it("libellé d'historique : édition pour projet, tâche, statut, note ou mode ; inchangé pour un geste", () => {
    expect(labelOf({ projectId: "2" }, alloc("a"))).toBe("allocation.edit");
    expect(labelOf({ status: "tentative" }, alloc("a"))).toBe("allocation.edit");
    expect(labelOf({ hoursPerDay: 4 }, alloc("a"))).toBe("allocation.load");
    expect(labelOf({ startDate: "2026-10-21", endDate: "2026-10-22" }, alloc("a"))).toBe("allocation.move");
  });

  it("annuler un changement de projet et de mode rend projet, phase, tâche, mode et heures d'origine ; rétablir les reprend", async () => {
    const src = createDemoSource(data([alloc("a")]));
    const { history } = historyForSource(src);
    expect(await history.editor.updateAllocation("a", { projectId: "2", mode: "percentage", percent: 50, hoursPerDay: null })).toEqual({ ok: true });
    const now = () => src.getState().data!.allocations[0]!;
    expect(now()).toMatchObject({ projectId: "2", taskId: null, phaseId: null, mode: "percentage", percent: 50 });
    expect(history.getState().undoLabel).toBe("allocation.edit");
    await history.undo();
    expect(now()).toMatchObject({ projectId: "1", taskId: "t1", phaseId: "ph1", mode: "hours", hoursPerDay: 8, percent: null });
    await history.redo();
    expect(now()).toMatchObject({ projectId: "2", taskId: null, mode: "percentage", percent: 50 });
  });
});

describe("groupe (BR-26) et projet d'arrivée en démo", () => {
  it("une ligne par personne, même groupId, charge du membre ou commune", async () => {
    const src = createDemoSource(data([]));
    const out = await src.createAllocationGroup({
      projectId: "2", startDate: "2026-10-20", endDate: "2026-10-22", load: { mode: "hours", hoursPerDay: 8 },
      members: [{ personId: "1" }, { personId: "2", load: { mode: "hours", hoursPerDay: 4 } }],
    });
    expect(out.ok).toBe(true);
    const rows = src.getState().data!.allocations;
    expect(rows.map((a) => [a.personId, a.hoursPerDay, a.projectId])).toEqual([["1", 8, "2"], ["2", 4, "2"]]);
    expect(new Set(rows.map((a) => a.groupId)).size).toBe(1);
    expect(rows[0]!.groupId).not.toBeNull();
    expect(out.ok && out.ids).toEqual(rows.map((a) => a.id));
  });

  it("passer un bloc sur un projet absent de la fenêtre l'ajoute aux projets affichés (nom, couleur)", async () => {
    const src = createDemoSource(data([alloc("a")], [project("1")]));
    src.projectChanged!(project("3", { color: "#9333EA" }));
    expect(src.getState().data!.projects.map((p) => p.id)).toEqual(["1"]);
    await src.updateAllocation("a", { projectId: "3" });
    expect(src.getState().data!.projects.find((p) => p.id === "3")?.color).toBe("#9333EA");
  });
});

describe("source branchée sur l'API", () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  function setup(groupStatus: number) {
    const calls: { path: string; method: string; body: unknown }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const fetch = async (url: string, init?: { method?: string; body?: string }): Promise<FetchResponse> => {
      const u = new URL(url, "http://x");
      const method = init?.method ?? "GET";
      calls.push({ path: u.pathname, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const json = (status: number, body: unknown): FetchResponse => ({ status, json: async () => body });
      if (u.pathname === "/api/v1/schedule") {
        return json(200, { ...data([alloc("a")], [project("1")]), window: { from: u.searchParams.get("from"), to: u.searchParams.get("to") } });
      }
      if (u.pathname === "/api/v1/projects") {
        return json(200, { items: [project("1"), project("2", { color: "#16A34A" })].map((p) => ({ ...p, projectManagerId: null, clientId: null, tags: [], notes: null })), page: { nextCursor: null, total: 2 } });
      }
      if (u.pathname === "/api/v1/allocation-groups") {
        await gate;
        const b = JSON.parse(init!.body!);
        return groupStatus === 201
          ? json(201, { groupId: "g1", items: b.members.map((m: { personId: string }, i: number) => ({ ...alloc(`s${i}`, { personId: m.personId, projectId: b.projectId, groupId: "g1", phaseId: null, taskId: null }) })) })
          : json(groupStatus, { code: "FORBIDDEN", params: { scope: "project" } });
      }
      if (u.pathname === "/api/v1/allocations/a" && method === "PATCH") {
        return json(200, { ...alloc("a", { projectId: "2", phaseId: null, taskId: null }), version: 2 });
      }
      return json(404, { code: "NOT_FOUND" });
    };
    const src = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
    src.setViewport(viewAt("2026-10-20", "day", 960));
    src.start();
    return { src, calls, release };
  }
  const body = { projectId: "2", startDate: "2026-10-20", endDate: "2026-10-20", load: { mode: "hours" as const, hoursPerDay: 8 }, members: [{ personId: "1" }, { personId: "2" }] };

  it("groupe : lignes optimistes tout de suite, remplacées par celles du serveur", async () => {
    const { src, calls, release } = setup(201);
    await flush();
    await src.listProjects();
    const p = src.createAllocationGroup(body);
    expect(src.getState().data!.allocations.filter((a) => a.projectId === "2")).toHaveLength(2);
    expect(src.getState().data!.projects.map((x) => x.id).sort()).toEqual(["1", "2"]);
    release();
    expect(await p).toEqual({ ok: true, ids: ["s0", "s1"] });
    expect(src.getState().data!.allocations.filter((a) => a.groupId === "g1").map((a) => a.id)).toEqual(["s0", "s1"]);
    expect(calls.find((c) => c.path === "/api/v1/allocation-groups")?.body).toEqual(body);
  });

  it("groupe refusé (BR-33) : tout est retiré, code stable rendu", async () => {
    const { src, release } = setup(403);
    await flush();
    const p = src.createAllocationGroup(body);
    release();
    expect(await p).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(src.getState().data!.allocations.map((a) => a.id)).toEqual(["a"]);
  });

  it("changement de projet : PATCH avec If-Match, projet d'arrivée ajouté pour la couleur ; projet plus récent appliqué, écho ignoré", async () => {
    const { src, calls } = setup(201);
    await flush();
    await src.listProjects();
    expect(await src.updateAllocation("a", { projectId: "2" })).toEqual({ ok: true });
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ projectId: "2" });
    expect(src.getState().data!.projects.find((p) => p.id === "2")?.color).toBe("#16A34A");
    const before = src.getState().data;
    src.projectChanged!(project("2", { color: "#16A34A" }));
    expect(src.getState().data).toBe(before);
    src.projectChanged!(project("2", { version: 2, color: "#DC2626" }));
    expect(src.getState().data!.projects.find((p) => p.id === "2")?.color).toBe("#DC2626");
  });
});
