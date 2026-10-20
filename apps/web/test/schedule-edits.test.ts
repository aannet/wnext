// Écritures optimistes des gestes (ADR-002 §5) : PATCH avec la version, retour arrière sur conflit ou réseau, écho temps
// réel sans clignotement, découpe d'une occurrence de série (BR-25). API et WebSocket simulés.
import type { Change, ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createScheduleSource } from "../src/data/schedule-source";
import type { SocketLike } from "../src/realtime/client";
import { historyForSource } from "../src/schedule/history";

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const VIEW = viewAt("2026-10-19", "day", 960);

const alloc = (id: string, over: Partial<ScheduleResponse["allocations"][number]> = {}) => ({
  id, version: 3, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 4, percent: null, ...over,
}) as ScheduleResponse["allocations"][number];

const pageOf = (q: URLSearchParams, allocations: ScheduleResponse["allocations"]): ScheduleResponse => ({
  window: { from: q.get("from")!, to: q.get("to")! }, changeCursor: "5", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: [{ id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null,
    workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true }],
  allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
  projects: [{ id: "1", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false, startDate: null, endDate: null }],
});

interface Write { method: string; path: string; headers: Record<string, string>; body: any; resolve(status: number, body: unknown): void; reject(): void }

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send() {}
  close() {}
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
const changes = (...cs: Change[]) => ({ v: 1, type: "changes", changes: cs, cursor: cs.at(-1)!.seq, hasMore: false });

/** GET /schedule et le ticket répondent tout de suite ; les écritures (et GET /allocations/{id}) attendent le test. */
async function harness(initial: ScheduleResponse["allocations"], realtime = false) {
  const reads: string[] = [];
  const writes: Write[] = [];
  let allocations = initial;
  const fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => new Promise<FetchResponse>((res, rej) => {
    const u = new URL(url, "http://x");
    const reply = (status: number, body: unknown) => res({ status, json: async () => body });
    if (u.pathname === "/api/v1/schedule") { reads.push(url); return reply(200, pageOf(u.searchParams, allocations)); }
    if (u.pathname === "/api/v1/realtime/ticket") return reply(201, { ticket: "t-AAAAAAAAAAAAAAAA", expiresInSeconds: 30 });
    writes.push({ method: init.method, path: u.pathname, headers: init.headers ?? {}, body: init.body && JSON.parse(init.body), resolve: reply, reject: () => rej(new TypeError("réseau")) });
  });
  const sockets: FakeSocket[] = [];
  const s = createScheduleSource({
    api: createClient({ baseUrl: "", fetch }),
    realtime: realtime ? { wsBase: "ws://t", openSocket: () => { const k = new FakeSocket(); sockets.push(k); return k; }, setTimer: () => 0, clearTimer: () => {}, random: () => 0 } : undefined,
  });
  s.setViewport(VIEW);
  s.start();
  await flush();
  if (realtime) { sockets[0]!.onopen?.({}); sockets[0]!.say({ v: 1, type: "ready", cursor: "5" }); await flush(); }
  let renders = 0;
  s.subscribe(() => { renders++; });
  const shown = () => s.getState().data!.allocations.map((a) => `${a.id}@${a.version}:${a.startDate}..${a.endDate}`).sort();
  return { s, reads, writes, sockets, shown, setServer: (a: typeof initial) => { allocations = a; }, renders: () => renders };
}

describe("écriture optimiste", () => {
  it("succès : affichée tout de suite, PATCH avec If-Match, puis version du serveur", async () => {
    const h = await harness([alloc("10")]);
    const p = h.s.updateAllocation("10", { startDate: "2026-10-22", endDate: "2026-10-23" });
    expect(h.shown()).toEqual(["10@3:2026-10-22..2026-10-23"]);
    const w = h.writes[0]!;
    expect([w.method, w.path, w.headers["If-Match"], w.body]).toEqual(["PATCH", "/api/v1/allocations/10", '"3"', { startDate: "2026-10-22", endDate: "2026-10-23" }]);
    w.resolve(200, alloc("10", { version: 4, startDate: "2026-10-22", endDate: "2026-10-23" }));
    expect(await p).toEqual({ ok: true });
    expect(h.shown()).toEqual(["10@4:2026-10-22..2026-10-23"]);
  });

  it("VERSION_CONFLICT : retour arrière, relecture de l'allocation, code rendu", async () => {
    const h = await harness([alloc("10")]);
    const p = h.s.updateAllocation("10", { hoursPerDay: 6 });
    expect(h.s.getState().data!.allocations[0]!.hoursPerDay).toBe(6);
    h.writes[0]!.resolve(409, { code: "VERSION_CONFLICT", params: { currentVersion: 5 }, requestId: "r" });
    await flush();
    expect(h.s.getState().data!.allocations[0]!.hoursPerDay).toBe(4);
    const get = h.writes[1]!;
    expect([get.method, get.path]).toEqual(["GET", "/api/v1/allocations/10"]);
    get.resolve(200, alloc("10", { version: 5, startDate: "2026-11-02", endDate: "2026-11-02" }));
    expect(await p).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    expect(h.shown()).toEqual(["10@5:2026-11-02..2026-11-02"]);
  });

  it("erreur réseau : retour arrière, code NETWORK", async () => {
    const h = await harness([alloc("10")]);
    const p = h.s.updateAllocation("10", { personId: "2" });
    h.writes[0]!.reject();
    expect(await p).toEqual({ ok: false, error: "NETWORK" });
    expect(h.s.getState().data!.allocations[0]!.personId).toBe("1");
  });

  it("une seconde écriture sur la même allocation pendant la première : BUSY, sans appel", async () => {
    const h = await harness([alloc("10")]);
    void h.s.updateAllocation("10", { hoursPerDay: 5 });
    expect(await h.s.updateAllocation("10", { hoursPerDay: 6 })).toEqual({ ok: false, error: "BUSY" });
    expect(h.writes).toHaveLength(1);
  });
});

