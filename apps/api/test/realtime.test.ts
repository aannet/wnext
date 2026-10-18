// Session temps réel : rattrapage, ready, flux direct, expiration, erreurs, isolation, conformité au contrat.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { RealtimeServerMessage } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealtimeSession, dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

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
