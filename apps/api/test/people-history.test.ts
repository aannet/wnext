// Historisation datée des personnes (@BR-19) contre la base MIGRÉE (schema.sql puis migrations/, PGlite) : PATCH avec
// effectiveFrom, date d'effet par défaut, période verrouillée (PERSON_HISTORY_LOCKED), GET /people/{id}/history (contrat,
// pagination, filtre, isolation), capacité datée lue par daily_capacity.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersonHistoryList, SchedulePerson } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  admin: { accountId: "1", userId: "1", role: "admin" },
  member: { accountId: "1", userId: "1", role: "member" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, opts: { body?: unknown; ifMatch?: string } = {}) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(opts.ifMatch !== undefined && { "if-match": opts.ifMatch }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };
const create = async (name: string) => (await send("admin", "POST", "/api/v1/people", { body: { name } })).body as { id: string; version: number };
const patch = async (id: string, body: unknown) => {
  const cur = (await send("admin", "GET", `/api/v1/people/${id}`)).body as { version: number };
  return send("admin", "PATCH", `/api/v1/people/${id}`, { body, ifMatch: `"${cur.version}"` });
};
const history = async (id: string, query = "", who = "admin") => send(who, "GET", `/api/v1/people/${id}/history${query}`);
const base = async (id: string, day: string) =>
  Number((await pg.query<{ h: string }>("SELECT base_hours AS h FROM daily_capacity(1, $1, $1) WHERE person_id = $2", [day, id])).rows[0]!.h);

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name, timezone) VALUES ('A', 'Pacific/Kiritimati'), ('B', 'UTC');
    INSERT INTO departments (account_id, name) VALUES (1, 'Design');
    INSERT INTO roles (account_id, name) VALUES (1, 'Dev');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("PATCH /people/{id} avec effectiveFrom (@BR-19)", () => {
  it("changement d'horaire au 1er du mois : capacité avant/après, la personne porte la nouvelle valeur", async () => {
    const p = await create("Paul");
    const r = await patch(p.id, { workDaysHours: [4, 4, 4, 4, 4, 0, 0], effectiveFrom: "2026-04-01" });
    expect(r.status).toBe(200);
    expect(SchedulePerson.safeParse(r.body).success).toBe(true);
    expect((r.body as { workDaysHours: number[] }).workDaysHours).toEqual([4, 4, 4, 4, 4, 0, 0]);
    expect(await base(p.id, "2026-03-31")).toBe(8);
    expect(await base(p.id, "2026-04-01")).toBe(4);
  });

  it("département et rôle datés ; GET /history les liste (contrat), filtre attribute", async () => {
    const p = await create("Dora");
    expect((await patch(p.id, { departmentId: "1", roleId: "1", effectiveFrom: "2026-02-01" })).status).toBe(200);
    const r = await history(p.id);
    expect(r.status).toBe(200);
    const list = PersonHistoryList.parse(r.body);
    expect(list.page).toEqual({ nextCursor: null, total: 5 });
    const dept = list.items.filter((e) => e.attribute === "departmentId");
    expect(dept).toEqual([
      expect.objectContaining({ validFrom: null, validTo: "2026-01-31", departmentId: null }),
      expect.objectContaining({ validFrom: "2026-02-01", validTo: null, departmentId: "1" }),
    ]);
    const wdh = await history(p.id, "?attribute=workDaysHours");
    expect((wdh.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ attribute: "workDaysHours", validFrom: null, validTo: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0] }),
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/cost|rate/i); // le taux de coût n'est jamais exposé
  });

  it("sans effectiveFrom : aujourd'hui dans le fuseau du compte (UTC+14 ici)", async () => {
    const p = await create("Tom");
    expect((await patch(p.id, { workDaysHours: [6, 6, 6, 6, 6, 0, 0] })).status).toBe(200);
    const today = (await pg.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS d")).rows[0]!.d;
    const items = (await history(p.id, "?attribute=workDaysHours")).body as { items: { validFrom: string | null }[] };
    expect(items.items.map((e) => e.validFrom)).toEqual([null, today]);
  });

  it("effectiveFrom sans attribut historisé modifié : sans effet ; effectiveFrom seul : 400", async () => {
    const p = await create("Nia");
    expect((await patch(p.id, { name: "Nia B.", effectiveFrom: "2026-02-01" })).status).toBe(200);
    expect(((await history(p.id)).body as { page: { total: number } }).page.total).toBe(3);
    const r = await patch(p.id, { effectiveFrom: "2026-02-01" });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe("VALIDATION_FAILED");
    expect(err(await patch(p.id, { workDaysHours: [1, 1, 1, 1, 1, 0, 0], effectiveFrom: "2026-02-30" })).code).toBe("VALIDATION_FAILED");
  });

  it("409 PERSON_HISTORY_LOCKED si effectiveFrom tombe dans une période verrouillée ; rien n'est écrit", async () => {
    const p = await create("Lou");
    await pg.exec(`INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1, ${p.id}, 1, '2026-03-10', 4);
                   UPDATE logged_time SET status = 'submitted' WHERE person_id = ${p.id};`);
    const before = (await send("admin", "GET", `/api/v1/people/${p.id}`)).body as { version: number };
    for (const day of ["2026-03-10", "2026-01-01"]) {
      const r = await patch(p.id, { departmentId: "1", effectiveFrom: day });
      expect(r.status).toBe(409);
      expect(err(r)).toEqual({ code: "PERSON_HISTORY_LOCKED", params: { lockedThrough: "2026-03-10" }, requestId: "r" });
    }
    expect(((await send("admin", "GET", `/api/v1/people/${p.id}`)).body as { version: number }).version).toBe(before.version);
    expect((await patch(p.id, { departmentId: "1", effectiveFrom: "2026-03-11" })).status).toBe(200);
    // Les autres champs restent modifiables malgré le verrou.
    expect((await patch(p.id, { name: "Lou B." })).status).toBe(200);
  });
});

describe("GET /people/{id}/history (@BR-19)", () => {
  it("paginé par curseur ; limit et curseur invalides refusés", async () => {
    const p = await create("Page");
    const one = await history(p.id, "?limit=2");
    const b = one.body as { items: { id: string }[]; page: { nextCursor: string; total: number } };
    expect(b.items).toHaveLength(2);
    expect(b.page.total).toBe(3);
    const two = (await history(p.id, `?limit=2&cursor=${encodeURIComponent(b.page.nextCursor)}`)).body as { items: { id: string }[]; page: { nextCursor: null } };
    expect(two.items).toHaveLength(1);
    expect(two.page.nextCursor).toBeNull();
    expect(new Set([...b.items, ...two.items].map((e) => e.id)).size).toBe(3);
    expect(err(await history(p.id, "?cursor=%%%")).code).toBe("SCHEDULE_CURSOR_INVALID");
    expect(err(await history(p.id, "?attribute=costRate")).code).toBe("VALIDATION_FAILED");
    expect(err(await history(p.id, "?limit=0")).code).toBe("VALIDATION_FAILED");
  });

  it("tout membre lit ; anonyme 401 ; autre compte ou id inconnu 404", async () => {
    const p = await create("Iso");
    expect((await history(p.id, "", "member")).status).toBe(200);
    expect((await history(p.id, "", "anon")).status).toBe(401);
    expect(err(await history(p.id, "", "other"))).toMatchObject({ code: "NOT_FOUND", params: { entity: "person" } });
    expect((await history("999999", "")).status).toBe(404);
    expect((await history("abc", "")).status).toBe(404);
  });
});
