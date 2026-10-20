// Clients, phases et tâches de projet contre schema.sql réel (PGlite) : écriture, lecture, rôles, isolation, suppression refusée si référencée.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { Client, ClientList, Phase, PhaseList, ProjectTask, ProjectTaskList } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createClient, createPhase, createProjectTask, deleteClient, deletePhase, deleteProjectTask, dispatch, updateClient, updatePhase, updateProjectTask, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-14
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "1", role: "admin" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  guest: { accountId: "1", userId: "1", role: "guest" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, version?: number | string) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(version === undefined ? {} : { "if-match": `"${version}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const body = <T>(r: { body: unknown }) => r.body as T;
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (2,'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P1'), (1,'P2'), (2,'Q');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
    INSERT INTO clients (account_id, name) VALUES (2, 'Client étranger');
    INSERT INTO phases (account_id, project_id, name) VALUES (2, 3, 'Phase étrangère');
    INSERT INTO project_tasks (account_id, project_id, name) VALUES (2, 3, 'Tâche étrangère');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

const matrix = (url: string, create: unknown) => {
  it("rôles : owner, admin et project_manager écrivent ; member et guest non (403) ; anonyme 401 ; tous les membres lisent", async () => {
    for (const who of ["owner", "admin", "pm"]) expect((await send(who, "POST", url, create)).status).toBe(201);
    for (const who of ["member", "guest"]) {
      const r = await send(who, "POST", url, create);
      expect(r.status).toBe(403);
      expect(err(r).code).toBe("FORBIDDEN");
      expect((await send(who, "GET", url)).status).toBe(200);
    }
    expect((await send("anon", "POST", url, create)).status).toBe(401);
    expect((await send("anon", "GET", url)).status).toBe(401);
  });
};

describe("/api/v1/clients", () => {
  const url = "/api/v1/clients";
  let id = "";
  let version = 0;

  matrix(url, { name: "Rôles" });

  it("crée (201), forme du contrat, version 1 ; valeurs par défaut", async () => {
    const r = await send("pm", "POST", url, { name: "ACME" });
    expect(r.status).toBe(201);
    expect(Client.parse(r.body)).toMatchObject({ name: "ACME", shortName: null, tags: [], version: 1 });
    ({ id, version } = body<{ id: string; version: number }>(r));
  });
  it("accepte des homonymes (aucune unicité sur le nom)", async () => expect((await send("pm", "POST", url, { name: "ACME" })).status).toBe(201));
  it("refuse un corps invalide (400, champ)", async () => {
    for (const b of [{}, { name: " " }, { name: "A", tags: [""] }]) expect((await send("pm", "POST", url, b)).status).toBe(400);
  });
  it("modifie avec If-Match : les champs absents sont inchangés, null efface le nom court", async () => {
    let r = await send("pm", "PATCH", `${url}/${id}`, { shortName: "AC", tags: ["vip"] }, version);
    expect(r.body).toMatchObject({ id, version: 2, name: "ACME", shortName: "AC", tags: ["vip"] });
    r = await send("pm", "PATCH", `${url}/${id}`, { shortName: null }, 2);
    expect(r.body).toMatchObject({ version: 3, name: "ACME", shortName: null, tags: ["vip"] });
    version = 3;
  });
  it("version périmée : 409 avec la version courante ; If-Match absent : 428 ; rôle insuffisant : 403", async () => {
    let r = await send("pm", "PATCH", `${url}/${id}`, { name: "X" }, 1);
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 3 } });
    expect((await send("pm", "PATCH", `${url}/${id}`, { name: "X" })).status).toBe(428);
    r = await send("member", "PATCH", `${url}/${id}`, { name: "X" }, version);
    expect(r.status).toBe(403);
    expect((await send("pm", "PATCH", `${url}/${id}`, {}, version)).status).toBe(400);
  });
  it("un autre compte ne voit ni ne modifie : 404", async () => {
    const foreign = String((await pg.query<{ id: string }>("SELECT id FROM clients WHERE account_id = 2")).rows[0]!.id);
    for (const [m, u, b] of [["GET", `${url}/${foreign}`], ["PATCH", `${url}/${foreign}`, { name: "x" }], ["DELETE", `${url}/${foreign}`]] as const) {
      const r = await send("admin", m, u, b, 1);
      expect(r.status, `${m}`).toBe(404);
      expect(err(r).params.entity).toBe("client");
    }
    expect((await send("other", "GET", `${url}/${id}`)).status).toBe(404);
  });
  it("liste paginée, isolée par compte", async () => {
    const all = body<{ items: { name: string }[]; page: { total: number } }>(await send("member", "GET", url));
    expect(ClientList.safeParse(all).success).toBe(true);
    expect(all.items.some((c) => c.name === "Client étranger")).toBe(false);
    const p1 = body<{ items: { id: string }[]; page: { nextCursor: string; total: number } }>(await send("member", "GET", `${url}?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.page.total).toBe(all.page.total);
    const p2 = body<{ items: { id: string }[] }>(await send("member", "GET", `${url}?limit=2&cursor=${p1.page.nextCursor}`));
    expect(new Set([...p1.items, ...p2.items].map((c) => c.id)).size).toBe(4);
    expect((await send("member", "GET", `${url}?foo=1`)).status).toBe(400);
    expect(err(await send("member", "GET", `${url}?cursor=zz`)).code).toBe("SCHEDULE_CURSOR_INVALID");
  });
  it("suppression refusée tant qu'un projet y renvoie ; puis supprimée et journalisée (BR-14)", async () => {
    await pg.exec(`UPDATE projects SET client_id = ${id} WHERE id = 1`);
    const r = await send("pm", "DELETE", `${url}/${id}`, undefined, version);
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "REFERENCE_IN_USE", params: { entity: "client", projects: 1 } });
    expect(await n(`SELECT count(*) AS n FROM clients WHERE id = ${id}`)).toBe(1);
    await pg.exec("UPDATE projects SET client_id = NULL WHERE id = 1");
    expect((await send("member", "DELETE", `${url}/${id}`, undefined, version)).status).toBe(403);
    expect((await send("pm", "DELETE", `${url}/${id}`, undefined, version - 1)).status).toBe(409);
    expect((await send("pm", "DELETE", `${url}/${id}`, undefined, version)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = 'clients' AND entity_id = ${id}`)).toBe(1);
    expect((await send("pm", "GET", `${url}/${id}`)).status).toBe(404);
  });
});

describe("/api/v1/phases", () => {
  const url = "/api/v1/phases";

  matrix(url, { projectId: "2", name: "Rôles" });

  it("crée (201), forme du contrat ; position par défaut = dernière + 1 par projet", async () => {
    const a = await send("pm", "POST", url, { projectId: "1", name: "Cadrage" });
    expect(a.status).toBe(201);
    const phase = Phase.parse(a.body);
    expect(phase).toMatchObject({ projectId: "1", status: "planned", color: null, nonBillable: false, notes: null, startDate: null, endDate: null, version: 1 });
    const b = Phase.parse((await send("pm", "POST", url, { projectId: "1", name: "Réalisation" })).body);
    expect(b.position).toBe(phase.position + 1);
    const c = Phase.parse((await send("pm", "POST", url, { projectId: "1", name: "Libre", position: 0 })).body);
    expect(c.position).toBe(0);
    const d = Phase.parse((await send("pm", "POST", url, { projectId: "1", name: "Suite" })).body);
    expect(d.position).toBe(b.position + 1); // calculé sur le maximum, pas sur le nombre
  });
  it("projet inconnu, hors compte ou illisible : 404 entity project", async () => {
    for (const projectId of ["999", "3", "abc"]) {
      const r = await send("pm", "POST", url, { projectId, name: "x" });
      expect(r.status, projectId).toBe(404);
      expect(err(r).params.entity).toBe("project");
    }
    expect(await n("SELECT count(*) AS n FROM phases WHERE name = 'x'")).toBe(0);
  });
  it("corps invalide : dates inversées, statut inconnu, couleur, position hors bornes", async () => {
    for (const b of [
      { startDate: "2026-03-06", endDate: "2026-03-02" }, { status: "active" }, { color: "rouge" }, { position: 40000 }, { position: -1 },
    ]) expect((await send("pm", "POST", url, { projectId: "1", name: "x", ...b })).status, JSON.stringify(b)).toBe(400);
  });
  it("modifie : l'état résultant est vérifié (fin avant le début déjà posé), le projet est immuable", async () => {
    const p = Phase.parse((await send("pm", "POST", url, { projectId: "1", name: "Dates", startDate: "2026-03-10", endDate: "2026-03-20", color: "#112233" })).body);
    let r = await send("pm", "PATCH", `${url}/${p.id}`, { endDate: "2026-03-05" }, 1);
    expect(r.status).toBe(400);
    expect(err(r).params.field).toBe("endDate");
    r = await send("pm", "PATCH", `${url}/${p.id}`, { endDate: "2026-03-25", status: "in_progress", color: null, notes: "n", nonBillable: true, projectId: "2" }, 1);
    expect(r.status).toBe(200);
    expect(Phase.parse(r.body)).toMatchObject({ projectId: "1", version: 2, name: "Dates", startDate: "2026-03-10", endDate: "2026-03-25", status: "in_progress", color: null, notes: "n", nonBillable: true });
    expect((await send("pm", "PATCH", `${url}/${p.id}`, { name: "x" }, 1)).status).toBe(409);
  });
  it("lecture par id, liste filtrée par projet, isolation", async () => {
    const list = body<{ items: { projectId: string }[]; page: { total: number } }>(await send("member", "GET", `${url}?projectId=1`));
    expect(PhaseList.safeParse(list).success).toBe(true);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((x) => x.projectId === "1")).toBe(true);
    expect(list.page.total).toBe(list.items.length);
    const none = body<{ items: unknown[] }>(await send("member", "GET", `${url}?projectId=3`));
    expect(none.items).toEqual([]); // le projet d'un autre compte ne révèle rien
    const r = await send("member", "GET", `${url}?projectId=abc`);
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "projectId" } });
    const foreign = String((await pg.query<{ id: string }>("SELECT id FROM phases WHERE account_id = 2")).rows[0]!.id);
    expect((await send("admin", "GET", `${url}/${foreign}`)).status).toBe(404);
    expect((await send("admin", "DELETE", `${url}/${foreign}`, undefined, 1)).status).toBe(404);
  });
  it("suppression refusée tant que tâches, allocations, temps saisis ou jalons y renvoient ; puis possible", async () => {
    const p = Phase.parse((await send("pm", "POST", url, { projectId: "2", name: "À supprimer" })).body);
    await pg.exec(`
      INSERT INTO project_tasks (account_id, project_id, phase_id, name) VALUES (1, 2, ${p.id}, 'Dépendante');
      INSERT INTO allocations (account_id, person_id, project_id, phase_id, start_date, end_date, mode, hours_per_day) VALUES (1, 1, 2, ${p.id}, '2026-03-02', '2026-03-06', 'hours', 8);
      INSERT INTO logged_time (account_id, person_id, project_id, phase_id, work_date, hours) VALUES (1, 1, 2, ${p.id}, '2026-03-02', 3);
      INSERT INTO milestones (account_id, project_id, phase_id, name, due_date) VALUES (1, 2, ${p.id}, 'Jalon', '2026-03-31');
    `);
    const r = await send("pm", "DELETE", `${url}/${p.id}`, undefined, 1);
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "REFERENCE_IN_USE", params: { entity: "phase", tasks: 1, allocations: 1, logged_time: 1, milestones: 1 } });
    expect(await n(`SELECT count(*) AS n FROM milestones WHERE phase_id = ${p.id}`)).toBe(1); // rien n'a été emporté en silence
    await pg.exec(`DELETE FROM milestones WHERE phase_id = ${p.id}; DELETE FROM logged_time WHERE phase_id = ${p.id}; DELETE FROM allocations WHERE phase_id = ${p.id}; DELETE FROM project_tasks WHERE phase_id = ${p.id};`);
    expect((await send("member", "DELETE", `${url}/${p.id}`, undefined, 1)).status).toBe(403);
    expect((await send("pm", "DELETE", `${url}/${p.id}`, undefined, 1)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = 'phases' AND entity_id = ${p.id}`)).toBe(1);
  });
});