describe("écho temps réel de sa propre écriture", () => {
  const moved = alloc("10", { version: 4, startDate: "2026-10-22", endDate: "2026-10-23" });

  it("écho après la réponse : version connue, aucun rechargement ni nouveau rendu", async () => {
    const h = await harness([alloc("10")], true);
    const p = h.s.updateAllocation("10", { startDate: "2026-10-22", endDate: "2026-10-23" });
    h.writes[0]!.resolve(200, moved);
    await p;
    const reads = h.reads.length;
    const data = h.s.getState().data;
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "10", op: "update", version: 4 }));
    await flush();
    expect(h.reads).toHaveLength(reads);
    expect(h.s.getState().data!.allocations).toEqual(data!.allocations);
    expect(h.shown()).toEqual(["10@4:2026-10-22..2026-10-23"]);
  });

  it("écho avant la réponse : pas de rechargement ni de retour à l'ancienne position", async () => {
    const h = await harness([alloc("10")], true);
    h.setServer([alloc("10")]); // un rechargement intempestif ramènerait l'ancienne position
    const p = h.s.updateAllocation("10", { startDate: "2026-10-22", endDate: "2026-10-23" });
    const reads = h.reads.length;
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "10", op: "update", version: 4 }));
    await flush();
    expect(h.shown()).toEqual(["10@3:2026-10-22..2026-10-23"]);
    h.writes[0]!.resolve(200, moved);
    await p;
    await flush();
    expect(h.reads).toHaveLength(reads);
    expect(h.shown()).toEqual(["10@4:2026-10-22..2026-10-23"]);
  });

  it("changement d'un autre plus récent que la réponse : rechargé une fois l'écriture terminée", async () => {
    const h = await harness([alloc("10")], true);
    const p = h.s.updateAllocation("10", { startDate: "2026-10-22", endDate: "2026-10-23" });
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "10", op: "update", version: 5 }));
    await flush();
    const reads = h.reads.length;
    h.setServer([alloc("10", { version: 5, startDate: "2026-10-26", endDate: "2026-10-26" })]);
    h.writes[0]!.resolve(200, moved);
    await p;
    await flush();
    expect(h.reads.length).toBeGreaterThan(reads);
    expect(h.shown()).toEqual(["10@5:2026-10-26..2026-10-26"]);
  });
});

