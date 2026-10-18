// Écriture des allocations contre schema.sql réel (PGlite) : contrat, verrou optimiste, rôles, isolation, BR-01/BR-04, audit.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ScheduleAllocation, ScheduleResponse } from "@wnext/contracts";
import { createAllocation, deleteAllocation, dispatch, updateAllocation, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-01 @BR-04 @BR-14 @BR-24 @BR-33 @BR-36
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
  dispatch(deps, {
    method, url,
    headers: { authorization: who, ...(opts.ifMatch !== undefined && { "if-match": opts.ifMatch }) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
const create = (body: Record<string, unknown>, who = "admin") => send(who, "POST", "/api/v1/allocations", { body });
const base = { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-06", load: { mode: "hours", hoursPerDay: 6 } };
const made = async (extra: Record<string, unknown> = {}) => (await create({ ...base, ...extra })).body as any;
const patch = (id: string, v: number | string, body: unknown, who = "admin") =>
  send(who, "PATCH", `/api/v1/allocations/${id}`, { body, ifMatch: typeof v === "number" ? `"${v}"` : v });
const del = (id: string, v: number | string, who = "admin") => send(who, "DELETE", `/api/v1/allocations/${id}`, { ifMatch: typeof v === "number" ? `"${v}"` : v });
const count = async () => Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM allocations")).rows[0]!.n);
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (1, 'Bob'), (2, 'Intrus');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1'), (1, 'P2'), (2, 'Secret');
    INSERT INTO phases (account_id, project_id, name) VALUES (1, 1, 'Phase de P1'), (1, 2, 'Phase de P2');
    INSERT INTO project_tasks (account_id, project_id, name) VALUES (1, 1, 'Tâche de P1');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
    INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date, approval_status) VALUES (1, 1, 1, '2026-03-03', '2026-03-03', 'approved');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("POST /allocations", () => {
  it("201 : valide le contrat, défauts appliqués, version 1", async () => {
    const r = await create(base);
    expect(r.status).toBe(201);
    expect(ScheduleAllocation.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ version: 1, status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 6, percent: null, phaseId: null });
  });

  it("mode pourcentage : 150 % accepté, hoursPerDay absent", async () => {
    const b = await made({ load: { mode: "percentage", percent: 150 } });
    expect(b).toMatchObject({ mode: "percentage", percent: 150, hoursPerDay: null });
  });

  it("n'applique AUCUNE règle de capacité : 3 x 8 h le même jour, et un jour de congé (BR-01, BR-04)", async () => {
    for (let i = 0; i < 3; i++) expect((await create({ ...base, personId: "2", load: { mode: "hours", hoursPerDay: 8 } })).status).toBe(201);
    expect((await create({ ...base, startDate: "2026-03-03", endDate: "2026-03-03" })).status).toBe(201); // Alice est en congé ce jour-là
  });

  it("la création apparaît dans GET /schedule avec la même version", async () => {
    const a = await made({ name: "visible", startDate: "2026-06-01", endDate: "2026-06-02" });
    const s = await send("admin", "GET", "/api/v1/schedule?from=2026-06-01&to=2026-06-05");
    const parsed = ScheduleResponse.parse(s.body);
    expect(parsed.allocations.find((x) => x.id === a.id)).toEqual(a);
  });

  it("phase et tâche du projet : acceptées ; 404 si elles appartiennent à un autre projet", async () => {
    expect((await create({ ...base, phaseId: "1", taskId: "1" })).status).toBe(201);
    expect(err(await create({ ...base, phaseId: "2" }))).toEqual({ code: "NOT_FOUND", params: { entity: "phase" }, requestId: "r" });
  });

  it.each([
    ["personne inconnue", { personId: "999" }, "person"],
    ["personne d'un autre compte", { personId: "3" }, "person"],
    ["projet d'un autre compte", { projectId: "3" }, "project"],
    ["identifiant non numérique", { personId: "1; DROP TABLE allocations" }, "person"],
  ])("404 NOT_FOUND : %s", async (_n, over, entity) => {
    const before = await count();
    const r = await create({ ...base, ...over });
    expect(r.status).toBe(404);
    expect(err(r).params).toEqual({ entity });
    expect(await count()).toBe(before);
  });

  it.each([
    ["corps non JSON", { raw: "{pas du json" }, "body"],
    ["corps vide", {}, "body"],
    ["mode sans sa valeur", { body: { ...base, load: { mode: "hours" } } }, "load"],
    ["fin avant début", { body: { ...base, startDate: "2026-03-09" } }, "endDate"],
    ["champ obligatoire absent", { body: { ...base, projectId: undefined } }, "projectId"],
  ])("400 VALIDATION_FAILED : %s", async (_n, opts, field) => {
    const r = await send("admin", "POST", "/api/v1/allocations", opts as never);
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
    expect(ApiError.safeParse(r.body).success).toBe(true);
  });

  it("401 anonyme ; 403 member et guest sans rien écrire ; owner/admin/project_manager autorisés", async () => {
    const before = await count();
    expect((await create(base, "anon")).status).toBe(401);
    for (const who of ["member", "guest"]) {
      const r = await create(base, who);
      expect(r.status).toBe(403);
      expect(err(r).code).toBe("FORBIDDEN");
    }
    expect(await count()).toBe(before);
    expect((await create(base, "pm")).status).toBe(201);
  });

  it("le 403 passe avant la validation (un lecteur ne sonde pas le schéma)", async () => {
    expect((await send("member", "POST", "/api/v1/allocations", { raw: "pas du json" })).status).toBe(403);
  });

  it("audit : created_by / modified_by viennent du contexte, pas du client", async () => {
    const a = await made();
    const row = (await pg.query<{ created_by: string }>("SELECT created_by FROM allocations WHERE id = $1", [a.id])).rows[0]!;
    expect(String(row.created_by)).toBe("1");
  });
});

describe("PATCH /allocations/{id}", () => {
  it("200 : version +1, champs non précisés inchangés", async () => {
    const a = await made({ name: "avant", notes: "n" });
    const r = await patch(a.id, a.version, { name: "après" });
    expect(r.status).toBe(200);
    expect(ScheduleAllocation.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({ ...a, name: "après", version: a.version + 1 });
  });

  it("déplacement vers une autre personne et d'autres dates", async () => {
    const a = await made();
    const r = (await patch(a.id, a.version, { personId: "2", startDate: "2026-03-09", endDate: "2026-03-10" })).body as any;
    expect(r).toMatchObject({ personId: "2", startDate: "2026-03-09", endDate: "2026-03-10", version: 2 });
  });

  it("changement de mode : l'ancienne valeur est effacée (le CHECK de mode reste satisfait)", async () => {
    const a = await made();
    const toPct = (await patch(a.id, a.version, { load: { mode: "percentage", percent: 50 } })).body as any;
    expect(toPct).toMatchObject({ mode: "percentage", percent: 50, hoursPerDay: null });
    const back = (await patch(a.id, toPct.version, { load: { mode: "hours", hoursPerDay: 3 } })).body as any;
    expect(back).toMatchObject({ mode: "hours", hoursPerDay: 3, percent: null });
  });

  it("changer de projet remet phase et tâche à zéro, sauf si précisées", async () => {
    const a = await made({ phaseId: "1", taskId: "1" });
    const moved = (await patch(a.id, a.version, { projectId: "2" })).body as any;
    expect(moved).toMatchObject({ projectId: "2", phaseId: null, taskId: null });
    const withPhase = (await patch(a.id, moved.version, { projectId: "1", phaseId: "1" })).body as any;
    expect(withPhase).toMatchObject({ projectId: "1", phaseId: "1" });
  });

  it("série : « none » efface la fin automatiquement ; fin de série incohérente refusée", async () => {
    const a = await made({ repeatState: "weekly", repeatEndDate: "2026-04-30" });
    expect(err(await patch(a.id, a.version, { repeatEndDate: "2026-03-01" })).params).toEqual({ field: "repeatEndDate" });
    const none = (await patch(a.id, a.version, { repeatState: "none" })).body as any;
    expect(none).toMatchObject({ repeatState: "none", repeatEndDate: null });
    expect(err(await patch(a.id, none.version, { repeatEndDate: "2026-05-01" })).params).toEqual({ field: "repeatEndDate" });
  });

  it("fin avant début après fusion avec l'état courant : 400, rien n'est modifié", async () => {
    const a = await made();
    const r = await patch(a.id, a.version, { endDate: "2026-03-01" });
    expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "endDate" } });
    const after = await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06");
    expect((after.body as any).allocations.find((x: any) => x.id === a.id).version).toBe(a.version);
  });

  it("409 sur version périmée avec currentVersion ; la ligne n'est pas modifiée", async () => {
    const a = await made({ name: "v1" });
    const first = (await patch(a.id, a.version, { name: "v2" })).body as any;
    const stale = await patch(a.id, a.version, { name: "perdu" });
    expect(stale.status).toBe(409);
    expect(err(stale)).toEqual({ code: "VERSION_CONFLICT", params: { currentVersion: first.version }, requestId: "r" });
    expect((await pg.query<{ name: string }>("SELECT name FROM allocations WHERE id = $1", [a.id])).rows[0]!.name).toBe("v2");
    expect((await patch(a.id, first.version, { name: "v3" })).status).toBe(200); // après rechargement, on rejoue
  });

  it("deux écritures concurrentes sur la même version : une seule réussit", async () => {
    const a = await made();
    const [x, y] = await Promise.all([patch(a.id, a.version, { name: "x" }), patch(a.id, a.version, { name: "y" })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });

  it("428 sans If-Match ; 400 si mal formé", async () => {
    const a = await made();
    expect((await send("admin", "PATCH", `/api/v1/allocations/${a.id}`, { body: { name: "x" } })).status).toBe(428);
    for (const bad of ["1", '"x"', 'W/"1"']) {
      const r = await patch(a.id, bad, { name: "x" });
      expect(r.status).toBe(400);
      expect(err(r).params).toEqual({ field: "If-Match" });
    }
  });

  it("404 : allocation inconnue, id non numérique, allocation d'un autre compte (jamais 409 ni 403)", async () => {
    const a = await made();
    expect((await patch("99999", 1, { name: "x" })).status).toBe(404);
    expect((await patch("abc", 1, { name: "x" })).status).toBe(404);
    const foreign = await patch(a.id, a.version, { name: "x" }, "other");
    expect(foreign.status).toBe(404);
    expect((await patch(a.id, 999, { name: "x" }, "other")).status).toBe(404);
  });

  it("404 si la nouvelle personne ou le nouveau projet est inconnu ; 403 member ; 401 anonyme ; corps vide 400", async () => {
    const a = await made();
    expect(err(await patch(a.id, a.version, { personId: "3" })).params).toEqual({ entity: "person" });
    expect((await patch(a.id, a.version, { name: "x" }, "member")).status).toBe(403);
    expect((await patch(a.id, a.version, { name: "x" }, "anon")).status).toBe(401);
    expect(err(await patch(a.id, a.version, {})).params).toEqual({ field: "body" });
  });

  it("audit : modified_by est posé par le contexte", async () => {
    const a = await made();
    await patch(a.id, a.version, { name: "m" });
    expect(String((await pg.query<{ modified_by: string }>("SELECT modified_by FROM allocations WHERE id = $1", [a.id])).rows[0]!.modified_by)).toBe("1");
  });
});

describe("DELETE /allocations/{id}", () => {
  it("204 sans corps, supprime, journalise dans delete_log (BR-14)", async () => {
    const a = await made();
    const r = await del(a.id, a.version);
    expect(r).toEqual({ status: 204, body: undefined });
    expect((await pg.query("SELECT 1 FROM allocations WHERE id = $1", [a.id])).rows).toHaveLength(0);
    const log = (await pg.query<{ entity: string; deleted_by: string }>("SELECT entity, deleted_by FROM delete_log WHERE entity = 'allocations' AND entity_id = $1", [a.id])).rows;
    expect(log).toHaveLength(1);
    expect(String(log[0]!.deleted_by)).toBe("1");
    expect((await del(a.id, a.version)).status).toBe(404);
  });

  it("409 sur version périmée : rien n'est supprimé", async () => {
    const a = await made();
    const up = (await patch(a.id, a.version, { name: "x" })).body as any;
    const r = await del(a.id, a.version);
    expect(r.status).toBe(409);
    expect(err(r).params).toEqual({ currentVersion: up.version });
    expect((await pg.query("SELECT 1 FROM allocations WHERE id = $1", [a.id])).rows).toHaveLength(1);
  });

  it("428, 400, 403, 401 et isolation entre comptes", async () => {
    const a = await made();
    expect((await send("admin", "DELETE", `/api/v1/allocations/${a.id}`)).status).toBe(428);
    expect((await del(a.id, "1")).status).toBe(400);
    expect((await del(a.id, a.version, "member")).status).toBe(403);
    expect((await del(a.id, a.version, "anon")).status).toBe(401);
    expect((await del(a.id, a.version, "other")).status).toBe(404);
    expect((await pg.query("SELECT 1 FROM allocations WHERE id = $1", [a.id])).rows).toHaveLength(1);
  });
});

describe("rôles au niveau du domaine (indépendamment de la couche HTTP)", () => {
  it("les trois opérations refusent member et guest même appelées directement", async () => {
    const a = await made();
    for (const ctx of [roles.member!, roles.guest!]) {
      await expect(createAllocation(db, ctx, base as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(updateAllocation(db, ctx, a.id, a.version, { name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(deleteAllocation(db, ctx, a.id, a.version)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

describe("routage", () => {
  it("méthodes non prévues : 404 au format ApiError", async () => {
    for (const [m, u] of [["GET", "/api/v1/allocations"], ["PUT", "/api/v1/allocations/1"], ["POST", "/api/v1/allocations/1"], ["PATCH", "/api/v1/allocations"]] as const) {
      const r = await send("admin", m, u);
      expect(r.status).toBe(404);
      expect(ApiError.safeParse(r.body).success).toBe(true);
    }
  });
});
