// BR-33 : matrice rôle × action sur les écritures de projet, contre schema.sql réel (PGlite, sous app_user).
//  * owner et admin écrivent sur tous les projets ; un project_manager seulement sur les projets qu'il gère (chef de projet via la
//    personne liée à son compte, ou co-gestionnaire via project_managers) ; member et guest jamais ; un autre compte ne voit rien (404).
//  * Refus d'un PM hors de ses projets : 403 FORBIDDEN, params { role: "project_manager", scope: "project" }, sans rien écrire.
//  * Taux et montants : member et guest n'en reçoivent jamais (ressources financières en 403, aucune clé de taux ailleurs).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type HttpReply, type RequestContext } from "../src/index";

// @BR-33 @BR-10
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
// Compte 1 : P1 (chef de projet = Paula, personne liée à l'utilisateur 2), P2 (co-gestion : project_managers de l'utilisateur 3), P3 (personne).
// Compte 2 : un admin et son projet. Les identifiants sont fixés par l'ordre d'insertion ci-dessous.
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "1", role: "admin" },
  pmLead: { accountId: "1", userId: "2", role: "project_manager" },
  pmCo: { accountId: "1", userId: "3", role: "project_manager" },
  pmNone: { accountId: "1", userId: "4", role: "project_manager" },
  member: { accountId: "1", userId: "5", role: "member" },
  guest: { accountId: "1", userId: "6", role: "guest" },
  other: { accountId: "2", userId: "7", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, ifMatch?: number): Promise<HttpReply> =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(ifMatch !== undefined && { "if-match": `"${ifMatch}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (r: Promise<HttpReply>) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBeLessThan(300); return x.body as any; };

let day = 0; // chaque action prend des dates neuves : pas de chevauchement entre lignes de la matrice
const nextDates = () => { day += 1; const d = new Date(Date.UTC(2027, 0, 4) + 7 * day * 86_400_000).toISOString().slice(0, 10); return { start: d, end: d }; };
const alloc = (project: string, person = "1") => { const { start, end } = nextDates(); return { personId: person, projectId: project, startDate: start, endDate: end, load: { mode: "hours", hoursPerDay: 2 } }; };
const adminAlloc = (project: string, extra: Record<string, unknown> = {}) => ok(send("admin", "POST", "/api/v1/allocations", { ...alloc(project), ...extra }));

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) SELECT 'u' || g || '@x.test' FROM generate_series(1, 7) g;
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (1, 'Bob'), (1, 'Paula'), (1, 'Mona'), (2, 'Intrus');
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES
      (1, 1, 'owner', NULL), (1, 2, 'project_manager', 3), (1, 3, 'project_manager', NULL), (1, 4, 'project_manager', NULL),
      (1, 5, 'member', 4), (1, 6, 'guest', NULL), (2, 7, 'admin', NULL);
    INSERT INTO projects (account_id, name, project_manager_id) VALUES (1, 'P1', 3), (1, 'P2', NULL), (1, 'P3', NULL), (2, 'Secret', NULL);
    INSERT INTO project_managers (project_id, account_id, user_id) VALUES (2, 1, 3);
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

// Une action = préparation par l'admin (hors matrice, `prep`) puis UNE requête du rôle testé (`req`) sur le projet donné.
type Prepared = any;
interface Action { prep?: (p: string) => Promise<Prepared>; req: (who: string, p: string, x: Prepared) => Promise<HttpReply> }
const created = (url: string, body: (p: string) => Record<string, unknown>) => (p: string) => ok(send("admin", "POST", url, body(p)));
const patchOf = (url: string, patch: Record<string, unknown>) => (who: string, _p: string, x: Prepared) => send(who, "PATCH", `${url}/${x.id}`, patch, x.version);
const deleteOf = (url: string) => (who: string, _p: string, x: Prepared) => send(who, "DELETE", `${url}/${x.id}`, undefined, x.version);
const group = (p: string) => { const { start, end } = nextDates(); return { projectId: p, startDate: start, endDate: end, load: { mode: "hours", hoursPerDay: 1 }, members: [{ personId: "1" }, { personId: "2" }] }; };
const phase = (p: string) => ({ projectId: p, name: "Ph" });
const task = (p: string) => ({ projectId: p, name: "T" });
const milestone = (p: string) => ({ projectId: p, name: "M", dueDate: "2027-06-01" });
const expense = (p: string) => ({ projectId: p, name: "E", amount: "10" });
const log = (p: string) => ({ personId: "1", projectId: p, workDate: nextDates().start, hours: 1 });
// Ligne de budget : une par cible et par projet, donc une tâche neuve à chaque fois.
const newTask = (p: string) => ok(send("admin", "POST", "/api/v1/project-tasks", task(p)));
const budgetLine = async (p: string) => ok(send("admin", "POST", "/api/v1/project-budget-lines", { projectId: p, taskId: (await newTask(p)).id, hours: 5 }));

const ACTIONS: Record<string, Action> = {
  "POST /allocations": { req: (who, p) => send(who, "POST", "/api/v1/allocations", alloc(p)) },
  "PATCH /allocations/{id}": { prep: (p) => adminAlloc(p), req: patchOf("/api/v1/allocations", { name: "x" }) },
  "DELETE /allocations/{id}": { prep: (p) => adminAlloc(p), req: deleteOf("/api/v1/allocations") },
  "POST /allocations/{id}/split": {
    prep: (p) => adminAlloc(p, { repeatState: "weekly", repeatEndDate: "2029-12-31" }),
    req: (who, _p, a) => send(who, "POST", `/api/v1/allocations/${a.id}/split`, { occurrenceDate: a.startDate, delete: true }, a.version),
  },
  "POST /allocation-groups": { req: (who, p) => send(who, "POST", "/api/v1/allocation-groups", group(p)) },
  "PATCH /allocations/{id}/group": {
    prep: created("/api/v1/allocation-groups", group),
    req: (who, _p, g) => send(who, "PATCH", `/api/v1/allocations/${g.items[0].id}/group`, { name: "y" }, g.items[0].version),
  },
  "DELETE /allocations/{id}/group": {
    prep: created("/api/v1/allocation-groups", group),
    req: (who, _p, g) => send(who, "DELETE", `/api/v1/allocations/${g.items[0].id}/group`, undefined, g.items[0].version),
  },
  "PUT /projects/{p}/team/{person}": { req: (who, p) => send(who, "PUT", `/api/v1/projects/${p}/team/2`) },
  "POST /projects/{p}/team": { req: (who, p) => send(who, "POST", `/api/v1/projects/${p}/team`, { personIds: ["1"] }) },
  "GET /projects/{p}/team/{person}/removal-summary": { req: (who, p) => send(who, "GET", `/api/v1/projects/${p}/team/4/removal-summary`) },
  "POST /projects/{p}/team/{person}/removal": {
    prep: async (p) => { await ok(send("admin", "PUT", `/api/v1/projects/${p}/team/4`)); },
    req: (who, p) => send(who, "POST", `/api/v1/projects/${p}/team/4/removal`, {}),
  },
  "PATCH /projects/{id}": { prep: (p) => ok(send("admin", "GET", `/api/v1/projects/${p}`)), req: (who, p, cur) => send(who, "PATCH", `/api/v1/projects/${p}`, { notes: who }, cur.version) },
  "POST /phases": { req: (who, p) => send(who, "POST", "/api/v1/phases", phase(p)) },
  "PATCH /phases/{id}": { prep: created("/api/v1/phases", phase), req: patchOf("/api/v1/phases", { name: "Ph2" }) },
  "DELETE /phases/{id}": { prep: created("/api/v1/phases", phase), req: deleteOf("/api/v1/phases") },
  "POST /project-tasks": { req: (who, p) => send(who, "POST", "/api/v1/project-tasks", task(p)) },
  "PATCH /project-tasks/{id}": { prep: created("/api/v1/project-tasks", task), req: patchOf("/api/v1/project-tasks", { name: "T2" }) },
  "DELETE /project-tasks/{id}": { prep: created("/api/v1/project-tasks", task), req: deleteOf("/api/v1/project-tasks") },
  "POST /milestones": { req: (who, p) => send(who, "POST", "/api/v1/milestones", milestone(p)) },
  "PATCH /milestones/{id}": { prep: created("/api/v1/milestones", milestone), req: patchOf("/api/v1/milestones", { name: "M2" }) },
  "DELETE /milestones/{id}": { prep: created("/api/v1/milestones", milestone), req: deleteOf("/api/v1/milestones") },
  "POST /project-expenses": { req: (who, p) => send(who, "POST", "/api/v1/project-expenses", expense(p)) },
  "PATCH /project-expenses/{id}": { prep: created("/api/v1/project-expenses", expense), req: patchOf("/api/v1/project-expenses", { amount: "12" }) },
  "DELETE /project-expenses/{id}": { prep: created("/api/v1/project-expenses", expense), req: deleteOf("/api/v1/project-expenses") },
  "POST /project-budget-lines": { prep: newTask, req: (who, p, t) => send(who, "POST", "/api/v1/project-budget-lines", { projectId: p, taskId: t.id, hours: 5 }) },
  "PATCH /project-budget-lines/{id}": { prep: budgetLine, req: patchOf("/api/v1/project-budget-lines", { hours: 6 }) },
  "DELETE /project-budget-lines/{id}": { prep: budgetLine, req: deleteOf("/api/v1/project-budget-lines") },
  "POST /logged-time": { req: (who, p) => send(who, "POST", "/api/v1/logged-time", log(p)) },
  "PATCH /logged-time/{id}": { prep: created("/api/v1/logged-time", log), req: patchOf("/api/v1/logged-time", { hours: 2 }) },
  "DELETE /logged-time/{id}": { prep: created("/api/v1/logged-time", log), req: deleteOf("/api/v1/logged-time") },
};

// Projet visé selon le rôle : le PM vise un projet qu'il gère (allow) ou non (scope) ; l'autre compte vise P1 du compte 1.
type Expect = "allow" | "scope" | "role" | "notFound" | "anon";
const CASES: Array<{ who: string; project: string; expect: Expect }> = [
  { who: "owner", project: "3", expect: "allow" },
  { who: "admin", project: "3", expect: "allow" },
  { who: "pmLead", project: "1", expect: "allow" }, // chef de projet (project_manager_id = sa personne)
  { who: "pmCo", project: "2", expect: "allow" }, // co-gestionnaire (project_managers)
  { who: "pmLead", project: "2", expect: "scope" },
  { who: "pmLead", project: "3", expect: "scope" },
  { who: "pmCo", project: "1", expect: "scope" },
  { who: "pmNone", project: "1", expect: "scope" }, // PM sans projet
  { who: "member", project: "1", expect: "role" },
  { who: "guest", project: "1", expect: "role" },
  { who: "other", project: "1", expect: "notFound" }, // autre compte : le projet n'existe pas pour lui
  { who: "anon", project: "1", expect: "anon" },
];

/** Empreinte des tables écrites par la matrice (nombre de lignes, somme des versions) : un refus ne doit rien y changer. */
const TABLES = ["allocations", "projects", "phases", "project_tasks", "milestones", "project_expenses", "project_budget_lines", "logged_time"];
const snapshot = async () => (await pg.query<{ s: string }>(
  `SELECT concat_ws('|', (SELECT count(*) FROM project_team), ${TABLES.map((t) => `(SELECT count(*) FROM ${t}), (SELECT coalesce(sum(row_version), 0) FROM ${t})`).join(", ")}) AS s`,
)).rows[0]!.s;

describe.each(Object.entries(ACTIONS).map(([name, action]) => ({ name, action })))("BR-33 $name", ({ action }) => {
  it.each(CASES)("$who sur le projet $project : $expect", async ({ who, project, expect: want }) => {
    // Pour l'autre compte, la préparation vise le même projet du compte 1 (il doit le voir inexistant).
    const prepared = action.prep ? await action.prep(project) : undefined;
    const before = await snapshot();
    const r = await action.req(who, project, prepared);
    if (want === "allow") {
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      return;
    }
    const body = r.body as { code: string; params: Record<string, unknown> };
    if (want === "anon") expect([r.status, body.code]).toEqual([401, "UNAUTHENTICATED"]);
    else if (want === "notFound") expect([r.status, body.code], JSON.stringify(r.body)).toEqual([404, "NOT_FOUND"]);
    else {
      expect([r.status, body.code], JSON.stringify(r.body)).toEqual([403, "FORBIDDEN"]);
      expect(body.params).toEqual(want === "scope" ? { role: "project_manager", scope: "project" } : { role: roles[who]!.role });
    }
    expect(await snapshot()).toBe(before); // aucun refus n'écrit
  });
});

describe("BR-33 : changer d'un projet géré vers un autre", () => {
  it("PATCH d'une allocation de P1 vers P3 par le chef de P1 : 403, ligne inchangée", async () => {
    const a = await adminAlloc("1");
    const r = await send("pmLead", "PATCH", `/api/v1/allocations/${a.id}`, { projectId: "3" }, a.version);
    expect(r.status).toBe(403);
    expect((r.body as any).params).toEqual({ role: "project_manager", scope: "project" });
    expect((await ok(send("admin", "GET", `/api/v1/allocations/${a.id}`))).projectId).toBe("1");
  });

  it("PATCH d'une allocation de P3 vers P1 par le chef de P1 : 403 (il ne gère pas la ligne d'origine)", async () => {
    const a = await adminAlloc("3");
    expect((await send("pmLead", "PATCH", `/api/v1/allocations/${a.id}`, { projectId: "1" }, a.version)).status).toBe(403);
  });

  it("le PM qui crée un projet en devient co-gestionnaire et peut l'écrire ensuite", async () => {
    const p = await ok(send("pmNone", "POST", "/api/v1/projects", { name: "Nouveau" }));
    expect((await send("pmNone", "POST", "/api/v1/phases", { projectId: p.id, name: "Ph" })).status).toBe(201);
    expect((await send("pmLead", "POST", "/api/v1/phases", { projectId: p.id, name: "Ph" })).status).toBe(403);
  });

  it("projet inconnu : 404 avant le contrôle de périmètre (pas d'oracle sur les projets gérés)", async () => {
    const r = await send("pmLead", "POST", "/api/v1/phases", { projectId: "999", name: "Ph" });
    expect(r.status).toBe(404);
    const a = await adminAlloc("1");
    const moved = await send("pmLead", "PATCH", `/api/v1/allocations/${a.id}`, { projectId: "999" }, a.version);
    expect([moved.status, (moved.body as any).params]).toEqual([404, { entity: "project" }]);
    const secret = await send("pmLead", "PATCH", `/api/v1/allocations/${a.id}`, { projectId: "4" }, a.version); // projet du compte 2
    expect([secret.status, (secret.body as any).params]).toEqual([404, { entity: "project" }]);
  });

  it("désactivation d'une personne : un PM est refusé si elle a des allocations futures hors de ses projets", async () => {
    const asOf = "2027-01-01";
    await ok(send("admin", "POST", "/api/v1/people", { name: "Zoé" }));
    const zoe = (await pg.query<{ id: string }>("SELECT id::text FROM people WHERE name = 'Zoé'")).rows[0]!.id;
    await ok(send("admin", "POST", "/api/v1/allocations", { ...alloc("3"), personId: zoe }));
    const r = await send("pmLead", "POST", `/api/v1/people/${zoe}/deactivation`, { asOf, disposition: "delete", confirmation: { allocationCount: 1 } });
    expect(r.status).toBe(403);
    expect((r.body as any).params).toEqual({ role: "project_manager", scope: "project" });
    expect((await ok(send("admin", "POST", `/api/v1/people/${zoe}/deactivation`, { asOf, disposition: "delete", confirmation: { allocationCount: 1 } }))).deletedAllocations).toBe(1);
  });
});

describe("BR-33 : taux et montants invisibles pour member et guest", () => {
  const RATE_KEYS = /rate|cost|amount|budget|margin|price|fee/i;
  const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
    return out;
  };

  it.each(["member", "guest"])("%s : 403 sur les dépenses et lignes de budget (lecture comme écriture)", async (who) => {
    const e = await ok(send("admin", "POST", "/api/v1/project-expenses", { projectId: "1", name: "E", amount: "10" }));
    for (const url of ["/api/v1/project-expenses?projectId=1", `/api/v1/project-expenses/${e.id}`, "/api/v1/project-budget-lines?projectId=1"]) {
      const r = await send(who, "GET", url);
      expect(r.status, url).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("amount");
    }
  });

  it.each(["member", "guest"])("%s : aucune clé de taux, coût ou montant dans les lectures ouvertes", async (who) => {
    await pg.exec("UPDATE people SET cost_rate = 123.45 WHERE account_id = 1");
    for (const url of [
      "/api/v1/people", "/api/v1/people/1", "/api/v1/projects", "/api/v1/projects/1", "/api/v1/schedule?from=2027-01-01&to=2027-03-31",
      "/api/v1/projects/1/team", "/api/v1/projects/1/allocations?from=2027-01-01&to=2027-12-31", "/api/v1/phases?projectId=1",
    ]) {
      const r = await send(who, "GET", url);
      expect(r.status, url).toBe(200);
      const leaked = [...keysOf(r.body)].filter((k) => RATE_KEYS.test(k));
      expect(leaked, url).toEqual([]);
      expect(JSON.stringify(r.body), url).not.toContain("123.45");
    }
  });
});