describe("/api/v1/project-tasks", () => {
  const url = "/api/v1/project-tasks";
  let phase1 = "";
  let phase2 = "";

  beforeAll(async () => {
    phase1 = Phase.parse((await send("pm", "POST", "/api/v1/phases", { projectId: "1", name: "Pour tâches 1" })).body).id;
    phase2 = Phase.parse((await send("pm", "POST", "/api/v1/phases", { projectId: "2", name: "Pour tâches 2" })).body).id;
  });

  matrix(url, { projectId: "2", name: "Rôles" });

  it("crée (201), forme du contrat ; facturable par défaut ; position par défaut par projet", async () => {
    const a = ProjectTask.parse((await send("pm", "POST", url, { projectId: "1", name: "Design" })).body);
    expect(a).toMatchObject({ projectId: "1", phaseId: null, billable: true, version: 1 });
    const b = ProjectTask.parse((await send("pm", "POST", url, { projectId: "1", name: "Dev", billable: false })).body);
    expect(b).toMatchObject({ billable: false, position: a.position + 1 });
  });
  it("phase du même projet acceptée ; phase d'un autre projet, d'un autre compte ou illisible : 404 entity phase", async () => {
    const ok = await send("pm", "POST", url, { projectId: "1", name: "Avec phase", phaseId: phase1 });
    expect(ok.status).toBe(201);
    expect(ProjectTask.parse(ok.body).phaseId).toBe(phase1);
    const foreignPhase = String((await pg.query<{ id: string }>("SELECT id FROM phases WHERE account_id = 2")).rows[0]!.id);
    for (const phaseId of [phase2, foreignPhase, "abc", "99999"]) {
      const r = await send("pm", "POST", url, { projectId: "1", name: "Refusée", phaseId });
      expect(r.status, phaseId).toBe(404);
      expect(err(r).params.entity).toBe("phase");
    }
    expect(await n("SELECT count(*) AS n FROM project_tasks WHERE name = 'Refusée'")).toBe(0);
  });
  it("projet inconnu ou hors compte : 404 entity project", async () => {
    for (const projectId of ["999", "3"]) {
      const r = await send("pm", "POST", url, { projectId, name: "x" });
      expect(r.status).toBe(404);
      expect(err(r).params.entity).toBe("project");
    }
  });
  it("modifie : déplacer vers une phase du projet, retirer la phase ; refus d'une phase d'un autre projet ; le projet est immuable", async () => {
    const t = ProjectTask.parse((await send("pm", "POST", url, { projectId: "1", name: "Mobile" })).body);
    let r = await send("pm", "PATCH", `${url}/${t.id}`, { phaseId: phase1, position: 7 }, 1);
    expect(ProjectTask.parse(r.body)).toMatchObject({ phaseId: phase1, position: 7, version: 2 });
    r = await send("pm", "PATCH", `${url}/${t.id}`, { phaseId: phase2 }, 2);
    expect(r.status).toBe(404);
    expect(err(r).params.entity).toBe("phase");
    r = await send("pm", "PATCH", `${url}/${t.id}`, { name: "Renommée", projectId: "2" }, 2);
    expect(ProjectTask.parse(r.body)).toMatchObject({ projectId: "1", name: "Renommée", phaseId: phase1 }); // phase conservée
    r = await send("pm", "PATCH", `${url}/${t.id}`, { phaseId: null }, 3);
    expect(ProjectTask.parse(r.body).phaseId).toBeNull();
    expect((await send("pm", "PATCH", `${url}/${t.id}`, { name: "x" }, 1)).status).toBe(409);
  });
  it("liste filtrée par projet et par phase, isolation entre comptes", async () => {
    const byProject = body<{ items: { projectId: string }[] }>(await send("member", "GET", `${url}?projectId=1`));
    expect(byProject.items.length).toBeGreaterThan(0);
    expect(byProject.items.every((t) => t.projectId === "1")).toBe(true);
    const byPhase = body<{ items: { phaseId: string }[]; page: { total: number } }>(await send("member", "GET", `${url}?phaseId=${phase1}`));
    expect(ProjectTaskList.safeParse(byPhase).success).toBe(true);
    expect(byPhase.items.every((t) => t.phaseId === phase1)).toBe(true);
    expect(byPhase.page.total).toBe(byPhase.items.length);
    const all = body<{ items: { name: string }[] }>(await send("member", "GET", url));
    expect(all.items.some((t) => t.name === "Tâche étrangère")).toBe(false);
    expect(err(await send("member", "GET", `${url}?phaseId=x`)).params.field).toBe("phaseId");
    const foreign = String((await pg.query<{ id: string }>("SELECT id FROM project_tasks WHERE account_id = 2")).rows[0]!.id);
    for (const [m, b] of [["GET"], ["PATCH", { name: "x" }], ["DELETE"]] as const) expect((await send("admin", m, `${url}/${foreign}`, b, 1)).status).toBe(404);
  });
  it("supprimer une phase qui contient des tâches est refusé (la tâche ne perd pas sa phase en silence)", async () => {
    const r = await send("pm", "DELETE", `/api/v1/phases/${phase1}`, undefined, 1);
    expect(r.status).toBe(409);
    expect(err(r).params.tasks).toBeGreaterThan(0);
  });
  it("suppression refusée tant que allocations, temps saisis ou lignes de budget y renvoient ; puis possible", async () => {
    const t = ProjectTask.parse((await send("pm", "POST", url, { projectId: "2", name: "À supprimer" })).body);
    await pg.exec(`
      INSERT INTO allocations (account_id, person_id, project_id, project_task_id, start_date, end_date, mode, hours_per_day) VALUES (1, 1, 2, ${t.id}, '2026-03-02', '2026-03-06', 'hours', 8);
      INSERT INTO logged_time (account_id, person_id, project_id, project_task_id, work_date, hours) VALUES (1, 1, 2, ${t.id}, '2026-03-02', 3);
      INSERT INTO project_budget_lines (account_id, project_id, project_task_id, hours) VALUES (1, 2, ${t.id}, 10);
    `);
    const r = await send("pm", "DELETE", `${url}/${t.id}`, undefined, 1);
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "REFERENCE_IN_USE", params: { entity: "project_task", allocations: 1, logged_time: 1, budget_lines: 1 } });
    expect(await n(`SELECT count(*) AS n FROM project_budget_lines WHERE project_task_id = ${t.id}`)).toBe(1);
    await pg.exec(`DELETE FROM project_budget_lines WHERE project_task_id = ${t.id}; DELETE FROM logged_time WHERE project_task_id = ${t.id}; DELETE FROM allocations WHERE project_task_id = ${t.id};`);
    expect((await send("member", "DELETE", `${url}/${t.id}`, undefined, 1)).status).toBe(403);
    expect((await send("pm", "DELETE", `${url}/${t.id}`, undefined, 1)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = 'project_tasks' AND entity_id = ${t.id}`)).toBe(1);
  });
});

describe("temps réel", () => {
  it("clients, phases et tâches sont journalisés (insert, update, delete) avec la bonne version", async () => {
    const before = await n("SELECT coalesce(max(seq), 0) AS n FROM change_log WHERE account_id = 1");
    const c = Client.parse((await send("pm", "POST", "/api/v1/clients", { name: "Bruit" })).body);
    const ph = Phase.parse((await send("pm", "POST", "/api/v1/phases", { projectId: "1", name: "Bruit" })).body);
    const t = ProjectTask.parse((await send("pm", "POST", "/api/v1/project-tasks", { projectId: "1", name: "Bruit", phaseId: ph.id })).body);
    await send("pm", "PATCH", `/api/v1/clients/${c.id}`, { name: "Bruit 2" }, 1);
    await send("pm", "DELETE", `/api/v1/project-tasks/${t.id}`, undefined, 1);
    const rows = (await pg.query<{ entity: string; op: string; version: number | null }>(
      `SELECT entity, op, version FROM change_log WHERE account_id = 1 AND seq > ${before} ORDER BY seq`)).rows;
    expect(rows).toEqual([
      { entity: "clients", op: "insert", version: 1 },
      { entity: "phases", op: "insert", version: 1 },
      { entity: "project_tasks", op: "insert", version: 1 },
      { entity: "clients", op: "update", version: 2 },
      { entity: "project_tasks", op: "delete", version: null },
    ]);
  });
});

describe("garde de rôle dans les fonctions elles-mêmes (en plus de la couche HTTP)", () => {
  const member = roles.member!;
  it.each([
    ["createClient", () => createClient(db, member, { name: "x" })],
    ["updateClient", () => updateClient(db, member, "1", 1, { name: "x" })],
    ["deleteClient", () => deleteClient(db, member, "1", 1)],
    ["createPhase", () => createPhase(db, member, { projectId: "1", name: "x" })],
    ["updatePhase", () => updatePhase(db, member, "1", 1, { name: "x" })],
    ["deletePhase", () => deletePhase(db, member, "1", 1)],
    ["createProjectTask", () => createProjectTask(db, member, { projectId: "1", name: "x" })],
    ["updateProjectTask", () => updateProjectTask(db, member, "1", 1, { name: "x" })],
    ["deleteProjectTask", () => deleteProjectTask(db, member, "1", 1)],
  ])("%s refuse un membre", async (_n, call) => {
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
