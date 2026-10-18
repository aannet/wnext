// Écriture des entités de référence contre schema.sql réel (PGlite) : départements, rôles, types de congé, fériés, projets.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectDetail, ScheduleDepartment, ScheduleHoliday, ScheduleRole, ScheduleTimeoffType } from "@wnext/contracts";
import { createDepartment, dispatch, readChanges, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-14
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
const send = (who: string, method: string, url: string, body?: unknown, version?: number | string) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(version === undefined ? {} : { "if-match": `"${version}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
const body = <T>(r: { body: unknown }) => r.body as T;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (2,'intrus');
    INSERT INTO departments (account_id, name) VALUES (2, 'Autre compte');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

// Les quatre entités de configuration partagent la même mécanique.
const configs = [
  { path: "departments", schema: ScheduleDepartment, create: { name: "Design" }, patch: { name: "Design 2" }, other: { name: "Dev" } },
  { path: "roles", schema: ScheduleRole, create: { name: "Senior" }, patch: { name: "Lead" }, other: { name: "Junior" } },
  { path: "timeoff-types", schema: ScheduleTimeoffType, create: { name: "Vacances" }, patch: { name: "Congés", deducted: false }, other: { name: "Maladie" } },
  { path: "holidays", schema: ScheduleHoliday, create: { name: "Noël", date: "2026-12-25" }, patch: { name: "Noël 2", hoursOff: 4 }, other: { name: "Pâques", date: "2026-04-06" } },
] as const;

describe.each(configs)("/api/v1/$path", ({ path, schema, create, patch, other }) => {
  const url = `/api/v1/${path}`;
  let id = "";
  let version = 0;

  it("crée (201), forme du contrat, version 1", async () => {
    const r = await send("admin", "POST", url, create);
    expect(r.status).toBe(201);
    expect(schema.safeParse(r.body).success).toBe(true);
    ({ id, version } = body<{ id: string; version: number }>(r));
    expect(version).toBe(1);
  });

  it("refuse un doublon (ALREADY_EXISTS) à la création, sans rien écrire de plus", async () => {
    const r = await send("owner", "POST", url, create);
    expect(r.status).toBe(409);
    expect(err(r).code).toBe("ALREADY_EXISTS");
    expect(err(r).params.entity).toBeTypeOf("string");
  });

  it("modifie avec If-Match (version +1), les champs absents sont inchangés", async () => {
    const r = await send("admin", "PATCH", `${url}/${id}`, patch, version);
    expect(r.status).toBe(200);
    expect(schema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ id, version: 2, ...(patch as object) });
    version = 2;
  });

  it("version périmée : 409 VERSION_CONFLICT avec la version courante, rien n'est écrit", async () => {
    const r = await send("admin", "PATCH", `${url}/${id}`, patch, 1);
    expect(err(r)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
    expect((await send("admin", "DELETE", `${url}/${id}`, undefined, 1)).status).toBe(409);
  });

  it("If-Match absent : 428 ; mal formé : 400 ; corps vide : 400", async () => {
    expect((await send("admin", "PATCH", `${url}/${id}`, patch)).status).toBe(428);
    expect((await send("admin", "DELETE", `${url}/${id}`)).status).toBe(428);
    expect((await send("admin", "PATCH", `${url}/${id}`, patch, "abc")).status).toBe(400);
    expect((await send("admin", "PATCH", `${url}/${id}`, {}, version)).status).toBe(400);
    expect((await send("admin", "POST", url, {})).status).toBe(400);
  });

  it("renommer vers un nom pris : 409 ALREADY_EXISTS ; garder son propre nom est permis", async () => {
    const o = body<{ id: string; version: number }>(await send("admin", "POST", url, other));
    const clash = await send("admin", "PATCH", `${url}/${o.id}`, "date" in create ? { name: patch.name, date: create.date } : { name: (patch as any).name }, o.version);
    expect(err(clash).code).toBe("ALREADY_EXISTS");
    const same = await send("admin", "PATCH", `${url}/${o.id}`, { name: other.name }, o.version);
    expect(same.status).toBe(200);
    expect(await send("admin", "DELETE", `${url}/${o.id}`, undefined, (same.body as any).version)).toMatchObject({ status: 204 });
  });

  it("droits : anonyme 401 ; project_manager et membre 403 même avec un corps invalide ; aucune écriture", async () => {
    const before = await n(`SELECT count(*) AS n FROM ${path.replace("-", "_")}`);
    expect((await send("anon", "POST", url, create)).status).toBe(401);
    for (const who of ["pm", "member"]) {
      for (const [m, u, b, v] of [["POST", url, {}, undefined], ["PATCH", `${url}/${id}`, {}, version], ["DELETE", `${url}/${id}`, undefined, version]] as const) {
        const r = await send(who, m, u, b, v);
        expect(r.status, `${who} ${m}`).toBe(403);
        expect(err(r)).toMatchObject({ code: "FORBIDDEN", params: { role: who === "pm" ? "project_manager" : "member" } });
      }
    }
    expect(await n(`SELECT count(*) AS n FROM ${path.replace("-", "_")}`)).toBe(before);
  });

  it("isolation : un autre compte ne voit ni ne modifie cette ligne (404), et ne la supprime pas", async () => {
    expect((await send("other", "PATCH", `${url}/${id}`, patch, version)).status).toBe(404);
    expect((await send("other", "DELETE", `${url}/${id}`, undefined, version)).status).toBe(404);
    expect(err(await send("admin", "PATCH", `${url}/99999`, patch, 1)).params).toEqual({ entity: expect.any(String) });
    expect(err(await send("admin", "PATCH", `${url}/abc`, patch, 1)).code).toBe("NOT_FOUND");
  });

  it("supprime (204) avec la bonne version ; la ligne disparaît et la suppression est journalisée (BR-14)", async () => {
    const table = path.replace("-", "_");
    const logged = await n(`SELECT count(*) AS n FROM delete_log WHERE entity = '${table}'`);
    expect((await send("admin", "DELETE", `${url}/${id}`, undefined, version)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM ${table} WHERE id = ${id}`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = '${table}'`)).toBe(logged + 1);
    expect((await send("admin", "DELETE", `${url}/${id}`, undefined, version)).status).toBe(404); // rejouer
  });
});

describe("suppression refusée tant que l'entité est référencée (aucune cascade silencieuse)", () => {
  it("département : personnes et fériés liés comptés, rien n'est supprimé ni détaché", async () => {
    const d = body<{ id: string; version: number }>(await send("admin", "POST", "/api/v1/departments", { name: "Ops" }));
    await pg.exec(`UPDATE people SET department_id = ${d.id} WHERE name = 'hal'; INSERT INTO holidays (account_id, name, hdate, department_id) VALUES (1, 'Ops day', '2026-05-01', ${d.id}), (1, 'Ops day 2', '2026-05-02', ${d.id})`);
    const r = await send("admin", "DELETE", `/api/v1/departments/${d.id}`, undefined, 1);
    expect(r.status).toBe(409);
    expect(err(r)).toEqual({ code: "REFERENCE_IN_USE", params: { entity: "department", people: 1, holidays: 2 }, requestId: "r" });
    expect(await n(`SELECT count(*) AS n FROM holidays WHERE department_id = ${d.id}`)).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM people WHERE department_id = ${d.id}`)).toBe(1);
    await pg.exec(`UPDATE people SET department_id = NULL; DELETE FROM holidays WHERE department_id = ${d.id}`);
    expect((await send("admin", "DELETE", `/api/v1/departments/${d.id}`, undefined, 1)).status).toBe(204);
  });

  it("rôle : personnes et tarifs liés", async () => {
    const r0 = body<{ id: string }>(await send("admin", "POST", "/api/v1/roles", { name: "Archi" }));
    await pg.exec(`UPDATE people SET role_id = ${r0.id} WHERE name = 'hal'; INSERT INTO rate_cards (account_id, name, valid_from) VALUES (1, 'std', '2026-01-01'); INSERT INTO rates (account_id, rate_card_id, role_id, cost_rate, bill_rate) VALUES (1, 1, ${r0.id}, 50, 100)`);
    const r = await send("admin", "DELETE", `/api/v1/roles/${r0.id}`, undefined, 1);
    expect(err(r)).toMatchObject({ code: "REFERENCE_IN_USE", params: { entity: "role", people: 1, rates: 1 } });
    expect(await n("SELECT count(*) AS n FROM rates")).toBe(1);
    await pg.exec(`UPDATE people SET role_id = NULL; DELETE FROM rates`);
    expect((await send("admin", "DELETE", `/api/v1/roles/${r0.id}`, undefined, 1)).status).toBe(204);
  });

  it("type de congé : congés liés (la base le refuserait aussi, ici avec un code stable)", async () => {
    const t = body<{ id: string }>(await send("admin", "POST", "/api/v1/timeoff-types", { name: "Sabbatique" }));
    await pg.exec(`INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (1, 1, ${t.id}, '2026-08-01', '2026-08-02')`);
    const r = await send("admin", "DELETE", `/api/v1/timeoff-types/${t.id}`, undefined, 1);
    expect(err(r)).toMatchObject({ code: "REFERENCE_IN_USE", params: { entity: "timeoff_type", timeoffs: 1 } });
    await pg.exec(`DELETE FROM timeoffs`);
    expect((await send("admin", "DELETE", `/api/v1/timeoff-types/${t.id}`, undefined, 1)).status).toBe(204);
  });
});

