// Écriture des personnes contre schema.sql réel (PGlite) : contrat, verrou optimiste, rôles, isolation, désactivation, absence de fuite.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersonDetail, ScheduleResponse, SchedulePerson } from "@wnext/contracts";
import { createPerson, dispatch, readChanges, updatePerson, type Db, type HttpDeps, type RequestContext } from "../src/index";

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  admin: { accountId: "1", userId: "1", role: "admin" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  guest: { accountId: "1", userId: "1", role: "guest" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, opts: { body?: unknown; ifMatch?: string; raw?: string } = {}) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(opts.ifMatch !== undefined && { "if-match": opts.ifMatch }) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
const create = (body: unknown, who = "admin") => send(who, "POST", "/api/v1/people", { body });
const ifm = (v: number | string) => (typeof v === "number" ? `"${v}"` : v);
const patch = (id: string, v: number | string, body: unknown, who = "admin") => send(who, "PATCH", `/api/v1/people/${id}`, { body, ifMatch: ifm(v) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };
const row = async (id: string) => (await pg.query<any>("SELECT * FROM people WHERE id = $1", [id])).rows[0];
const count = async () => Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM people")).rows[0]!.n);
const made = async (extra: Record<string, unknown> = {}) => (await create({ name: "Zoé", ...extra })).body as any;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO departments (account_id, name) VALUES (1, 'Design'), (2, 'Autre');
    INSERT INTO roles (account_id, name) VALUES (1, 'Dev'), (2, 'Autre');
    INSERT INTO people (account_id, name, email, cost_rate) VALUES (1, 'Alice', 'alice@x.test', 99.5), (2, 'Intrus', NULL, NULL);
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 1, 1, '2026-03-02', '2026-03-06', 'hours', 8);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("POST /people", () => {
  it("201 : valide le contrat ; défauts du serveur", async () => {
    const r = await create({ name: "Bob" });
    expect(r.status).toBe(201);
    expect(SchedulePerson.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ version: 1, name: "Bob", peopleType: "employee", departmentId: null, roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true });
  });

  it("profil complet, y compris semaine à temps partiel et références du compte", async () => {
    const r = await create({ name: "Chloé", peopleType: "contractor", departmentId: "1", roleId: "1", country: "FR", workDaysHours: [8, 8, 4, 8, 0, 0, 0], tags: ["front", "é &=?"], avatarUrl: "https://x.test/a.png", active: false });
    expect(r.body).toMatchObject({ peopleType: "contractor", departmentId: "1", roleId: "1", country: "FR", workDaysHours: [8, 8, 4, 8, 0, 0, 0], tags: ["front", "é &=?"], avatarUrl: "https://x.test/a.png", active: false });
  });

  it("n'écrit ni e-mail ni coût (colonnes absentes) et ne les renvoie pas", async () => {
    const r = await create({ name: "Dan", email: "dan@x.test", costRate: 120 } as never);
    expect(r.status).toBe(201);
    const stored = await row(r.body.id);
    expect(stored.email).toBeNull();
    expect(stored.cost_rate).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/email|cost|rate/i);
  });

  it.each([
    ["nom absent", {}],
    ["nom d'espaces", { name: "  " }],
    ["pays minuscule", { name: "A", country: "fr" }],
    ["6 jours", { name: "A", workDaysHours: [8, 8, 8, 8, 8, 0] }],
    ["heures > 24", { name: "A", workDaysHours: [8, 8, 8, 8, 25, 0, 0] }],
    ["type inconnu", { name: "A", peopleType: "intern" }],
  ])("400 VALIDATION_FAILED : %s", async (_n, body) => {
    const before = await count();
    const r = await create(body);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe("VALIDATION_FAILED");
    expect(await count()).toBe(before);
  });

  it("400 sur corps absent ou illisible", async () => {
    expect((await send("admin", "POST", "/api/v1/people")).status).toBe(400);
    expect((await send("admin", "POST", "/api/v1/people", { raw: "{x" })).status).toBe(400);
  });

  it.each([
    ["département inconnu", { departmentId: "999" }, "department"],
    ["département d'un autre compte", { departmentId: "2" }, "department"],
    ["rôle d'un autre compte", { roleId: "2" }, "role"],
    ["identifiant non numérique", { roleId: "1 OR 1=1" }, "role"],
  ])("404 NOT_FOUND : %s", async (_n, extra, entity) => {
    const before = await count();
    const r = await create({ name: "X", ...extra });
    expect(r.status).toBe(404);
    expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity } });
    expect(await count()).toBe(before);
  });

  it("rôles : member et guest 403 (même corps invalide), anonyme 401, pm autorisé ; le domaine refuse aussi", async () => {
    const before = await count();
    for (const who of ["member", "guest"]) expect((await create({ n: "x" }, who)).status).toBe(403);
    expect((await create({ name: "A" }, "anon")).status).toBe(401);
    expect(await count()).toBe(before);
    expect((await create({ name: "Par pm" }, "pm")).status).toBe(201);
    await expect(createPerson(db, roles.member!, { name: "A" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updatePerson(db, roles.guest!, "1", 1, { active: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("l'isolation : la personne créée appartient au compte de l'appelant", async () => {
    const r = await create({ name: "Chez B" }, "other");
    expect(String((await row(r.body.id)).account_id)).toBe("2");
  });
});

describe("PATCH /people/{id}", () => {
  it("200 : version +1, champs absents inchangés", async () => {
    const p = await made({ country: "FR", tags: ["a"], departmentId: "1", workDaysHours: [8, 8, 4, 8, 0, 0, 0] });
    const r = await patch(p.id, p.version, { name: "Zoé 2" });
    expect(r.status).toBe(200);
    expect(SchedulePerson.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ id: p.id, version: 2, name: "Zoé 2", country: "FR", tags: ["a"], departmentId: "1", workDaysHours: [8, 8, 4, 8, 0, 0, 0] });
  });

  it("null efface département, rôle, pays et avatar ; tags et semaine se remplacent", async () => {
    const p = await made({ departmentId: "1", roleId: "1", country: "FR", avatarUrl: "u", tags: ["x", "y"] });
    const r = await patch(p.id, 1, { departmentId: null, roleId: null, country: null, avatarUrl: null, tags: ["z"], workDaysHours: [1, 2, 3, 4, 5, 6, 7] });
    expect(r.body).toMatchObject({ departmentId: null, roleId: null, country: null, avatarUrl: null, tags: ["z"], workDaysHours: [1, 2, 3, 4, 5, 6, 7] });
    expect(await patch(p.id, 2, { tags: [] })).toMatchObject({ body: { tags: [], workDaysHours: [1, 2, 3, 4, 5, 6, 7] } });
  });

  it("désactiver puis réactiver ; les allocations de la personne restent intactes", async () => {
    const off = await patch("1", 1, { active: false });
    expect(off.body).toMatchObject({ active: false, version: 2 });
    expect(Number((await pg.query<any>("SELECT count(*) AS n FROM allocations WHERE person_id = 1")).rows[0].n)).toBe(1);
    const sched = ScheduleResponse.parse((await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body);
    expect(sched.people.find((x) => x.id === "1")).toBeUndefined(); // retirée du Schedule
    expect((await patch("1", 2, { active: true })).body).toMatchObject({ active: true, version: 3 });
  });

  it("n'écrase ni e-mail ni coût", async () => {
    await patch("1", 3, { name: "Alice" });
    const r = await row("1");
    expect(r.email).toBe("alice@x.test");
    expect(Number(r.cost_rate)).toBe(99.5);
  });

  it("409 VERSION_CONFLICT avec currentVersion ; la ligne n'est pas modifiée", async () => {
    const p = await made();
    await patch(p.id, 1, { name: "premier" });
    const r = await patch(p.id, 1, { name: "second" });
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
    expect((await row(p.id)).name).toBe("premier");
  });

  it("428 sans If-Match, 400 si mal formé", async () => {
    const p = await made();
    expect((await send("admin", "PATCH", `/api/v1/people/${p.id}`, { body: { name: "x" } })).status).toBe(428);
    for (const bad of ["1", 'W/"1"']) expect((await patch(p.id, bad, { name: "x" })).status).toBe(400);
  });

  it("404 : inconnue, non numérique, d'un autre compte (intacte) ; références hors compte", async () => {
    expect((await patch("99999", 1, { name: "x" })).status).toBe(404);
    expect((await patch("abc", 1, { name: "x" })).status).toBe(404);
    const p = await made();
    expect((await patch(p.id, 1, { name: "intrus" }, "other")).status).toBe(404);
    expect((await row(p.id)).name).toBe("Zoé");
    expect(err(await patch(p.id, 1, { departmentId: "2" })).params).toEqual({ entity: "department" });
    expect(err(await patch(p.id, 1, { roleId: "2" })).params).toEqual({ entity: "role" });
    expect((await row(p.id)).row_version).toBe(1);
  });

  it("rôle : member 403, anonyme 401, rien modifié", async () => {
    const p = await made();
    expect((await patch(p.id, 1, { name: "x" }, "member")).status).toBe(403);
    expect((await patch(p.id, 1, { name: "x" }, "anon")).status).toBe(401);
    expect((await row(p.id)).row_version).toBe(1);
  });

  it("DELETE n'existe pas : 404 de route, la personne reste", async () => {
    const p = await made();
    const r = await send("admin", "DELETE", `/api/v1/people/${p.id}`, { ifMatch: '"1"' });
    expect(r.status).toBe(404);
    expect(err(r).params).toEqual({ entity: "route" });
    expect(await row(p.id)).toBeDefined();
  });
});

describe("cohérence avec la lecture et le journal", () => {
  it("GET /schedule renvoie la personne telle que la réponse d'écriture", async () => {
    const p = await made({ tags: ["zz"] });
    const sched = ScheduleResponse.parse((await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06&limit=200")).body);
    const { access, ...person } = p; // access est propre aux routes people (PersonDetail, RT-040)
    expect(access).toBe("none");
    expect(sched.people.find((x) => x.id === p.id)).toEqual(person);
  });

  it("access (RT-040) : none à la création, member une fois une ligne account_members liée ; absent de PersonDeactivationResult", async () => {
    const p = await made();
    expect(PersonDetail.parse(p)).toMatchObject({ access: "none" });
    await pg.query("INSERT INTO users (email) VALUES ('lie@x.test')");
    await pg.query("INSERT INTO account_members (account_id, user_id, role, person_id) SELECT 1, id, 'member', $1 FROM users WHERE email = 'lie@x.test'", [p.id]);
    const r = await patch(p.id, 1, { name: "Liée" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "Liée", access: "member" });
    const d = await send("admin", "POST", `/api/v1/people/${p.id}/deactivation`, { body: {} });
    expect(d.status).toBe(200);
    expect(Object.keys((d.body as { person: object }).person)).not.toContain("access");
  });

  it("les écritures apparaissent dans change_log ; un refus n'ajoute rien", async () => {
    const head = ((await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as { changeCursor: string }).changeCursor;
    const p = await made();
    await patch(p.id, 1, { name: "n" });
    await patch(p.id, 1, { name: "périmé" });
    await create({ name: "" });
    const r = await readChanges(db, roles.admin!, head);
    if (r.status !== "ok") throw new Error("expiré");
    expect(r.changes.map((c) => [c.entity, c.id, c.op, c.version])).toEqual([["people", p.id, "insert", 1], ["people", p.id, "update", 2]]);
  });
});
