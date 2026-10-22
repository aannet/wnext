// Commandes d'un bloc (RT-047, US-3.2) : supprimer (portée série / groupe), dupliquer, scinder. Modèle pur, écritures sur la
// démo avec l'historique d'annulation (Ctrl+Z), puis source branchée sur l'API : DELETE /allocations/{id}/group et
// suppression d'une occurrence par la découpe (POST /allocations/{id}/split, delete: true).
import type { ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createDemoSource } from "../src/data/demo-source";
import { createScheduleSource } from "../src/data/schedule-source";
import {
  defaultSplitDate, deleteAllocationScoped, deleteOptions, duplicateAllocation, duplicateBody, splitAllocationAt, splitBlocker,
} from "../src/schedule/block-commands";
import { historyForSource } from "../src/schedule/history";

type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: "ph1", taskId: "t1", groupId: null, name: null, notes: "note",
  startDate: "2026-10-19", endDate: "2026-10-23", status: "tentative" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 6, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null,
    country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
  projects: [{ id: "1", version: 1, name: "Projet 1", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});
const series = (over: Partial<Alloc> = {}) => alloc("s", { startDate: "2026-10-19", endDate: "2026-10-19", repeatState: "weekly", repeatEndDate: "2026-11-09", ...over });

function demo(allocations: Alloc[]) {
  const src = createDemoSource(data(allocations));
  const { history } = historyForSource(src);
  const rows = () => src.getState().data!.allocations;
  return { src, history, rows, deps: { records: src, history } };
}
const shape = (a: Alloc) => [a.personId, a.startDate, a.endDate, a.projectId, a.taskId, a.notes, a.status, a.hoursPerDay];

describe("modèle des commandes", () => {
  it("portée de la suppression : rien à choisir hors série et hors groupe ; série : occurrence ou série ; groupe : ligne ou groupe", () => {
    expect(deleteOptions(alloc("a"), null, true)).toEqual([]);
    expect(deleteOptions(series(), 1, true)).toEqual([{ scope: "occurrence", blocked: null }, { scope: "series", blocked: null }]);
    expect(deleteOptions(alloc("a", { groupId: "G" }), null, true)).toEqual([{ scope: "line", blocked: null }, { scope: "group", blocked: null }]);
    expect(deleteOptions(series({ groupId: "G" }), 0, true).map((o) => o.scope)).toEqual(["occurrence", "series", "group"]);
    // Éditeur sans écriture de groupe : la ligne seule, sans étape.
    expect(deleteOptions(alloc("a", { groupId: "G" }), null, false)).toEqual([]);
    // Occurrences qui se chevauchent : la découpe est impossible, l'option le dit.
    expect(deleteOptions(series({ endDate: "2026-10-28" }), 1, true)[0]).toEqual({ scope: "occurrence", blocked: "overlapping" });
  });

  it("copie : juste après le bloc, même durée (jours calendaires, comme le déplacement), mêmes champs, sans répétition", () => {
    expect(duplicateBody(alloc("a"))).toMatchObject({
      personId: "1", projectId: "1", phaseId: "ph1", taskId: "t1", notes: "note", status: "tentative", startDate: "2026-10-24", endDate: "2026-10-28",
      repeatState: "none", repeatEndDate: null, load: { mode: "hours", hoursPerDay: 6 },
    });
    // Occurrence d'une série : ses dates à elle.
    expect(duplicateBody(series(), { startDate: "2026-10-26", endDate: "2026-10-26" })).toMatchObject({ startDate: "2026-10-27", endDate: "2026-10-27", repeatState: "none" });
  });

  it("scinder : au moins deux jours, hors série ; date proposée au milieu", () => {
    expect(splitBlocker(alloc("a"))).toBeNull();
    expect(splitBlocker(alloc("a", { endDate: "2026-10-19" }))).toBe("one_day");
    expect(splitBlocker(series({ endDate: "2026-10-20" }))).toBe("series");
    expect(defaultSplitDate(alloc("a"))).toBe("2026-10-21");
    expect(defaultSplitDate(alloc("a", { endDate: "2026-10-20" }))).toBe("2026-10-20");
  });
});

