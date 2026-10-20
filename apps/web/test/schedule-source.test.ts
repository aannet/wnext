// Source de données du Schedule : pagination, blocs fusionnés, déduplication, réponses périmées, temps réel, erreurs.
// API (client généré sur un fetch simulé) et WebSocket simulés.
import type { Change, ScheduleResponse } from "@wnext/contracts";
import { loadChunks, mergeChunks, page, viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createScheduleSource, errorCodeOf, type ScheduleSourceOptions } from "../src/data/schedule-source";
import type { SocketLike } from "../src/realtime/client";

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const VIEW = viewAt("2026-10-19", "day", 960);

const person = (id: string, version = 1) => ({
  id, version, name: `P${id.padStart(3, "0")}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, personId: string, startDate: string, version = 1) => ({
  id, version, personId, projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null, startDate, endDate: startDate,
  status: "confirmed" as const, billable: true, priority: 0, repeatState: "none" as const, repeatEndDate: null,
  mode: "hours" as const, hoursPerDay: 4, percent: null,
});

/** Une page de GET /schedule. */
function pageOf(q: URLSearchParams, over: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    window: { from: q.get("from")!, to: q.get("to")! }, changeCursor: "5", page: { nextCursor: null, total: 1 },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: [person("1")], allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
    ...over,
  };
}

interface Call { url: string; query: URLSearchParams; resolve(status: number, body: unknown): void }

/** Fetch simulé : chaque appel attend qu'on le résolve (ou `auto` répond tout de suite). */
function fakeApi(auto?: (q: URLSearchParams, path: string) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (url: string) => new Promise<FetchResponse>((res) => {
    const u = new URL(url, "http://x");
    const call: Call = { url, query: u.searchParams, resolve: (status, body) => res({ status, json: async () => body }) };
    calls.push(call);
    if (auto) { const r = auto(u.searchParams, u.pathname); call.resolve(r.status, r.body); }
  });
  const api = createClient({ baseUrl: "", fetch });
  const schedule = () => calls.filter((c) => c.url.startsWith("/api/v1/schedule"));
  return { api, calls, schedule };
}

function source(f: ReturnType<typeof fakeApi>, over: Partial<ScheduleSourceOptions> = {}) {
  const s = createScheduleSource({ api: f.api, ...over });
  s.setViewport(VIEW);
  return s;
}

describe("chargement de la fenêtre", () => {
  it("blocs adjacents fusionnés en une requête, puis plus aucune requête pour la même vue", async () => {
    const f = fakeApi((q) => ({ status: 200, body: pageOf(q) }));
    const s = source(f);
    s.start();
    await flush();
    const [merged] = mergeChunks(loadChunks(VIEW, 1));
    expect(loadChunks(VIEW, 1).length).toBeGreaterThan(1);
    expect(f.schedule().map((c) => [c.query.get("from"), c.query.get("to")])).toEqual([[merged!.from, merged!.to]]);
    expect(s.getState()).toMatchObject({ loading: false, error: null });
    expect(s.getState().data!.people.map((p) => p.id)).toEqual(["1"]);
    s.setViewport({ ...VIEW });
    await flush();
    expect(f.schedule()).toHaveLength(1);
  });

  it("défilement : seuls les blocs nouveaux sont demandés", async () => {
    const f = fakeApi((q) => ({ status: 200, body: pageOf(q) }));
    const s = source(f);
    s.start();
    await flush();
    const next = page(page(page(VIEW, 1), 1), 1);
    s.setViewport(next);
    await flush();
    const before = new Set(loadChunks(VIEW, 1).map((c) => c.from));
    const fresh = loadChunks(next, 1).filter((c) => !before.has(c.from));
    expect(f.schedule()).toHaveLength(2);
    expect(f.schedule()[1]!.query.get("from")).toBe(fresh[0]!.from);
    expect(f.schedule()[1]!.query.get("to")).toBe(fresh.at(-1)!.to);
  });

  it("changement de tranche sans donnée nouvelle : même objet `data` (l'écran ne reconstruit pas son modèle une seconde fois)", async () => {
    const f = fakeApi((q) => ({ status: 200, body: pageOf(q, { allocations: [alloc("10", "1", "2026-10-20"), alloc("11", "1", "2026-12-01")] }) }));
    const s = source(f);
    s.start();
    await flush();
    const far = page(page(page(VIEW, 1), 1), 1);
    s.setViewport(far);
    await flush();
    const data = s.getState().data!;
    expect(data.allocations.map((a) => a.id).sort()).toEqual(["10", "11"]);
    let notified = 0;
    const off = s.subscribe(() => { notified++; });
    // Retour sur des blocs déjà chargés : la couverture change (autre tranche), le contenu du magasin non.
    expect(loadChunks(VIEW, 1)[0]!.from).not.toBe(loadChunks(far, 1)[0]!.from);
    for (const v of [VIEW, page(VIEW, 1), far]) {
      s.setViewport(v);
      await flush();
      expect(s.getState().data).toBe(data);
    }
    expect(f.schedule()).toHaveLength(2);
    expect(notified).toBe(0);
    off();
  });

  it("pagination : suit nextCursor jusqu'au bout, n'affiche qu'une fois toutes les pages reçues", async () => {
    const f = fakeApi();
    const s = createScheduleSource({ api: f.api, pageLimit: 2 });
    s.setViewport(VIEW);
    s.start();
    await flush();
    const first = f.schedule()[0]!;
    expect(first.query.get("limit")).toBe("2");
    expect(first.query.get("cursor")).toBeNull();
    first.resolve(200, pageOf(first.query, { people: [person("1"), person("2")], page: { nextCursor: "c1", total: 3 }, changeCursor: "7" }));
    await flush();
    expect(s.getState().data).toBeNull();
    expect(s.getState().loading).toBe(true);
    const second = f.schedule()[1]!;
    expect(second.query.get("cursor")).toBe("c1");
    expect(second.query.get("from")).toBe(first.query.get("from"));
    second.resolve(200, pageOf(second.query, { people: [person("3")], allocations: [alloc("10", "3", "2026-10-20")] }));
    await flush();
    expect(f.schedule()).toHaveLength(2);
    expect(s.getState().data!.people.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(s.getState().data!.allocations.map((a) => a.id)).toEqual(["10"]);
    expect(s.getState().loading).toBe(false);
  });

  it("requête en vol dédupliquée : une nouvelle vue sur les mêmes blocs ne relance rien", async () => {
    const f = fakeApi();
    const s = source(f);
    s.start();
    s.setViewport({ ...VIEW, center: VIEW.center + 0.3 });
    s.setViewport(VIEW);
    await flush();
    expect(f.schedule()).toHaveLength(1);
    f.schedule()[0]!.resolve(200, pageOf(f.schedule()[0]!.query));
    await flush();
    expect(s.getState().data!.people).toHaveLength(1);
    expect(f.schedule()).toHaveLength(1);
  });

  it("erreur 401 -> état UNAUTHENTICATED (corps illisible : code déduit du statut)", async () => {
    const f = fakeApi(() => ({ status: 401, body: { code: "UNAUTHENTICATED", params: {}, requestId: "r" } }));
    const s = source(f);
    s.start();
    await flush();
    expect(s.getState()).toMatchObject({ error: "UNAUTHENTICATED", data: null, loading: false });
    expect(errorCodeOf(401, null)).toBe("UNAUTHENTICATED");
    expect(errorCodeOf(403, "<html>")).toBe("FORBIDDEN");
    expect(errorCodeOf(429, {})).toBe("RATE_LIMITED");
    expect(errorCodeOf(502, null)).toBe("INTERNAL_ERROR");
    expect(errorCodeOf(400, { code: "SCHEDULE_RANGE_INVALID" })).toBe("SCHEDULE_RANGE_INVALID");
  });
});

// ---------- temps réel ----------

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: any[] = [];
  constructor(readonly url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() {}
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

function live(auto: (q: URLSearchParams, path: string, n: number) => { status: number; body: unknown }) {
  let n = 0;
  const f = fakeApi((q, path) => (path.endsWith("/realtime/ticket")
    ? { status: 201, body: { ticket: "t-AAAAAAAAAAAAAAAA", expiresInSeconds: 30 } }
    : auto(q, path, n++)));
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const s = source(f, {
    realtime: {
      wsBase: "ws://app.test",
      openSocket: (url) => { const k = new FakeSocket(url); sockets.push(k); return k; },
      setTimer: (fn) => { timers.push(fn); return fn; },
      clearTimer: () => {},
      random: () => 0,
    },
  });
  const goLive = async () => { const k = sockets.at(-1)!; k.onopen?.({}); k.say({ v: 1, type: "ready", cursor: "5" }); await flush(); };
  return { f, s, sockets, timers, goLive };
}
const changes = (...cs: Change[]) => ({ v: 1, type: "changes", changes: cs, cursor: cs.at(-1)!.seq, hasMore: false });

describe("temps réel", () => {
  it("s'abonne depuis le plus ancien changeCursor du visible, statut connecté", async () => {
    const h = live((q) => ({ status: 200, body: pageOf(q, { changeCursor: "5" }) }));
    h.s.start();
    await flush();
    expect(h.s.getState().realtime).toBe("connecting");
    h.sockets[0]!.onopen?.({});
    expect(h.sockets[0]!.sent).toEqual([{ v: 1, type: "subscribe", cursor: "5" }]);
    await h.goLive();
    expect(h.s.getState().realtime).toBe("live");
  });

  it("changement distant : recharge le visible et affiche la nouvelle version ; une version déjà connue est ignorée", async () => {
    const h = live((q, _p, n) => ({ status: 200, body: pageOf(q, { allocations: [alloc("10", "1", "2026-10-20", n === 0 ? 1 : 2)] }) }));
    h.s.start();
    await flush();
    await h.goLive();
    expect(h.f.schedule()).toHaveLength(1);
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "10", op: "update", version: 1 }));
    await flush();
    expect(h.f.schedule()).toHaveLength(1);
    h.sockets[0]!.say(changes({ seq: "7", entity: "allocations", id: "10", op: "update", version: 2 }));
    await flush();
    expect(h.f.schedule()).toHaveLength(2);
    expect(h.s.getState().data!.allocations.map((a) => [a.id, a.version])).toEqual([["10", 2]]);
  });

  it("allocation sortie du visible : retirée après rechargement ; suppression appliquée sans requête", async () => {
    const h = live((q, _p, n) => ({ status: 200, body: pageOf(q, { allocations: n === 0 ? [alloc("10", "1", "2026-10-20"), alloc("11", "1", "2026-10-21")] : [alloc("11", "1", "2026-10-21")] }) }));
    h.s.start();
    await flush();
    await h.goLive();
    h.sockets[0]!.say(changes({ seq: "6", entity: "allocations", id: "11", op: "delete", version: null }));
    await flush();
    expect(h.f.schedule()).toHaveLength(1);
    expect(h.s.getState().data!.allocations.map((a) => a.id)).toEqual(["10"]);
    h.sockets[0]!.say(changes({ seq: "7", entity: "allocations", id: "10", op: "update", version: 2 }));
    await flush();
    expect(h.s.getState().data!.allocations).toEqual([]);
  });

  it("resync : magasin neuf, visible rechargé, affichage conservé pendant le rechargement ; réponse périmée ignorée", async () => {
    const h = live((q, _p, n) => ({ status: 200, body: pageOf(q, { people: n === 0 ? [person("1"), person("2")] : [person("1")] }) }));
    h.s.start();
    await flush();
    await h.goLive();
    expect(h.s.getState().data!.people).toHaveLength(2);
    h.sockets[0]!.say({ v: 1, type: "resync", reason: "cursor_expired", head: "9" });
    h.sockets[0]!.onclose?.({});
    await flush();
    expect(h.s.getState().data!.people).toHaveLength(2); // pas d'écran vide pendant l'attente
    h.timers.at(-1)!();
    await flush();
    expect(h.f.schedule()).toHaveLength(2);
    // personne 2 supprimée pendant la coupure : le magasin neuf ne la garde pas
    expect(h.s.getState().data!.people.map((p) => p.id)).toEqual(["1"]);
    expect(h.sockets).toHaveLength(2);
  });

  it("réponse périmée : une requête lancée avant un resync n'est pas intégrée", async () => {
    const f = fakeApi();
    const s = source(f);
    s.start();
    await flush();
    const old = f.schedule()[0]!;
    s.stop(); // même effet qu'un resync : nouvelle époque
    s.start();
    await flush();
    const fresh = f.schedule()[1]!;
    fresh.resolve(200, pageOf(fresh.query, { people: [person("1")] }));
    await flush();
    old.resolve(200, pageOf(old.query, { people: [person("1"), person("99")] }));
    await flush();
    expect(s.getState().data!.people.map((p) => p.id)).toEqual(["1"]);
    expect(s.getState().loading).toBe(false);
  });

  it("401 au chargement initial : arrêt du temps réel et état UNAUTHENTICATED", async () => {
    const h = live(() => ({ status: 401, body: { code: "UNAUTHENTICATED", params: {}, requestId: "r" } }));
    h.s.start();
    await flush();
    expect(h.s.getState()).toMatchObject({ error: "UNAUTHENTICATED", realtime: "stopped" });
    expect(h.sockets).toHaveLength(0);
  });
});