describe("jours fériés", () => {
  it("département inconnu ou d'un autre compte : 404 department, rien n'est écrit", async () => {
    const other = await n("SELECT id AS n FROM departments WHERE name = 'Autre compte'");
    for (const departmentId of ["99999", String(other), "abc"]) {
      const r = await send("admin", "POST", "/api/v1/holidays", { name: "X", date: "2026-01-01", departmentId });
      expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity: "department" } });
    }
    expect(await n("SELECT count(*) AS n FROM holidays WHERE name = 'X'")).toBe(0);
  });

  it("champs optionnels : pays, heures et département se posent et s'effacent (null)", async () => {
    const d = body<{ id: string }>(await send("admin", "POST", "/api/v1/departments", { name: "Féries" }));
    const h = body<any>(await send("admin", "POST", "/api/v1/holidays", { name: "Fête", date: "2026-07-14", country: "FR", departmentId: d.id, hoursOff: 3.5 }));
    expect(h).toMatchObject({ date: "2026-07-14", country: "FR", departmentId: d.id, hoursOff: 3.5 });
    const cleared = body<any>(await send("admin", "PATCH", `/api/v1/holidays/${h.id}`, { country: null, departmentId: null, hoursOff: null, date: "2026-07-15" }, 1));
    expect(cleared).toMatchObject({ date: "2026-07-15", country: null, departmentId: null, hoursOff: null, name: "Fête", version: 2 });
    expect((await send("admin", "PATCH", `/api/v1/holidays/${h.id}`, { departmentId: "99999" }, 2)).status).toBe(404);
  });

  it("même jour, pays, département et nom (valeurs nulles comprises) : ALREADY_EXISTS", async () => {
    await send("admin", "POST", "/api/v1/holidays", { name: "Doublon", date: "2026-09-01" });
    expect(err(await send("admin", "POST", "/api/v1/holidays", { name: "Doublon", date: "2026-09-01" })).code).toBe("ALREADY_EXISTS");
    expect((await send("admin", "POST", "/api/v1/holidays", { name: "Doublon", date: "2026-09-01", country: "FR" })).status).toBe(201);
  });
});