describe("écritures et annulation (démo)", () => {
  it("supprimer une allocation : retirée, Ctrl+Z la recrée avec ses champs, Ctrl+Maj+Z la resupprime", async () => {
    const { rows, history, deps } = demo([alloc("a"), alloc("b", { personId: "2" })]);
    expect(await deleteAllocationScoped(deps, alloc("a"), null, "line")).toEqual({ ok: true, count: 1, undoable: true });
    expect(rows().map((a) => a.id)).toEqual(["b"]);
    expect(history.getState().undoLabel).toBe("allocation.delete");
    expect((await history.undo())?.ok).toBe(true);
    const back = rows().find((a) => a.personId === "1")!;
    expect(shape(back)).toEqual(shape(alloc("a")));
    expect((await history.redo())?.ok).toBe(true);
    expect(rows().map((a) => a.id)).toEqual(["b"]);
  });

  it("série : « toute la série » supprimée et recréée par Ctrl+Z ; « cette occurrence » découpée, non annulable", async () => {
    const { rows, history, deps } = demo([series()]);
    expect(await deleteAllocationScoped(deps, series(), 1, "series")).toMatchObject({ ok: true, undoable: true });
    expect(rows()).toEqual([]);
    await history.undo();
    const s = rows()[0]!;
    expect([s.repeatState, s.repeatEndDate, s.startDate]).toEqual(["weekly", "2026-11-09", "2026-10-19"]);
    expect(await deleteAllocationScoped(deps, s, 1, "occurrence")).toEqual({ ok: true, count: 1, undoable: false });
    expect(rows().map((a) => [a.startDate, a.repeatEndDate])).toEqual([["2026-10-19", "2026-10-25"], ["2026-11-02", "2026-11-09"]]);
    expect(history.getState().canUndo).toBe(false);
  });

  it("groupe : « tout le groupe » retire chaque ligne (une action), Ctrl+Z les recrée ; « cette ligne » ne retire qu'elle", async () => {
    const lines = [alloc("a", { groupId: "G" }), alloc("b", { personId: "2", groupId: "G", hoursPerDay: 3 }), alloc("c", { personId: "2" })];
    const { rows, history, deps } = demo(lines);
    expect(await deleteAllocationScoped(deps, lines[0]!, null, "group")).toEqual({ ok: true, count: 2, undoable: true });
    expect(rows().map((a) => a.id)).toEqual(["c"]);
    await history.undo();
    expect(rows().map((a) => [a.personId, a.hoursPerDay]).sort()).toEqual([["1", 6], ["2", 3], ["2", 6]]);
    const again = rows().find((a) => a.hoursPerDay === 3)!;
    expect(await deleteAllocationScoped(deps, again, null, "line")).toMatchObject({ ok: true, count: 1 });
    expect(rows()).toHaveLength(2);
  });

  it("dupliquer : la copie suit le bloc, une action annulable (Ctrl+Z la retire)", async () => {
    const { rows, history, deps } = demo([alloc("a")]);
    const out = await duplicateAllocation(deps, alloc("a"));
    expect(out.ok).toBe(true);
    const copy = rows().find((a) => a.id !== "a")!;
    expect(out.ok && out.id).toBe(copy.id);
    expect(shape(copy)).toEqual(["1", "2026-10-24", "2026-10-28", "1", "t1", "note", "tentative", 6]);
    expect(history.getState().undoLabel).toBe("allocation.duplicate");
    await history.undo();
    expect(rows().map((a) => a.id)).toEqual(["a"]);
  });

  it("scinder : deux allocations qui gardent projet, tâche, note, statut et charge ; une seule action annulable", async () => {
    const { rows, history, deps } = demo([alloc("a")]);
    expect(await splitAllocationAt(deps, alloc("a"), "2026-10-21")).toEqual({ ok: true });
    expect(rows().map(shape)).toEqual([
      ["1", "2026-10-19", "2026-10-20", "1", "t1", "note", "tentative", 6],
      ["1", "2026-10-21", "2026-10-23", "1", "t1", "note", "tentative", 6],
    ]);
    expect(history.getState().undoLabel).toBe("allocation.split");
    await history.undo();
    expect(rows().map(shape)).toEqual([shape(alloc("a"))]);
    expect(history.getState().canUndo).toBe(false);
    await history.redo();
    expect(rows()).toHaveLength(2);
  });

  it("scinder hors des bornes ou une série : refusé sans écriture", async () => {
    const { rows, deps } = demo([alloc("a"), series()]);
    expect(await splitAllocationAt(deps, alloc("a"), "2026-10-19")).toEqual({ ok: false, error: "VALIDATION_FAILED", partial: false });
    expect(await splitAllocationAt(deps, series(), "2026-10-20")).toEqual({ ok: false, error: "VALIDATION_FAILED", partial: false });
    expect(rows()).toHaveLength(2);
  });

  it("scinder : création refusée après la mise à jour, ce qui est écrit reste annulable", async () => {
    const { src, rows, history, deps } = demo([alloc("a")]);
    src.createAllocation = async () => ({ ok: false, error: "FORBIDDEN" });
    expect(await splitAllocationAt(deps, alloc("a"), "2026-10-21")).toEqual({ ok: false, error: "FORBIDDEN", partial: true });
    expect(rows()[0]!.endDate).toBe("2026-10-20");
    await history.undo();
    expect(rows()[0]!.endDate).toBe("2026-10-23");
  });
});