describe("série : cette occurrence (découpe)", () => {
  const weekly = alloc("20", { startDate: "2026-10-19", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-15" });

  it("trois morceaux optimistes, POST /split avec occurrenceDate et le patch, puis les lignes du serveur", async () => {
    const h = await harness([weekly]);
    const p = h.s.splitOccurrence("20", 1, { startDate: "2026-10-27", endDate: "2026-10-28" });
    expect(h.shown()).toEqual(["20@3:2026-10-19..2026-10-20", "tmp-1-1@0:2026-10-27..2026-10-28", "tmp-1-2@0:2026-11-02..2026-11-03"]);
    const w = h.writes[0]!;
    expect([w.method, w.path, w.headers["If-Match"], w.body]).toEqual(["POST", "/api/v1/allocations/20/split", '"3"',
      { occurrenceDate: "2026-10-26", patch: { startDate: "2026-10-27", endDate: "2026-10-28" } }]);
    w.resolve(200, {
      before: { ...weekly, version: 4, repeatEndDate: "2026-10-25" },
      occurrence: alloc("21", { version: 1, startDate: "2026-10-27", endDate: "2026-10-28" }),
      after: { ...weekly, id: "22", version: 1, startDate: "2026-11-02", endDate: "2026-11-03" },
    });
    expect(await p).toEqual({ ok: true });
    expect(h.shown()).toEqual(["20@4:2026-10-19..2026-10-20", "21@1:2026-10-27..2026-10-28", "22@1:2026-11-02..2026-11-03"]);
    expect(h.s.getState().data!.allocations.find((a) => a.id === "20")!.repeatEndDate).toBe("2026-10-25");
  });

  it("SERIES_SPLIT_UNSUPPORTED du serveur : retour arrière complet, raison rendue", async () => {
    const h = await harness([weekly]);
    const p = h.s.splitOccurrence("20", 0, { hoursPerDay: 6 });
    h.writes[0]!.resolve(409, { code: "SERIES_SPLIT_UNSUPPORTED", params: { reason: "overlapping" }, requestId: "r" });
    expect(await p).toEqual({ ok: false, error: "SERIES_SPLIT_UNSUPPORTED", reason: "overlapping" });
    expect(h.shown()).toEqual(["20@3:2026-10-19..2026-10-20"]);
  });

  it("découpe que le moteur refuse (blocs qui se chevauchent) : aucun appel", async () => {
    const h = await harness([alloc("30", { startDate: "2026-10-19", endDate: "2026-10-28", repeatState: "weekly", repeatEndDate: "2026-12-01" })]);
    expect(await h.s.splitOccurrence("30", 1, { hoursPerDay: 6 })).toEqual({ ok: false, error: "SERIES_SPLIT_UNSUPPORTED", reason: "overlapping" });
    expect(h.writes).toHaveLength(0);
  });
});

describe("historique branché sur la source (undo / redo)", () => {
  const moved = alloc("10", { version: 4, startDate: "2026-10-22", endDate: "2026-10-23" });

  async function withHistory(initial: ScheduleResponse["allocations"], realtime = false) {
    const h = await harness(initial, realtime);
    const { history, dispose } = historyForSource(h.s);
    return { ...h, history, dispose };
  }
  async function move(h: Awaited<ReturnType<typeof withHistory>>) {
    const p = h.history.editor.updateAllocation("10", { startDate: "2026-10-22", endDate: "2026-10-23" });
    h.writes.at(-1)!.resolve(200, moved);
    expect(await p).toEqual({ ok: true });
  }

  it("undo : PATCH optimiste avec la version courante du magasin (pas celle capturée), champs d'avant", async () => {
    const h = await withHistory([alloc("10")]);
    await move(h);
    const p = h.history.undo();
    await flush();
    expect(h.shown()).toEqual(["10@4:2026-10-20..2026-10-21"]); // optimiste
    const w = h.writes.at(-1)!;
    expect([w.method, w.path, w.headers["If-Match"], w.body]).toEqual(["PATCH", "/api/v1/allocations/10", '"4"', { startDate: "2026-10-20", endDate: "2026-10-21" }]);
    w.resolve(200, alloc("10", { version: 5 }));
    expect(await p).toEqual({ ok: true, direction: "undo", label: "allocation.move" });
    const r = h.history.redo();
    await flush();
    expect(h.writes.at(-1)!.headers["If-Match"]).toBe('"5"');
    h.writes.at(-1)!.resolve(200, { ...moved, version: 6 });
    expect(await r).toMatchObject({ ok: true, direction: "redo" });
  });

  it("VERSION_CONFLICT pendant l'undo : action abandonnée, retour arrière et relecture", async () => {
    const h = await withHistory([alloc("10")]);
    await move(h);
    const p = h.history.undo();
    await flush();
    h.writes.at(-1)!.resolve(409, { code: "VERSION_CONFLICT", params: { currentVersion: 7 }, requestId: "r" });
    await flush();
    h.writes.at(-1)!.resolve(200, alloc("10", { version: 7, startDate: "2026-11-02", endDate: "2026-11-02" }));
    expect(await p).toMatchObject({ ok: false, error: "VERSION_CONFLICT", dropped: true });
    expect(h.history.getState()).toMatchObject({ canUndo: false, canRedo: false });
    expect(h.shown()).toEqual(["10@7:2026-11-02..2026-11-02"]);
  });

  it("écho temps réel de sa propre écriture : la pile reste ; changement d'un autre : seule l'action touchée tombe", async () => {
    const h = await withHistory([alloc("10"), alloc("11", { startDate: "2026-10-26", endDate: "2026-10-26" })], true);
    await move(h);
    const p = h.history.editor.updateAllocation("11", { hoursPerDay: 6 });
    h.writes.at(-1)!.resolve(200, alloc("11", { version: 4, startDate: "2026-10-26", endDate: "2026-10-26", hoursPerDay: 6 }));
    await p;
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "10", op: "update", version: 4 }));
    h.sockets[0]!.say(changes({ seq: "7", entity: "allocations", id: "11", op: "update", version: 4 }));
    await flush();
    expect(h.history.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.load" });
    h.sockets[0]!.say(changes({ seq: "8", entity: "allocations", id: "11", op: "update", version: 5 }));
    await flush();
    expect(h.history.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.move" });
    h.sockets[0]!.say(changes({ seq: "9", entity: "allocations", id: "10", op: "delete", version: null }));
    await flush();
    expect(h.history.getState().canUndo).toBe(false);
    h.dispose();
  });

  it("écho de sa propre écriture arrivé avant la réponse : pas d'invalidation", async () => {
    const h = await withHistory([alloc("10")], true);
    const p = h.history.editor.updateAllocation("10", { startDate: "2026-10-22", endDate: "2026-10-23" });
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "10", op: "update", version: 4 }));
    await flush();
    h.writes.at(-1)!.resolve(200, moved);
    await p;
    await flush();
    expect(h.history.getState().canUndo).toBe(true);
  });
});
