// Journal de changements côté API : le curseur de GET /schedule est la position réelle du journal, les écritures de l'API
// y apparaissent avec la bonne version, la reprise ne perd rien, l'isolation et l'expiration tiennent.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, readChanges, type Db, type HttpDeps, type RequestContext } from "../src/index";

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const A: RequestContext = { accountId: "1", userId: "1", role: "admin" };
const B: RequestContext = { accountId: "2", userId: "1", role: "admin" };
const deps: HttpDeps = { db, authenticate: async (h) => (h.authorization === "A" ? A : h.authorization === "B" ? B : null), newRequestId: () => "r" };
const http = (who: string, method: string, url: string, body?: unknown, ifMatch?: string) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(ifMatch && { "if-match": ifMatch }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const cursor = async () => ((await http("A", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as { changeCursor: string }).changeCursor;
const since = async (c: string, ctx = A) => {
  const r = await readChanges(db, ctx, c);
  if (r.status !== "ok") throw new Error("curseur expiré");
  return r;
};
const alloc = { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-03", load: { mode: "hours", hoursPerDay: 4 } };

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

describe("changeCursor de GET /schedule", () => {
  it("est la position du journal : après les seeds, puis +1 par écriture de l'API", async () => {
    const c0 = Number(await cursor());
    expect(c0).toBeGreaterThan(0); // les INSERT du seed (personnes, projets) sont journalisés
    await http("A", "POST", "/api/v1/allocations", alloc);
    expect(Number(await cursor())).toBe(c0 + 1);
    expect(Number(await cursor())).toBe(c0 + 1); // une lecture ne change rien
  });
});

describe("readChanges", () => {
  it("rejoue exactement les écritures faites depuis le curseur, dans l'ordre, avec les versions", async () => {
    const c = await cursor();
    const created = (await http("A", "POST", "/api/v1/allocations", alloc)).body as { id: string; version: number };
    const patched = (await http("A", "PATCH", `/api/v1/allocations/${created.id}`, { name: "x" }, `"${created.version}"`)).body as { version: number };
    await http("A", "DELETE", `/api/v1/allocations/${created.id}`, undefined, `"${patched.version}"`);
    const r = await since(c);
    expect(r.changes.map((x) => [x.entity, x.id, x.op, x.version])).toEqual([
      ["allocations", created.id, "insert", 1],
      ["allocations", created.id, "update", patched.version],
      ["allocations", created.id, "delete", null],
    ]);
    expect(r.changes.map((x) => Number(x.seq))).toEqual([Number(c) + 1, Number(c) + 2, Number(c) + 3]);
    expect(r.head).toBe(String(Number(c) + 3));
    expect(r.hasMore).toBe(false);
  });

  it("un écriture refusée (409, 404, 403) n'écrit rien dans le journal", async () => {
    const created = (await http("A", "POST", "/api/v1/allocations", alloc)).body as { id: string; version: number };
    const c = await cursor();
    await http("A", "PATCH", `/api/v1/allocations/${created.id}`, { name: "x" }, '"99"'); // 409
    await http("A", "PATCH", "/api/v1/allocations/99999", { name: "x" }, '"1"');           // 404
    await http("A", "POST", "/api/v1/allocations", { ...alloc, personId: "2" });            // 404 (autre compte)
    expect((await since(c)).changes).toEqual([]);
    expect(await cursor()).toBe(c);
  });

  it("reprise : depuis le dernier curseur reçu, rien n'est perdu ni rejoué", async () => {
    const c = await cursor();
    for (let i = 0; i < 5; i++) await http("A", "POST", "/api/v1/allocations", alloc);
    const first = await readChanges(db, A, c, 2);
    if (first.status !== "ok") throw new Error();
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const rest = await since(first.changes[1]!.seq);
    expect(rest.changes).toHaveLength(3);
    expect([...first.changes, ...rest.changes].map((x) => Number(x.seq))).toEqual([1, 2, 3, 4, 5].map((i) => Number(c) + i));
  });

  it("cascade : supprimer une personne journalise la suppression de ses allocations", async () => {
    await pg.exec("INSERT INTO people (account_id, name) VALUES (1, 'Temp')");
    const id = String((await pg.query<{ id: string }>("SELECT id FROM people WHERE name = 'Temp'")).rows[0]!.id);
    const a = (await http("A", "POST", "/api/v1/allocations", { ...alloc, personId: id })).body as { id: string };
    const c = await cursor();
    await pg.exec(`DELETE FROM people WHERE id = ${id}`);
    const entities = (await since(c)).changes.map((x) => `${x.entity}:${x.op}:${x.id}`);
    expect(entities).toEqual(expect.arrayContaining([`allocations:delete:${a.id}`, `people:delete:${id}`]));
  });

  it("isolation : le compte B ne voit jamais les changements de A", async () => {
    const c = await cursor();
    await http("A", "POST", "/api/v1/allocations", alloc);
    const b = await since("0", B);
    expect(b.changes.every((x) => ["people", "projects"].includes(x.entity))).toBe(true);
    expect(b.changes.length).toBe(2); // seulement le seed de B
    expect((await since(c)).changes).toHaveLength(1);
  });

  it("curseur illisible ou du futur : SCHEDULE_CURSOR_INVALID", async () => {
    const head = Number(await cursor());
    for (const bad of ["", "abc", "-1", "1.5", String(head + 1), "9".repeat(20)]) {
      await expect(readChanges(db, A, bad)).rejects.toMatchObject({ code: "SCHEDULE_CURSOR_INVALID" });
    }
  });

  it("curseur périmé après purge : status expired (recharger) ; curseur à jour toujours accepté", async () => {
    const old = await cursor();
    await http("A", "POST", "/api/v1/allocations", alloc);
    await http("A", "POST", "/api/v1/allocations", alloc);
    const mid = await cursor();
    await http("A", "POST", "/api/v1/allocations", alloc);
    // vieillit les entrées <= mid, puis purge (rôle d'exploitation : le superuser contourne la RLS)
    await pg.exec(`UPDATE change_log SET changed_at = now() - interval '8 days' WHERE account_id = 1 AND seq <= ${mid}`);
    await pg.exec("SELECT purge_change_log('7 days')");
    expect(await readChanges(db, A, old)).toMatchObject({ status: "expired" });
    const ok = await since(mid);
    expect(ok.changes).toHaveLength(1);
    expect((await readChanges(db, A, await cursor())).status).toBe("ok");
  });
});