describe("source branchée sur l'API", () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const overlaps = (a: Alloc, from: string, to: string) => a.startDate <= to && (a.repeatEndDate ?? a.endDate) >= from;
  /** `representation: false` : serveur qui ignore Prefer (204 sans corps). Ligne m : du groupe G, autre projet, à 16 mois (hors de toute lecture préalable). */
  function setup(o: { status?: number; preRead?: boolean; representation?: boolean } = {}) {
    const calls: { path: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const server = new Map([
      alloc("a", { groupId: "G", startDate: "2026-10-20", endDate: "2026-10-21" }), alloc("b", { personId: "2", groupId: "G", startDate: "2026-10-20", endDate: "2026-10-21" }),
      alloc("c", { personId: "2", groupId: "G", startDate: "2027-03-01", endDate: "2027-03-02" }), alloc("d", { startDate: "2026-10-22", endDate: "2026-10-22" }),
      alloc("m", { groupId: "G", projectId: "2", startDate: "2028-02-01", endDate: "2028-02-02" }),
      series({ startDate: "2026-10-20", endDate: "2026-10-20", repeatEndDate: "2026-11-10" }),
    ].map((a) => [a.id, a] as const));
    let seq = 0;
    const fetch = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<FetchResponse> => {
      const u = new URL(url, "http://x");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: u.pathname, method, headers: init?.headers ?? {}, body });
      const json = (st: number, b: unknown): FetchResponse => ({ status: st, json: async () => b });
      const [from, to] = [u.searchParams.get("from")!, u.searchParams.get("to")!];
      if (u.pathname === "/api/v1/schedule") return json(200, { ...data([...server.values()].filter((a) => overlaps(a, from, to))), window: { from, to } });
      if (u.pathname === "/api/v1/projects/1/allocations") {
        const items = [...server.values()].filter((a) => overlaps(a, from, to));
        return json(200, { items, page: { nextCursor: null, total: items.length } });
      }
      if (u.pathname === "/api/v1/allocations/a/group" && method === "DELETE") {
        await gate;
        if ((o.status ?? 204) !== 204) return json(409, { code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
        const items = [...server.values()].filter((a) => a.groupId === "G");
        for (const a of items) server.delete(a.id);
        return o.representation !== false && init?.headers?.Prefer === "return=representation" ? json(200, { groupId: "G", items }) : { status: 204, json: async () => undefined };
      }
      if (u.pathname === "/api/v1/allocations/s/split") {
        const s = server.get("s")!;
        const after = { ...s, id: "z", startDate: "2026-11-10", endDate: "2026-11-10" };
        server.set("s", { ...s, repeatEndDate: "2026-11-02", version: 2 });
        server.set("z", after);
        return json(200, { before: server.get("s"), after });
      }
      if (u.pathname === "/api/v1/allocations" && method === "POST") {
        const { load, ...rest } = body;
        const a = { ...alloc(`n${++seq}`), ...rest, groupId: null, mode: load.mode, hoursPerDay: load.hoursPerDay ?? null, percent: load.percent ?? null };
        server.set(a.id, a);
        return json(201, a);
      }
      const id = u.pathname.split("/").at(-1)!;
      if (u.pathname === "/api/v1/allocations/d" && method === "DELETE") {
        // Modifiée ailleurs entre-temps : 409, la version à jour est sur le serveur.
        server.set("d", { ...server.get("d")!, version: 2, notes: "relu" });
        return json(409, { code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
      }
      const cur = server.get(id);
      if (u.pathname === `/api/v1/allocations/${id}` && method === "PATCH" && cur) {
        const next = { ...cur, ...body, version: cur.version + 1 };
        server.set(id, next);
        return json(200, next);
      }
      if (u.pathname === `/api/v1/allocations/${id}` && method === "DELETE") {
        if (!cur) return json(404, { code: "NOT_FOUND", params: { entity: "allocation" } });
        if (init?.headers?.["If-Match"] !== `"${cur.version}"`) return json(409, { code: "VERSION_CONFLICT", params: { currentVersion: cur.version } });
        server.delete(id);
        return { status: 204, json: async () => undefined };
      }
      if (u.pathname === `/api/v1/allocations/${id}` && method === "GET") return server.has(id) ? json(200, server.get(id)) : json(404, { code: "NOT_FOUND" });
      return json(404, { code: "NOT_FOUND" });
    };
    const client = createClient({ baseUrl: "", fetch });
    const src = createScheduleSource({ api: o.preRead === false ? { ...client, listProjectAllocations: undefined } : client });
    src.setViewport(viewAt("2026-10-20", "day", 960));
    src.start();
    return { src, calls, release, server };
  }
  const ids = (src: ReturnType<typeof createScheduleSource>) => src.getState().data!.allocations.map((a) => a.id).sort();

  it("« tout le groupe » : lignes retirées tout de suite, DELETE /allocations/{id}/group avec If-Match et Prefer ; la réponse liste toutes les lignes (preuve d'exhaustivité)", async () => {
    const { src, calls, release } = setup();
    await flush();
    const p = src.deleteAllocationGroup!("a");
    expect(ids(src)).toEqual(["d", "s"]);
    release();
    const out = await p;
    expect(out.ok && out.before.map((a) => a.id).sort()).toEqual(["a", "b", "c", "m"]);
    expect(out.ok && out.complete).toBe(true);
    const call = calls.find((c) => c.path === "/api/v1/allocations/a/group")!;
    expect([call.method, call.headers["If-Match"], call.headers.Prefer]).toEqual(["DELETE", "\"1\"", "return=representation"]);
    expect(ids(src)).toEqual(["d", "s"]);
  });

  it("« tout le groupe » puis Ctrl+Z : chaque ligne recréée, y compris celle d'un autre projet hors de toute lecture préalable", async () => {
    const { src, calls, release } = setup();
    await flush();
    const { history } = historyForSource(src);
    const a = src.getState().data!.allocations.find((x) => x.id === "a")!;
    const p = deleteAllocationScoped({ records: src, history }, a, null, "group");
    release();
    expect(await p).toEqual({ ok: true, count: 4, undoable: true });
    expect((await history.undo())?.ok).toBe(true);
    expect(calls.filter((c) => c.path === "/api/v1/allocations" && c.method === "POST").map((c) => (c.body as { startDate: string }).startDate).sort())
      .toEqual(["2026-10-20", "2026-10-20", "2027-03-01", "2028-02-01"]);
  });

  it("une lecture préalable terminée n'est pas une preuve : serveur sans représentation (204), suppression faite mais non annulable", async () => {
    const other = setup({ representation: false });
    await flush();
    const h2 = historyForSource(other.src).history;
    const a2 = other.src.getState().data!.allocations.find((x) => x.id === "a")!;
    const p2 = deleteAllocationScoped({ records: other.src, history: h2 }, a2, null, "group");
    other.release();
    expect(await p2).toEqual({ ok: true, count: 2, undoable: false });
    expect(h2.getState().canUndo).toBe(false);
  });

  it("« tout le groupe » refusé (409) : les lignes reviennent, code stable rendu", async () => {
    const { src, release } = setup({ status: 409 });
    await flush();
    const p = src.deleteAllocationGroup!("a");
    release();
    expect(await p).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    await flush();
    expect(ids(src)).toEqual(["a", "b", "d", "s"]);
  });

  it("allocation seule refusée (409) par la commande de l'écran : remise en place puis relue (version à jour), rien d'enregistré", async () => {
    const { src } = setup();
    await flush();
    const { history } = historyForSource(src);
    const d = src.getState().data!.allocations.find((x) => x.id === "d")!;
    expect(await deleteAllocationScoped({ records: src, history }, d, null, "line")).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    await flush();
    expect(src.getState().data!.allocations.find((x) => x.id === "d")).toMatchObject({ version: 2, notes: "relu" });
    expect(history.getState().canUndo).toBe(false);
  });

  it("snapshot de l'étape périmé (changement arrivé pendant l'étape) : DELETE avec sa version, 409, relue, rien d'annulable ni de perdu", async () => {
    const { src, calls } = setup();
    await flush();
    const { history } = historyForSource(src);
    const seen = src.getState().data!.allocations.find((x) => x.id === "a")!;
    // Changement d'ailleurs pendant l'étape : le magasin passe en version 2.
    expect(await src.updateAllocation("a", { notes: "autre" })).toEqual({ ok: true });
    expect(await deleteAllocationScoped({ records: src, history }, seen, null, "line")).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    const del = calls.find((c) => c.path === "/api/v1/allocations/a" && c.method === "DELETE")!;
    expect(del.headers["If-Match"]).toBe("\"1\"");
    await flush();
    expect(src.getState().data!.allocations.find((x) => x.id === "a")).toMatchObject({ version: 2, notes: "autre" });
    expect(history.getState().canUndo).toBe(false);
  });

  it("DELETE 404 puis relecture 404 : le bloc est retiré, aucune action annulable", async () => {
    const { src, server } = setup();
    await flush();
    const { history } = historyForSource(src);
    const d2 = src.getState().data!.allocations.find((x) => x.id === "s")!;
    server.delete("s"); // supprimée ailleurs, le temps réel ne l'a pas encore dit
    expect(await deleteAllocationScoped({ records: src, history }, d2, null, "series")).toEqual({ ok: false, error: "NOT_FOUND" });
    await flush();
    expect(ids(src)).not.toContain("s");
    expect(history.getState().canUndo).toBe(false);
  });

  it("« cette occurrence » : POST /allocations/{id}/split avec delete: true, la série découpée sans l'occurrence", async () => {
    const { src, calls } = setup();
    await flush();
    expect(await src.deleteOccurrence!("s", 2)).toEqual({ ok: true });
    const call = calls.find((c) => c.path === "/api/v1/allocations/s/split")!;
    expect([call.headers["If-Match"], call.body]).toEqual(["\"1\"", { occurrenceDate: "2026-11-03", delete: true }]);
    const rows = src.getState().data!.allocations.filter((a) => a.projectId === "1" && a.repeatState === "weekly");
    expect(rows.map((a) => [a.id, a.startDate, a.repeatEndDate]).sort()).toEqual([["s", "2026-10-20", "2026-11-02"], ["z", "2026-11-10", "2026-11-10"]]);
  });
});
