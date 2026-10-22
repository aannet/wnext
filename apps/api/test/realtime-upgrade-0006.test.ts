// RT-048, revue L-V : reprise du temps réel à travers la migration 0006 (change_log.person_ids). Base migrée jusqu'à 0005, des
// changements écrits sans person_ids, puis 0006 appliquée. Un member qui reprend depuis un curseur antérieur ne peut pas savoir si
// ces changements le concernaient : il reçoit `resync` (recharger GET /schedule) au lieu d'un rattrapage qui les sauterait en
// silence. Les rôles non filtrés rattrapent normalement ; les changements de référentiels antérieurs ne forcent rien.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { RealtimeServerMessage } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealtimeSession, dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

const users: Record<string, RequestContext> = {
  admin: { accountId: "1", userId: "1", role: "admin" },
  member: { accountId: "1", userId: "2", role: "member" },
  lone: { accountId: "1", userId: "3", role: "member" },
};
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const deps: HttpDeps = { db, authenticate: async (h) => users[String(h.authorization)] ?? null, newRequestId: () => "r" };
const post = async (url: string, body: unknown) => {
  const r = await dispatch(deps, { method: "POST", url, headers: { authorization: "admin" }, body: JSON.stringify(body) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
};
const alloc = (personId: string) => post("/api/v1/allocations", { personId, projectId: "1", startDate: "2026-03-02", endDate: "2026-03-02", load: { mode: "hours", hoursPerDay: 1 } });
const head = async () => String((await pg.query<{ seq: string }>("SELECT seq FROM account_change_seq WHERE account_id = 1")).rows[0]!.seq);
const sub = (cursor: string) => JSON.stringify({ v: 1, type: "subscribe", cursor });
async function replay(who: string, cursor: string) {
  const out: RealtimeServerMessage[] = [];
  const session = createRealtimeSession({ db, ctx: users[who]!, send: (m) => { out.push(RealtimeServerMessage.parse(m)); } });
  await session.receive(sub(cursor));
  return out;
}
const ids = (out: RealtimeServerMessage[]) => out.flatMap((m) => (m.type === "changes" ? m.changes.map((c) => `${c.entity}:${c.id}`) : []));

const cursors: Record<string, string> = {};
const written: Record<string, string> = {};

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((x) => x.endsWith(".sql")).sort();
  for (const f of files.filter((x) => x < "0006")) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('a@x.test'), ('m@x.test'), ('l@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name) VALUES (1, 'Mia'), (1, 'Bob');
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (1, 1, 'admin', NULL), (1, 2, 'member', 1), (1, 3, 'member', NULL);
    INSERT INTO projects (account_id, name) VALUES (1, 'P');
  `);
  // Avant 0006 : une allocation de Mia, puis seulement un férié (référentiel).
  cursors.beforePerson = await head();
  written.preMia = (await alloc("1")).id;
  cursors.beforeHoliday = await head();
  written.preHoliday = (await post("/api/v1/holidays", { name: "Férié", date: "2026-05-01" })).id;
  cursors.atMigration = await head();
  for (const f of files.filter((x) => x >= "0006")) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  written.postMia = (await alloc("1")).id;
  written.postBob = (await alloc("2")).id;
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("reprise à travers 0006 (RT-048)", () => {
  it("member depuis un curseur antérieur à un changement par personne d'avant 0006 : resync, rien d'autre", async () => {
    expect(await replay("member", cursors.beforePerson!)).toEqual([{ v: 1, type: "resync", reason: "cursor_expired", head: await head() }]);
  });

  it("member sans personne liée : resync aussi (la règle ne dépend pas du contenu qu'il ne peut pas lire)", async () => {
    expect((await replay("lone", cursors.beforePerson!)).map((m) => m.type)).toEqual(["resync"]);
  });

  it("member après les changements par personne d'avant 0006 : rattrapage normal (le férié antérieur ne force rien)", async () => {
    const out = await replay("member", cursors.beforeHoliday!);
    expect(ids(out)).toEqual([`holidays:${written.preHoliday}`, `allocations:${written.postMia}`]);
    expect(out.at(-1)).toEqual({ v: 1, type: "ready", cursor: await head() });
    expect(ids(await replay("member", cursors.atMigration!))).toEqual([`allocations:${written.postMia}`]);
  });

  it("admin depuis le même curseur ancien : tout, sans resync", async () => {
    const out = await replay("admin", cursors.beforePerson!);
    expect(ids(out)).toEqual([`allocations:${written.preMia}`, `holidays:${written.preHoliday}`, `allocations:${written.postMia}`, `allocations:${written.postBob}`]);
    expect(out.at(-1)!.type).toBe("ready");
  });

  it("après le resync, le member reprend depuis le changeCursor de GET /schedule sans nouveau resync", async () => {
    const r = await dispatch(deps, { method: "GET", url: "/api/v1/schedule?from=2026-03-02&to=2026-03-08", headers: { authorization: "member" } });
    const cursor = (r.body as { changeCursor: string }).changeCursor;
    expect(await replay("member", cursor)).toEqual([{ v: 1, type: "ready", cursor }]);
  });
});
