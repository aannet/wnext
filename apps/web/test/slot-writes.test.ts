// Écritures de la pop-in du créneau (RT-014, RT-016, RT-018) : patch élargi (projet, tâche, statut, note, mode), annulation
// de ces changements, création de groupe (BR-26) en démo et sur l'API (optimiste, tout ou rien), projet d'arrivée ajouté au
// magasin, projet modifié ailleurs appliqué aux blocs.
import type { ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { patched, toApiPatch, toSplitBody } from "../src/data/allocation-edits";
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

describe("portée d'une série et d'un groupe (RT-042) : écritures", () => {
  it("découpe d'une occurrence avec les champs de la pop-in (projet, tâche, statut, note, mode) : corps du contrat", () => {
    expect(toSplitBody("2026-10-27", { projectId: "2", taskId: null, status: "tentative", notes: "x", mode: "percentage", percent: 50, hoursPerDay: null }))
      .toEqual({ occurrenceDate: "2026-10-27", patch: { projectId: "2", taskId: null, status: "tentative", notes: "x", load: { mode: "percentage", percent: 50 } } });
  });

  it("démo : « cette occurrence » porte le projet et la note, la série garde les siens", async () => {
    const src = createDemoSource(data([alloc("s", { startDate: "2026-10-20", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-10" })]));
    expect(await src.splitOccurrence("s", 1, { projectId: "2", notes: "seule" })).toEqual({ ok: true });
    const rows = src.getState().data!.allocations;
    expect(rows.map((a) => [a.startDate, a.projectId, a.notes, a.repeatState])).toEqual([
      ["2026-10-20", "1", null, "weekly"], ["2026-10-27", "2", "seule", "none"], ["2026-11-03", "1", null, "weekly"],
    ]);
  });

  it("démo : « tout le groupe » modifie chaque ligne du groupe (version + 1), pas les autres ; hors groupe : NOT_FOUND", async () => {
    const src = createDemoSource(data([alloc("a", { groupId: "G" }), alloc("b", { personId: "2", groupId: "G", hoursPerDay: 4 }), alloc("c")]));
    expect(await src.updateAllocationGroup!("a", { projectId: "2", taskId: null })).toEqual({ ok: true });
    const rows = src.getState().data!.allocations;
    expect(rows.map((a) => [a.id, a.projectId, a.hoursPerDay, a.version])).toEqual([["a", "2", 8, 2], ["b", "2", 4, 2], ["c", "1", 8, 1]]);
    expect(await src.updateAllocationGroup!("c", { projectId: "2" })).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("source branchée sur l'API : « tout le groupe » (RT-042)", () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  function setup(status: number) {
    const calls: { path: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const rows = [alloc("a", { groupId: "G" }), alloc("b", { personId: "2", groupId: "G" }), alloc("c")];
    const fetch = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<FetchResponse> => {
      const u = new URL(url, "http://x");
      const method = init?.method ?? "GET";
      calls.push({ path: u.pathname, method, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
      const json = (s: number, body: unknown): FetchResponse => ({ status: s, json: async () => body });
      if (u.pathname === "/api/v1/schedule") return json(200, { ...data(rows), window: { from: u.searchParams.get("from"), to: u.searchParams.get("to") } });
      if (u.pathname === "/api/v1/allocations/a/group" && method === "PATCH") {
        await gate;
        return status === 200
          ? json(200, { groupId: "G", items: rows.slice(0, 2).map((a) => ({ ...a, projectId: "2", phaseId: null, taskId: null, version: 2 })) })
          : json(409, { code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
      }
      if (u.pathname.startsWith("/api/v1/allocations/") && method === "GET") {
        const id = u.pathname.split("/").at(-1)!;
        return json(200, { ...rows.find((a) => a.id === id)!, version: 2, notes: "relu" });
      }
      return json(404, { code: "NOT_FOUND" });
    };
    const src = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
    src.setViewport(viewAt("2026-10-20", "day", 960));
    src.start();
    return { src, calls, release };
  }
  const now = (src: ReturnType<typeof createScheduleSource>) => src.getState().data!.allocations.map((a) => [a.id, a.projectId, a.version, a.notes]);

  it("lignes du groupe optimistes tout de suite, PATCH /allocations/{id}/group avec If-Match de la ligne désignée, réponse appliquée", async () => {
    const { src, calls, release } = setup(200);
    await flush();
    const p = src.updateAllocationGroup!("a", { projectId: "2" });
    expect(now(src)).toEqual([["a", "2", 1, null], ["b", "2", 1, null], ["c", "1", 1, null]]);
    expect(await src.updateAllocationGroup!("b", { projectId: "1" })).toEqual({ ok: false, error: "BUSY" });
    release();
    expect(await p).toEqual({ ok: true });
    const call = calls.find((c) => c.path === "/api/v1/allocations/a/group")!;
    expect([call.method, call.headers["If-Match"], call.body]).toEqual(["PATCH", "\"1\"", { projectId: "2" }]);
    expect(now(src)).toEqual([["a", "2", 2, null], ["b", "2", 2, null], ["c", "1", 1, null]]);
  });

  it("409 : retour arrière de toutes les lignes, puis relecture du groupe ; code stable rendu", async () => {
    const { src, release } = setup(409);
    await flush();
    const p = src.updateAllocationGroup!("a", { projectId: "2" });
    release();
    expect(await p).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    await flush();
    expect(now(src)).toEqual([["a", "1", 2, "relu"], ["b", "1", 2, "relu"], ["c", "1", 1, null]]);
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
        return json(200, { items: [project("1"), project("2", { color: "#16A34A" })].map((p) => ({ ...p, projectManagerId: null, managerUserIds: [], clientId: null, tags: [], notes: null })), page: { nextCursor: null, total: 2 } });
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
