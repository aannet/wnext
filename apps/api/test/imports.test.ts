// Import CSV simple (US-1.2) contre la base MIGRÉE (schema.sql puis migrations/, PGlite) : dryRun sans écriture, application en
// une transaction (tout ou rien, ou lignes valides avec skipInvalid), ré-import idempotent, références créées, audit et journal
// temps réel, rôles, bornes, historique verrouillé (BR-12/BR-19), isolation des comptes.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { IMPORT_MAX_ROWS, ImportReport } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-19 @BR-12
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "1", role: "admin" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const run = (kind: string, csv: string, opts: { who?: string; dryRun?: boolean; skipInvalid?: boolean; raw?: string } = {}) =>
  dispatch(deps, {
    method: "POST", url: `/api/v1/imports/${kind}${opts.dryRun ? "?dryRun=true" : ""}`, headers: { authorization: opts.who ?? "admin" },
    body: opts.raw ?? JSON.stringify({ csv, ...(opts.skipInvalid !== undefined && { skipInvalid: opts.skipInvalid }) }),
  });
const report = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(200);
  expect(ImportReport.safeParse(r.body).success).toBe(true);
  return r.body as ImportReport;
};
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO departments (account_id, name) VALUES (1, 'Design');
    INSERT INTO people (account_id, name, email) VALUES (1, 'Bob Chef', 'bob@x.fr'), (2, 'Intrus', 'alice@x.fr');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

const PEOPLE = "Nom;E-mail;Département;Rôle;Heures/jour\nAlice;alice@x.fr;design;Dev;7,5\nCarl;carl@x.fr;Ops;dev;\n";

describe("POST /imports/people", () => {
  it("dryRun : rapport complet, aucune écriture", async () => {
    const before = await n("SELECT count(*) AS n FROM change_log");
    const r = report(await run("people", PEOPLE, { dryRun: true }));
    expect(r).toMatchObject({ kind: "people", dryRun: true, applied: false, delimiter: ";", rows: 2, created: 2, updated: 0, unchanged: 0, invalid: 0,
      references: { departments: ["Ops"], roles: ["Dev"], clients: [] }, errors: [], errorsTruncated: false });
    expect(await n("SELECT count(*) AS n FROM people WHERE account_id = 1")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM departments")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM change_log")).toBe(before);
  });
  it("application : personnes et références créées, audit et journal temps réel ; e-mail écrit mais jamais renvoyé", async () => {
    const logged = "SELECT count(*) AS n FROM change_log WHERE account_id = 1 AND entity = 'people' AND op = 'insert'";
    const before = await n(logged);
    const r = report(await run("people", PEOPLE));
    expect(r).toMatchObject({ dryRun: false, applied: true, created: 2, updated: 0 });
    const rows = (await pg.query<Record<string, unknown>>(
      `SELECT p.name, p.email, d.name AS dep, r.name AS role, p.work_days_hours::text AS wdh, p.created_by::text AS cb
         FROM people p LEFT JOIN departments d ON d.id = p.department_id LEFT JOIN roles r ON r.id = p.role_id WHERE p.account_id = 1 AND p.email <> 'bob@x.fr' ORDER BY p.id`)).rows;
    expect(rows).toEqual([
      { name: "Alice", email: "alice@x.fr", dep: "Design", role: "Dev", wdh: "{7.50,7.50,7.50,7.50,7.50,0.00,0.00}", cb: "1" },
      { name: "Carl", email: "carl@x.fr", dep: "Ops", role: "Dev", wdh: "{8.00,8.00,8.00,8.00,8.00,0.00,0.00}", cb: "1" },
    ]);
    expect(await n(logged)).toBe(before + 2);
    expect(JSON.stringify(r)).not.toContain("carl@x.fr");
    expect(await n("SELECT count(*) AS n FROM people WHERE account_id = 2")).toBe(1); // même e-mail dans un autre compte : intact
  });
  it("ré-import du même fichier : 0 création, 0 mise à jour, aucune version ne bouge", async () => {
    const versions = await n("SELECT sum(row_version) AS n FROM people");
    const r = report(await run("people", PEOPLE));
    expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 2, references: { departments: [], roles: [], clients: [] } });
    expect(await n("SELECT sum(row_version) AS n FROM people")).toBe(versions);
  });
  it("mise à jour par e-mail (sans casse) des seules cellules non vides", async () => {
    const r = report(await run("people", "name,email,type,country\nAlice M.,ALICE@x.fr,contractor,\n"));
    expect(r).toMatchObject({ created: 0, updated: 1 });
    expect((await pg.query("SELECT name, people_type, country, email FROM people WHERE email = 'alice@x.fr' AND account_id = 1")).rows)
      .toEqual([{ name: "Alice M.", people_type: "contractor", country: null, email: "alice@x.fr" }]);
  });
  it("erreurs sans skipInvalid : 422 IMPORT_HAS_ERRORS, rien n'est écrit ; avec skipInvalid : lignes valides seulement", async () => {
    const csv = "name,email,department\nDan,dan@x.fr,Neuf\n,sans-nom@x.fr,\nEve,pas-un-mail,\n";
    const refused = await run("people", csv);
    expect(refused.status).toBe(422);
    expect(err(refused)).toEqual({ code: "IMPORT_HAS_ERRORS", params: { invalid: 2, rows: 3 }, requestId: "r" });
    expect(await n("SELECT count(*) AS n FROM people WHERE email = 'dan@x.fr'")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM departments WHERE name = 'Neuf'")).toBe(0);
    const r = report(await run("people", csv, { skipInvalid: true }));
    expect(r).toMatchObject({ applied: true, created: 1, invalid: 2, references: { departments: ["Neuf"] } });
    expect(r.errors.map((e) => [e.line, e.column, e.code])).toEqual([[3, "name", "required"], [4, "email", "invalid_email"]]);
    expect(await n("SELECT count(*) AS n FROM people WHERE email = 'dan@x.fr'")).toBe(1);
  });
  it("BR-12/BR-19 : département changé pour une personne aux temps soumis jusqu'à aujourd'hui : history_locked", async () => {
    await pg.exec(`
      INSERT INTO projects (account_id, name) VALUES (1, 'Verrou');
      INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours)
        SELECT 1, id, (SELECT id FROM projects WHERE name = 'Verrou'), (now() + interval '2 days')::date, 4 FROM people WHERE email = 'carl@x.fr';
      UPDATE logged_time SET status = 'submitted';
    `);
    const r = report(await run("people", "name,email,department\nCarl,carl@x.fr,Design\n", { dryRun: true }));
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, column: "department", code: "history_locked" })]);
  });
});

