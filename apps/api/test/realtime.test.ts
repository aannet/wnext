// Session temps réel : rattrapage, ready, flux direct, expiration, erreurs, isolation, conformité au contrat.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { RealtimeServerMessage } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChangeHub, createRealtimeSession, dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const A: RequestContext = { accountId: "1", userId: "1", role: "admin" };
const B: RequestContext = { accountId: "2", userId: "1", role: "admin" };
const deps: HttpDeps = { db, authenticate: async (h) => (h.authorization === "A" ? A : h.authorization === "B" ? B : null), newRequestId: () => "r" };
const write = (who: string) => dispatch(deps, { method: "POST", url: "/api/v1/allocations", headers: { authorization: who },
  body: JSON.stringify({ personId: who === "A" ? "1" : "2", projectId: who === "A" ? "1" : "2", startDate: "2026-03-02", endDate: "2026-03-03", load: { mode: "hours", hoursPerDay: 4 } }) });
const head = async () => ((await dispatch(deps, { method: "GET", url: "/api/v1/schedule?from=2026-03-02&to=2026-03-06", headers: { authorization: "A" } })).body as { changeCursor: string }).changeCursor;
const sub = (cursor: string) => JSON.stringify({ v: 1, type: "subscribe", cursor });

function open(ctx = A, pageSize?: number) {
  const out: RealtimeServerMessage[] = [];
  const session = createRealtimeSession({ db, ctx, pageSize, send: (m) => { out.push(RealtimeServerMessage.parse(m)); } }); // chaque message émis respecte le contrat
  return { out, session };
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (2, 'Intrus');
    INSERT INTO projects (account_id, name) VALUES (1, 'P'), (2, 'Q');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("session temps réel", () => {
  it("à jour : ready direct, puis le flux direct n'émet que les nouveautés", async () => {
    const c = await head();
    const { out, session } = open();
    await session.receive(sub(c));
    expect(out).toEqual([{ v: 1, type: "ready", cursor: c }]);
    await session.poll();
    expect(out).toHaveLength(1); // rien de neuf : silence
    await write("A");
    await session.poll();
    expect(out[1]).toMatchObject({ type: "changes", cursor: String(Number(c) + 1), hasMore: false, changes: [{ entity: "allocations", op: "insert", version: 1 }] });
    await session.poll();
    expect(out).toHaveLength(2); // pas de doublon
  });

  it("temps saisi : diffusé comme les allocations (entité logged_time)", async () => {
    const c = await head();
    const r = await dispatch(deps, { method: "POST", url: "/api/v1/logged-time", headers: { authorization: "A" },
      body: JSON.stringify({ personId: "1", projectId: "1", workDate: "2026-03-02", hours: 3 }) });
    expect(r.status).toBe(201);
    const { out, session } = open();
    await session.receive(sub(c));
    expect(out[0]).toMatchObject({ type: "changes", changes: [{ entity: "logged_time", id: (r.body as { id: string }).id, op: "insert", version: 1 }] });
  });

  it("rattrapage par lots avant ready, ordre conservé", async () => {
    const c = await head();
    for (let i = 0; i < 5; i++) await write("A");
    const { out, session } = open(A, 2);
    await session.receive(sub(c));
    expect(out.map((m) => m.type)).toEqual(["changes", "changes", "changes", "ready"]);
    const seqs = out.flatMap((m) => (m.type === "changes" ? m.changes.map((x) => Number(x.seq)) : []));
    expect(seqs).toEqual([1, 2, 3, 4, 5].map((i) => Number(c) + i));
    expect(out.filter((m) => m.type === "changes").map((m) => m.type === "changes" && m.hasMore)).toEqual([true, true, false]);
    expect(out[3]).toEqual({ v: 1, type: "ready", cursor: String(Number(c) + 5) });
  });

  it("n'expose rien d'un autre compte", async () => {
    const c = await head();
    await write("B");
    const { out, session } = open();
    await session.receive(sub(c));
    expect(out).toEqual([{ v: 1, type: "ready", cursor: c }]);
  });

  it("member sur une base sans 0006 (pas de change_log.person_ids) : aucun changement par personne, les référentiels passent (RT-048)", async () => {
    await pg.exec("INSERT INTO users (email) VALUES ('m@x.test'); INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (1, 2, 'member', 1)");
    const c = await head();
    const { out, session } = open({ accountId: "1", userId: "2", role: "member" });
    await session.receive(sub(c));
    await write("A"); // allocation de sa propre personne : refus par défaut sans la colonne
    await dispatch(deps, { method: "POST", url: "/api/v1/holidays", headers: { authorization: "A" }, body: JSON.stringify({ name: "Férié", date: "2026-05-01" }) });
    await session.poll();
    expect(out.flatMap((m) => (m.type === "changes" ? m.changes.map((x) => x.entity) : []))).toEqual(["holidays"]);
  });

  it("curseur expiré : resync puis la session s'arrête", async () => {
    await pg.exec("UPDATE account_change_seq SET purged_through = seq WHERE account_id = 1");
    const { out, session } = open();
    await session.receive(sub("1"));
    expect(out).toEqual([{ v: 1, type: "resync", reason: "cursor_expired", head: expect.any(String) }]);
    await write("A");
    await session.poll();
    expect(out).toHaveLength(1);
    await pg.exec("UPDATE account_change_seq SET purged_through = 0 WHERE account_id = 1");
  });

  it("curseur du futur : SCHEDULE_CURSOR_INVALID", async () => {
    const { out, session } = open();
    await session.receive(sub("999999999"));
    expect(out).toEqual([{ v: 1, type: "error", code: "SCHEDULE_CURSOR_INVALID", params: {} }]);
  });

  it.each([
    ["non JSON", "{pas du json"],
    ["type inconnu", JSON.stringify({ v: 1, type: "create", cursor: "0" })],
    ["version de protocole inconnue", JSON.stringify({ v: 2, type: "subscribe", cursor: "0" })],
    ["curseur illisible", JSON.stringify({ v: 1, type: "subscribe", cursor: "abc" })],
  ])("message refusé : %s", async (_n, raw) => {
    const { out, session } = open();
    await session.receive(raw);
    expect(out).toEqual([{ v: 1, type: "error", code: "VALIDATION_FAILED", params: {} }]);
    await session.receive(sub(await head())); // la session reste utilisable
    expect(out[1]).toMatchObject({ type: "ready" });
  });

  it("double abonnement refusé, flux inchangé", async () => {
    const { out, session } = open();
    await session.receive(sub(await head()));
    await session.receive(sub("0"));
    expect(out.map((m) => m.type)).toEqual(["ready", "error"]);
  });

  it("close : plus aucun message", async () => {
    const { out, session } = open();
    await session.receive(sub(await head()));
    session.close();
    await write("A");
    await session.poll();
    expect(out).toHaveLength(1);
  });

  it("poll avant l'abonnement : silence", async () => {
    const { out, session } = open();
    await session.poll();
    expect(out).toEqual([]);
  });

  it("close pendant une lecture en cours : rien n'est émis après", async () => {
    const slow: Db = { transaction: async (fn) => { await new Promise((r) => setTimeout(r, 60)); return db.transaction(fn); } };
    const c = await head();
    await write("A");
    const out: RealtimeServerMessage[] = [];
    const session = createRealtimeSession({ db: slow, ctx: A, send: (m) => out.push(m) });
    const p = session.receive(sub(c));
    setTimeout(() => session.close(), 10);
    await p;
    expect(out).toEqual([]);
  });

  it("minuteur : le flux direct arrive sans appel explicite à poll", async () => {
    const out: RealtimeServerMessage[] = [];
    const session = createRealtimeSession({ db, ctx: A, pollIntervalMs: 20, send: (m) => out.push(m) });
    await session.receive(sub(await head()));
    await write("A");
    await new Promise((r) => setTimeout(r, 300));
    session.close();
    expect(out.map((m) => m.type)).toEqual(["ready", "changes"]);
  });

  it("les messages sont traités dans l'ordre même envoyés sans attendre", async () => {
    const { out, session } = open();
    const c = await head();
    await Promise.all([session.receive(sub(c)), session.receive(sub(c))]);
    expect(out.map((m) => m.type)).toEqual(["ready", "error"]);
  });
});

describe("sondage partagé (ChangeHub)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const counted = () => { const c = { n: 0 }; return { c, db: { transaction: (fn) => { c.n++; return db.transaction(fn); } } as Db }; };

  it("au repos, une lecture par compte et par période, quel que soit le nombre de sessions", async () => {
    const { c, db: cdb } = counted();
    const hub = createChangeHub({ db: cdb, intervalMs: 20 });
    const cur = await head();
    const sessions = Array.from({ length: 5 }, () => {
      const out: RealtimeServerMessage[] = [];
      return { out, s: createRealtimeSession({ db, ctx: A, hub, send: (m) => out.push(m) }) };
    });
    for (const x of sessions) await x.s.receive(sub(cur));
    await wait(30); // le réveil de rattrapage de l'abonnement est passé
    const before = c.n;
    await wait(200);
    const ticks = c.n - before;
    sessions.forEach((x) => x.s.close());
    hub.close();
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThanOrEqual(12); // ~10 périodes : 5 sessions n'ont pas coûté 50 lectures
    expect(sessions.every((x) => x.out.length === 1)).toBe(true); // ready seul : aucun faux réveil visible
  });

  it("un changement réveille toutes les sessions du compte, pas celles des autres comptes", async () => {
    const hub = createChangeHub({ db, intervalMs: 20 });
    const mk = (ctx: RequestContext) => { const out: RealtimeServerMessage[] = []; return { out, s: createRealtimeSession({ db, ctx, hub, send: (m) => out.push(m) }) }; };
    const a1 = mk(A), a2 = mk(A), b = mk(B);
    await a1.s.receive(sub(await head()));
    await a2.s.receive(sub(await head()));
    await b.s.receive(sub("0"));
    const bBefore = b.out.length;
    await write("A");
    await wait(150);
    [a1, a2, b].forEach((x) => x.s.close());
    hub.close();
    for (const x of [a1, a2]) expect(x.out.map((m) => m.type)).toEqual(["ready", "changes"]);
    expect(b.out.length).toBe(bBefore);
  });

  it("un changement survenu entre la lecture du rattrapage et l'abonnement n'est pas perdu", async () => {
    const hub = createChangeHub({ db, intervalMs: 20 });
    const first = open(A);
    await first.session.receive(sub(await head())); // sans hub : sert seulement à créer du trafic
    first.session.close();
    // Le hub a déjà observé la tête courante, puis un changement part, puis une session s'abonne avec un curseur antérieur.
    const noop = hub.subscribe(A, () => {});
    await wait(60);
    const c = await head();
    const out: RealtimeServerMessage[] = [];
    const late = createRealtimeSession({ db, ctx: A, hub, send: (m) => out.push(m) });
    await late.receive(sub(c));
    await write("A");
    await wait(150);
    late.close(); noop(); hub.close();
    expect(out.map((m) => m.type)).toEqual(["ready", "changes"]);
  });

  it("close désabonne : plus aucune lecture une fois toutes les sessions parties", async () => {
    const { c, db: cdb } = counted();
    const hub = createChangeHub({ db: cdb, intervalMs: 20 });
    const s = createRealtimeSession({ db, ctx: A, hub, send: () => {} });
    await s.receive(sub(await head()));
    await wait(60);
    s.close();
    const n = c.n;
    await wait(120);
    hub.close();
    expect(c.n).toBe(n);
  });

  it("une erreur de lecture est signalée, n'arrête pas le hub, et le réveil est rejoué", async () => {
    let fail = true;
    const flaky: Db = { transaction: (fn) => (fail ? Promise.reject(new Error("db down")) : db.transaction(fn)) };
    const errors: unknown[] = [];
    const hub = createChangeHub({ db: flaky, intervalMs: 20, onError: (e) => errors.push(e) });
    let wakes = 0;
    const off = hub.subscribe(A, () => { wakes++; });
    await wait(80);
    expect(errors.length).toBeGreaterThan(0);
    expect(wakes).toBe(0);
    fail = false;
    await wait(80);
    off(); hub.close();
    expect(wakes).toBe(1);
  });

  it("réveil de rattrapage unique à l'abonnement, puis silence tant que la tête ne bouge pas", async () => {
    const hub = createChangeHub({ db, intervalMs: 20 });
    let w1 = 0, w2 = 0;
    const off1 = hub.subscribe(A, () => { w1++; });
    await wait(100);
    expect(w1).toBe(1);
    // Un arrivant tardif a pu lire le journal avant la tête déjà vue : il est réveillé une fois, même sans nouveau changement.
    const off2 = hub.subscribe(A, () => { w2++; });
    await wait(100);
    off1(); off2(); hub.close();
    expect(w2).toBe(1);
  });
});