describe("/api/v1/projects", () => {
  let id = "";
  it("crée avec les défauts serveur, project_manager autorisé", async () => {
    const r = await send("pm", "POST", "/api/v1/projects", { name: "Site web" });
    expect(r.status).toBe(201);
    expect(ProjectDetail.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ version: 1, name: "Site web", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null, projectManagerId: null, tags: [], notes: null });
    id = body<{ id: string }>(r).id;
  });

  it("membre : 403 ; anonyme : 401", async () => {
    expect((await send("member", "POST", "/api/v1/projects", { name: "x" })).status).toBe(403);
    expect((await send("member", "PATCH", `/api/v1/projects/${id}`, {}, 1)).status).toBe(403);
    expect((await send("anon", "POST", "/api/v1/projects", { name: "x" })).status).toBe(401);
  });

  it("code projet unique dans le compte (field = projectCode) mais libre d'un compte à l'autre", async () => {
    expect((await send("admin", "POST", "/api/v1/projects", { name: "A", projectCode: "J-1" })).status).toBe(201);
    const dup = await send("admin", "POST", "/api/v1/projects", { name: "B", projectCode: "J-1" });
    expect(err(dup)).toMatchObject({ code: "ALREADY_EXISTS", params: { entity: "project", field: "projectCode" } });
    expect((await send("other", "POST", "/api/v1/projects", { name: "C", projectCode: "J-1" })).status).toBe(201);
    const p = body<any>(await send("admin", "POST", "/api/v1/projects", { name: "D" }));
    expect(err(await send("admin", "PATCH", `/api/v1/projects/${p.id}`, { projectCode: "J-1" }, 1)).code).toBe("ALREADY_EXISTS");
  });

  it("modifie, archive (statut), efface un champ (null) ; cohérence des dates sur l'état résultant", async () => {
    const r = await send("admin", "PATCH", `/api/v1/projects/${id}`, { status: "archived", color: "#112233", startDate: "2026-03-01", endDate: "2026-03-31", tags: ["web"], notes: "n" }, 1);
    expect(r.body).toMatchObject({ version: 2, status: "archived", color: "#112233", startDate: "2026-03-01", endDate: "2026-03-31", tags: ["web"], notes: "n" });
    const bad = await send("admin", "PATCH", `/api/v1/projects/${id}`, { endDate: "2026-02-01" }, 2); // fin avant le début déjà posé
    expect(err(bad)).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "endDate" } });
    const cleared = await send("admin", "PATCH", `/api/v1/projects/${id}`, { endDate: null, notes: null }, 2);
    expect(cleared.body).toMatchObject({ version: 3, endDate: null, notes: null, startDate: "2026-03-01" });
    expect(err(await send("admin", "PATCH", `/api/v1/projects/${id}`, {}, 3)).code).toBe("VALIDATION_FAILED");
  });

  it("chef de projet : une personne du compte, sinon 404 person", async () => {
    const hal = await n("SELECT id AS n FROM people WHERE name = 'hal'");
    const ok = await send("admin", "POST", "/api/v1/projects", { name: "Avec chef", projectManagerId: String(hal) });
    expect(ok.body).toMatchObject({ projectManagerId: String(hal) });
    const intrus = await n("SELECT id AS n FROM people WHERE name = 'intrus'");
    for (const projectManagerId of [String(intrus), "99999"]) {
      expect(err(await send("admin", "POST", "/api/v1/projects", { name: "Z", projectManagerId })).params).toEqual({ entity: "person" });
    }
    expect(err(await send("admin", "PATCH", `/api/v1/projects/${id}`, { projectManagerId: String(intrus) }, 3)).code).toBe("NOT_FOUND");
  });

  it("version périmée 409 ; 428 sans If-Match ; pas de DELETE (route inconnue) ; autre compte 404", async () => {
    expect(err(await send("admin", "PATCH", `/api/v1/projects/${id}`, { name: "n" }, 1))).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 3 } });
    expect((await send("admin", "PATCH", `/api/v1/projects/${id}`, { name: "n" })).status).toBe(428);
    const del = await send("admin", "DELETE", `/api/v1/projects/${id}`, undefined, 3);
    expect(err(del)).toMatchObject({ code: "NOT_FOUND", params: { entity: "route" } });
    expect(await n(`SELECT count(*) AS n FROM projects WHERE id = ${id}`)).toBe(1);
    expect((await send("other", "PATCH", `/api/v1/projects/${id}`, { name: "n" }, 3)).status).toBe(404);
  });
});

describe("journal de changements et lecture", () => {
  it("une création de département apparaît dans le journal ; le Schedule expose la version à jour", async () => {
    const ctx = roles.admin!;
    const before = await readChanges(db, ctx, 0, 1);
    const head = Number(before.head);
    const d = body<{ id: string }>(await send("admin", "POST", "/api/v1/departments", { name: "Journal" }));
    await send("admin", "PATCH", `/api/v1/departments/${d.id}`, { name: "Journal 2" }, 1);
    const ch = await readChanges(db, ctx, head, 100);
    expect(ch.status === "ok" && ch.changes.map((c) => [c.entity, c.id, c.op, c.version])).toEqual([["departments", d.id, "insert", 1], ["departments", d.id, "update", 2]]);
    const s = await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-08");
    expect((s.body as any).departments.find((x: any) => x.id === d.id)).toEqual({ id: d.id, version: 2, name: "Journal 2" });
  });

  it("l'API du domaine refuse aussi un rôle insuffisant (défense en profondeur)", async () => {
    await expect(createDepartment(db, roles.pm!, { name: "Interdit" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