describe("POST /imports/projects et /imports/clients", () => {
  it("projets : client créé, chef de projet par e-mail, ré-import idempotent, chef inconnu = erreur", async () => {
    const csv = "Code projet,Nom,Client,Chef de projet,Début,Fin,Facturable,Couleur\nP-1,Site web,Acme,bob@x.fr,01/03/2026,2026-06-30,non,#12ab34\nP-2,Appli,ACME,Bob Chef,,,,\n";
    const r = report(await run("projects", csv));
    expect(r).toMatchObject({ created: 2, references: { clients: ["Acme"] } });
    expect((await pg.query(`SELECT p.project_code, c.name AS client, pm.name AS pm, p.start_date::text AS s, p.non_billable, p.color FROM projects p
      LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN people pm ON pm.id = p.project_manager_id WHERE p.project_code IS NOT NULL ORDER BY p.id`)).rows).toEqual([
      { project_code: "P-1", client: "Acme", pm: "Bob Chef", s: "2026-03-01", non_billable: true, color: "#12AB34" },
      { project_code: "P-2", client: "Acme", pm: "Bob Chef", s: null, non_billable: false, color: "#3B82F6" },
    ]);
    expect(report(await run("projects", csv))).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    const bad = report(await run("projects", "name,project_code,project_manager\nX,P-3,zed@x.fr\n", { dryRun: true }));
    expect(bad.errors.map((e) => e.code)).toEqual(["unknown_reference"]);
  });
  it("clients : création, mise à jour, ré-import idempotent", async () => {
    expect(report(await run("clients", "name,short_name,tags\nacme,AC,vip\nGlobex,,\n"))).toMatchObject({ created: 1, updated: 1 });
    expect(report(await run("clients", "name,short_name,tags\nacme,AC,vip\nGlobex,,\n"))).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect((await pg.query("SELECT name, short_name, tags FROM clients ORDER BY id")).rows).toEqual([
      { name: "Acme", short_name: "AC", tags: ["vip"] }, { name: "Globex", short_name: null, tags: [] },
    ]);
  });
});

describe("garde-fous", () => {
  it("rôles : owner et admin seulement, refus avant le corps ; anonyme 401", async () => {
    for (const who of ["pm", "member"]) expect(err(await run("people", "", { who, raw: "{" }))).toMatchObject({ code: "FORBIDDEN" });
    expect((await run("people", "", { who: "anon", raw: "{" })).status).toBe(401);
    expect(report(await run("clients", "name\nOwnerCo\n", { who: "owner", dryRun: true })).created).toBe(1);
  });
  it("type inconnu : 404 ; corps ou paramètre invalide : 400", async () => {
    expect(err(await run("allocations", "name\nA\n"))).toMatchObject({ code: "NOT_FOUND", params: { entity: "route" } });
    expect(err(await run("people", "", { raw: JSON.stringify({ csv: "" }) }))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "csv" } });
    const bad = await dispatch(deps, { method: "POST", url: "/api/v1/imports/people?dryRun=oui", headers: { authorization: "admin" }, body: JSON.stringify({ csv: "a" }) });
    expect(err(bad)).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "dryRun" } });
  });
  it(`plus de ${IMPORT_MAX_ROWS} lignes : 413 IMPORT_TOO_LARGE, rien n'est lu en base`, async () => {
    const csv = `name\n${Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `c${i}`).join("\n")}`;
    const r = await run("clients", csv, { dryRun: true });
    expect(r.status).toBe(413);
    expect(err(r)).toMatchObject({ code: "IMPORT_TOO_LARGE", params: { maxRows: IMPORT_MAX_ROWS, rows: IMPORT_MAX_ROWS + 1 } });
  });
  it("isolation : l'import d'un autre compte ne voit ni ne touche le compte A", async () => {
    const r = report(await run("clients", "name\nAcme\n", { who: "other" }));
    expect(r.created).toBe(1);
    expect(await n("SELECT count(*) AS n FROM clients WHERE account_id = 1 AND lower(name) = 'acme'")).toBe(1);
  });
});
