// Allocations multi-personnes (BR-26) contre schema.sql réel (PGlite) : création de groupe, édition et suppression « tous », « celle-ci ».
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { AllocationGroup, ScheduleAllocation } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAllocationGroup, deleteAllocationGroup, dispatch, updateAllocationGroup, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-05 @BR-26
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
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
const GROUPS = "/api/v1/allocation-groups";
const h = (x: number) => ({ mode: "hours", hoursPerDay: x }) as const;
const base = { projectId: "1", startDate: "2026-03-02", endDate: "2026-03-06" };
type Alloc = ReturnType<typeof ScheduleAllocation.parse>;
const create = async (body: unknown, who = "pm") => {
  const r = await send(who, "POST", GROUPS, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return AllocationGroup.parse(r.body);
};
const row = async (id: string) => ScheduleAllocation.parse((await send("guest", "GET", `/api/v1/allocations/${id}`)).body);

// Compte A : personnes 1 hal, 2 bob, 3 carol, 4 dan ; projets 1 P1, 2 P2 ; phases 1 (P1), 2 (P2) ; tâches 1 (P1), 2 (P2).
// Compte B : personne 5, projet 3.
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (1,'bob'), (1,'carol'), (1,'dan'), (2,'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P1'), (1,'P2'), (2,'Q');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
    INSERT INTO phases (account_id, project_id, name) VALUES (1,1,'Ph1'), (1,2,'Ph2');
    INSERT INTO project_tasks (account_id, project_id, name) VALUES (1,1,'T1'), (1,2,'T2');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("POST /allocation-groups", () => {
  it("rôles : owner, admin et project_manager créent ; member et guest : 403 ; anonyme : 401 ; rôle contrôlé avant le corps", async () => {
    const body = { ...base, load: h(4), members: [{ personId: "1" }, { personId: "2" }] };
    for (const who of ["owner", "admin", "pm"]) expect((await send(who, "POST", GROUPS, body)).status, who).toBe(201);
    for (const who of ["member", "guest"]) {
      const r = await send(who, "POST", GROUPS, body);
      expect([r.status, err(r).code], who).toEqual([403, "FORBIDDEN"]);
      expect((await send(who, "POST", GROUPS, {})).status).toBe(403);
    }
    expect((await send("anon", "POST", GROUPS, body)).status).toBe(401);
    expect((await send("anon", "POST", GROUPS, {})).status).toBe(401);
    await pg.exec("DELETE FROM allocations");
  });

  it("une ligne par membre, un groupId commun, dans l'ordre du corps ; champs communs identiques", async () => {
    const g = await create({ ...base, phaseId: "1", taskId: "1", name: "Sprint", notes: "n", status: "tentative", billable: false, priority: 3, load: h(4), members: [{ personId: "3" }, { personId: "1" }, { personId: "2" }] });
    expect(g.items.map((a) => a.personId)).toEqual(["3", "1", "2"]);
    expect(Number(g.items[0]!.id) < Number(g.items[1]!.id) && Number(g.items[1]!.id) < Number(g.items[2]!.id)).toBe(true);
    expect(g.groupId).toMatch(/^[0-9a-f-]{36}$/);
    for (const a of g.items) {
      expect(a).toMatchObject({ groupId: g.groupId, projectId: "1", phaseId: "1", taskId: "1", name: "Sprint", notes: "n", status: "tentative", billable: false, priority: 3, startDate: "2026-03-02", endDate: "2026-03-06", version: 1, repeatState: "none", repeatEndDate: null });
    }
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE group_id = '${g.groupId}'`)).toBe(3);
  });

  it("chaque membre a ses propres heures : charge propre, charge commune, pourcentage", async () => {
    const g = await create({ ...base, load: h(4), members: [{ personId: "1", load: h(2) }, { personId: "2" }, { personId: "3", load: { mode: "percentage", percent: 50 } }] });
    expect(g.items.map((a) => [a.mode, a.hoursPerDay, a.percent])).toEqual([["hours", 2, null], ["hours", 4, null], ["percentage", null, 50]]);
  });

  it("défauts d'une allocation (confirmée, facturable, priorité 0) et répétition prise en compte", async () => {
    const g = await create({ ...base, repeatState: "weekly", repeatEndDate: "2026-04-03", members: [{ personId: "1", load: h(1) }, { personId: "2", load: h(1) }] });
    for (const a of g.items) expect(a).toMatchObject({ status: "confirmed", billable: true, priority: 0, repeatState: "weekly", repeatEndDate: "2026-04-03" });
  });

  it("deux groupes distincts n'ont pas le même groupId ; la liste du projet et le Schedule exposent groupId", async () => {
    const a = await create({ ...base, projectId: "2", load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const b = await create({ ...base, projectId: "2", load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    expect(a.groupId).not.toBe(b.groupId);
    const list = (await send("guest", "GET", "/api/v1/projects/2/allocations?from=2026-03-02&to=2026-03-06")).body as { items: Alloc[] };
    expect(list.items.filter((x) => x.groupId === a.groupId)).toHaveLength(2);
    const sched = (await send("guest", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as { allocations: Alloc[] };
    expect(sched.allocations.filter((x) => x.groupId === b.groupId)).toHaveLength(2);
  });

  describe("tout ou rien", () => {
    const ok2 = [{ personId: "1", load: h(1) }, { personId: "2", load: h(1) }];
    it.each([
      ["personne inconnue (en dernier)", { ...base, members: [...ok2, { personId: "999", load: h(1) }] }, "person"],
      ["personne d'un autre compte", { ...base, members: [...ok2, { personId: "5", load: h(1) }] }, "person"],
      ["personne illisible", { ...base, members: [...ok2, { personId: "abc", load: h(1) }] }, "person"],
      ["projet inconnu", { ...base, projectId: "999", members: ok2 }, "project"],
      ["projet d'un autre compte", { ...base, projectId: "3", members: ok2 }, "project"],
      ["phase d'un autre projet", { ...base, phaseId: "2", members: ok2 }, "phase"],
      ["tâche d'un autre projet", { ...base, taskId: "2", members: ok2 }, "task"],
    ])("%s : 404 params.entity, rien d'écrit", async (_label, body, entity) => {
      const before = await n("SELECT count(*) AS n FROM allocations");
      const r = await send("pm", "POST", GROUPS, body);
      expect([r.status, err(r).code, err(r).params.entity]).toEqual([404, "NOT_FOUND", entity]);
      expect(await n("SELECT count(*) AS n FROM allocations")).toBe(before);
    });
  });

  describe("validation : 400 VALIDATION_FAILED, rien d'écrit", () => {
    const m = [{ personId: "1" }, { personId: "2" }];
    it.each([
      ["sans membres", { ...base, load: h(1) }, "members"],
      ["un seul membre", { ...base, load: h(1), members: [{ personId: "1" }] }, "members"],
      ["membre en double", { ...base, load: h(1), members: [{ personId: "1" }, { personId: "1" }] }, "members"],
      ["51 membres", { ...base, load: h(1), members: Array.from({ length: 51 }, (_, i) => ({ personId: String(i + 1) })) }, "members"],
      ["membre sans charge", { ...base, members: [{ personId: "1", load: h(1) }, { personId: "2" }] }, "load"],
      ["charge hors bornes", { ...base, load: h(25), members: m }, "load"],
      ["fin avant le début", { ...base, endDate: "2026-03-01", load: h(1), members: m }, "endDate"],
      ["répétition sans fin", { ...base, repeatState: "daily", load: h(1), members: m }, "repeatEndDate"],
      ["sans projet", { startDate: base.startDate, endDate: base.endDate, load: h(1), members: m }, "projectId"],
    ])("%s", async (_label, body, field) => {
      const before = await n("SELECT count(*) AS n FROM allocations");
      const r = await send("pm", "POST", GROUPS, body);
      expect([r.status, err(r).code, err(r).params.field]).toEqual([400, "VALIDATION_FAILED", field]);
      expect(await n("SELECT count(*) AS n FROM allocations")).toBe(before);
    });
    it("corps illisible ou absent", async () => {
      expect((await send("pm", "POST", GROUPS)).status).toBe(400);
      expect((await dispatch(deps, { method: "POST", url: GROUPS, headers: { authorization: "pm" }, body: "{" })).status).toBe(400);
    });
  });

  it("une panne au 3e insert annule tout : aucune ligne des deux premiers membres ne subsiste (une seule transaction)", async () => {
    let inserts = 0;
    const flaky: Db = {
      transaction: (fn) => db.transaction((tx) => fn({
        query: (sql: string, args?: unknown[]) => {
          if (/^\s*INSERT INTO allocations/.test(sql) && ++inserts === 3) return Promise.reject(new Error("panne simulée"));
          return (tx as never as { query(s: string, a?: unknown[]): Promise<never> }).query(sql, args);
        },
      } as never)),
    };
    const before = await n("SELECT count(*) AS n FROM allocations");
    await expect(createAllocationGroup(flaky, roles.pm!, { ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }, { personId: "3" }] })).rejects.toThrow("panne simulée");
    expect(inserts).toBe(3);
    expect(await n("SELECT count(*) AS n FROM allocations")).toBe(before);
  });
});

describe("PATCH /allocations/{id}/group — « tous »", () => {
  it("rôles : 403 pour member et guest, 401 anonyme, rôle contrôlé avant le corps ; 428 sans If-Match", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const url = `/api/v1/allocations/${g.items[0]!.id}/group`;
    for (const who of ["member", "guest"]) {
      expect((await send(who, "PATCH", url, { name: "x" }, 1)).status, who).toBe(403);
      expect((await send(who, "PATCH", url, {}, 1)).status).toBe(403);
      expect((await send(who, "DELETE", url, undefined, 1)).status).toBe(403);
    }
    expect((await send("anon", "PATCH", url, { name: "x" }, 1)).status).toBe(401);
    expect((await send("pm", "PATCH", url, { name: "x" })).status).toBe(428);
    expect((await send("pm", "DELETE", url)).status).toBe(428);
    for (const who of ["owner", "admin", "pm"]) expect((await send(who, "PATCH", url, { notes: who }, undefined)).status).toBe(428);
  });

  it("applique les champs communs à TOUTES les lignes ; chacune garde sa charge et sa personne ; toutes les versions montent", async () => {
    const g = await create({ ...base, name: "Avant", load: h(4), members: [{ personId: "1", load: h(2) }, { personId: "2" }, { personId: "3", load: h(6) }] });
    const r = await send("pm", "PATCH", `/api/v1/allocations/${g.items[1]!.id}/group`, { name: "Après", status: "tentative", endDate: "2026-03-10", phaseId: "1" }, 1);
    expect(r.status).toBe(200);
    const out = AllocationGroup.parse(r.body);
    expect(out.groupId).toBe(g.groupId);
    expect(out.items.map((a) => a.id)).toEqual(g.items.map((a) => a.id));
    expect(out.items.map((a) => [a.personId, a.hoursPerDay])).toEqual([["1", 2], ["2", 4], ["3", 6]]);
    for (const a of out.items) expect(a).toMatchObject({ name: "Après", status: "tentative", endDate: "2026-03-10", phaseId: "1", startDate: "2026-03-02", version: 2, groupId: g.groupId });
  });

  it("chaque ligne applique le patch à SA valeur actuelle : une ligne dont les dates ont divergé les garde", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const [a, b] = g.items as [Alloc, Alloc];
    expect((await send("pm", "PATCH", `/api/v1/allocations/${b.id}`, { startDate: "2026-03-03", endDate: "2026-03-04" }, 1)).status).toBe(200); // « celle-ci »
    const r = AllocationGroup.parse((await send("pm", "PATCH", `/api/v1/allocations/${a.id}/group`, { name: "Commun" }, 1)).body);
    expect(r.items.map((x) => [x.startDate, x.endDate, x.name])).toEqual([["2026-03-02", "2026-03-06", "Commun"], ["2026-03-03", "2026-03-04", "Commun"]]);
    expect(r.items[1]!.version).toBe(3);
  });

  it("If-Match n'est contrôlé que sur la ligne désignée ; version périmée : 409 avec la version courante, rien de modifié", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const [a, b] = g.items as [Alloc, Alloc];
    await send("pm", "PATCH", `/api/v1/allocations/${b.id}`, { notes: "autre ligne" }, 1); // b passe en version 2, a reste en 1
    const ok = await send("pm", "PATCH", `/api/v1/allocations/${a.id}/group`, { name: "ok" }, 1); // a est à jour : accepté malgré b
    expect(ok.status).toBe(200);
    const stale = await send("pm", "PATCH", `/api/v1/allocations/${a.id}/group`, { name: "périmé" }, 1);
    expect([stale.status, err(stale).code, err(stale).params.currentVersion]).toEqual([409, "VERSION_CONFLICT", 2]);
    expect((await row(a.id)).name).toBe("ok");
    expect((await row(b.id)).name).toBe("ok");
  });

  it("une ligne devenue invalide (début après sa fin) annule TOUT le patch : 400, aucune ligne modifiée", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const [a, b] = g.items as [Alloc, Alloc];
    await send("pm", "PATCH", `/api/v1/allocations/${b.id}`, { startDate: "2026-03-02", endDate: "2026-03-03" }, 1);
    // a : 03-02..03-06 ; b : 03-02..03-03. Nouveau début 03-05 : valide pour a, invalide pour b.
    const r = await send("pm", "PATCH", `/api/v1/allocations/${a.id}/group`, { startDate: "2026-03-05" }, 1);
    expect([r.status, err(r).params.field]).toEqual([400, "endDate"]);
    expect((await row(a.id))).toMatchObject({ startDate: "2026-03-02", version: 1 });
    expect((await row(b.id))).toMatchObject({ endDate: "2026-03-03", version: 2 });
  });

  it("changer de projet remet phase et tâche à zéro sur chaque ligne, sauf celles que le patch précise", async () => {
    const g = await create({ ...base, phaseId: "1", taskId: "1", load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    let r = AllocationGroup.parse((await send("pm", "PATCH", `/api/v1/allocations/${g.items[0]!.id}/group`, { projectId: "2" }, 1)).body);
    for (const a of r.items) expect(a).toMatchObject({ projectId: "2", phaseId: null, taskId: null });
    r = AllocationGroup.parse((await send("pm", "PATCH", `/api/v1/allocations/${g.items[0]!.id}/group`, { projectId: "1", phaseId: "1" }, 2)).body);
    for (const a of r.items) expect(a).toMatchObject({ projectId: "1", phaseId: "1", taskId: null });
  });

  it("références inconnues : 404 params.entity, rien de modifié", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const url = `/api/v1/allocations/${g.items[0]!.id}/group`;
    for (const [body, entity] of [[{ projectId: "999" }, "project"], [{ projectId: "3" }, "project"], [{ phaseId: "2" }, "phase"], [{ taskId: "2" }, "task"], [{ phaseId: "abc" }, "phase"]] as const) {
      const r = await send("pm", "PATCH", url, body, 1);
      expect([r.status, err(r).params.entity], JSON.stringify(body)).toEqual([404, entity]);
    }
    expect((await row(g.items[1]!.id)).version).toBe(1);
  });

  it("corps invalide : personne et charge interdites (propres à chaque ligne), clé inconnue, vide, dates inversées : 400", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const url = `/api/v1/allocations/${g.items[0]!.id}/group`;
    for (const body of [{ personId: "3" }, { load: h(2) }, { name: "x", personId: "3" }, { foo: 1 }, {}, { startDate: "2026-03-09", endDate: "2026-03-02" }, { status: "draft" }]) {
      const r = await send("pm", "PATCH", url, body, 1);
      expect([r.status, err(r).code], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect((await send("pm", "PATCH", url, { name: "x" }, "abc")).status).toBe(400); // If-Match mal formé
    expect((await row(g.items[0]!.id)).version).toBe(1);
  });

  it("allocation sans groupe : 404 allocation_group ; inconnue, illisible ou d'un autre compte : 404 allocation", async () => {
    const solo = ScheduleAllocation.parse((await send("pm", "POST", "/api/v1/allocations", { personId: "4", ...base, load: h(1) })).body);
    expect(solo.groupId).toBeNull();
    for (const m of ["PATCH", "DELETE"]) {
      const r = await send("pm", m, `/api/v1/allocations/${solo.id}/group`, m === "PATCH" ? { name: "x" } : undefined, 1);
      expect([r.status, err(r).params.entity], m).toEqual([404, "allocation_group"]);
    }
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    for (const id of ["999999", "abc", "%E0%A4%A"]) {
      expect(err(await send("pm", "PATCH", `/api/v1/allocations/${id}/group`, { name: "x" }, 1)).params.entity, id).toBe("allocation");
    }
    const foreign = await send("other", "POST", "/api/v1/allocations", { personId: "5", ...base, projectId: "3", load: h(1) });
    const foreignId = ScheduleAllocation.parse(foreign.body).id;
    expect(err(await send("pm", "PATCH", `/api/v1/allocations/${foreignId}/group`, { name: "x" }, 1)).params.entity).toBe("allocation");
    expect(err(await send("other", "PATCH", `/api/v1/allocations/${g.items[0]!.id}/group`, { name: "x" }, 1)).params.entity).toBe("allocation"); // le groupe du compte A est invisible de B
    expect((await row(g.items[0]!.id)).version).toBe(1);
  });

  it("« celle-ci » : PATCH/DELETE d'une seule ligne laisse les autres et le groupId intacts", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }, { personId: "3" }] });
    const [a, b, c] = g.items as [Alloc, Alloc, Alloc];
    const moved = await row(a.id);
    const r = await send("pm", "PATCH", `/api/v1/allocations/${a.id}`, { personId: "4", load: h(7) }, moved.version);
    expect(ScheduleAllocation.parse(r.body)).toMatchObject({ personId: "4", hoursPerDay: 7, groupId: g.groupId }); // reste dans le groupe
    expect((await send("pm", "DELETE", `/api/v1/allocations/${b.id}`, undefined, 1)).status).toBe(204);
    expect(await row(c.id)).toMatchObject({ version: 1, groupId: g.groupId, personId: "3" });
    // Le groupe restant (a déplacée + c) s'édite encore « tous ».
    const all = AllocationGroup.parse((await send("pm", "PATCH", `/api/v1/allocations/${c.id}/group`, { name: "Reste" }, 1)).body);
    expect(all.items.map((x) => x.personId)).toEqual(["4", "3"]);
  });

  it("BR-05 : un congé d'un membre ne touche pas les autres lignes du groupe", async () => {
    const g = await create({ ...base, load: h(4), members: [{ personId: "1" }, { personId: "2" }] });
    await pg.exec(`
      INSERT INTO timeoff_types (account_id, name) VALUES (1, 'CP-groupe');
      INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date)
        SELECT 1, 1, id, '2026-03-02', '2026-03-03' FROM timeoff_types WHERE name = 'CP-groupe';
    `);
    for (const a of g.items) expect(await row(a.id)).toMatchObject({ version: 1, groupId: g.groupId, startDate: "2026-03-02", endDate: "2026-03-06" });
  });
});

describe("DELETE /allocations/{id}/group — « tous »", () => {
  it("supprime toutes les lignes du groupe (journalisé), pas celles des autres groupes ni les allocations seules", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }, { personId: "3" }] });
    const other = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const solo = ScheduleAllocation.parse((await send("pm", "POST", "/api/v1/allocations", { personId: "4", ...base, load: h(1) })).body);
    const r = await send("pm", "DELETE", `/api/v1/allocations/${g.items[2]!.id}/group`, undefined, 1);
    expect([r.status, r.body]).toEqual([204, undefined]);
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE group_id = '${g.groupId}'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = 'allocations' AND entity_id IN (${g.items.map((a) => a.id).join(",")})`)).toBe(3);
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE group_id = '${other.groupId}'`)).toBe(2);
    expect((await send("guest", "GET", `/api/v1/allocations/${solo.id}`)).status).toBe(200);
    expect((await send("guest", "GET", `/api/v1/allocations/${g.items[0]!.id}`)).status).toBe(404);
  });

  it("version périmée de la ligne désignée : 409, rien de supprimé ; ligne désignée à jour malgré une autre périmée : supprime tout", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const [a, b] = g.items as [Alloc, Alloc];
    await send("pm", "PATCH", `/api/v1/allocations/${b.id}`, { notes: "x" }, 1);
    const stale = await send("pm", "DELETE", `/api/v1/allocations/${b.id}/group`, undefined, 1);
    expect([stale.status, err(stale).params.currentVersion]).toEqual([409, 2]);
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE group_id = '${g.groupId}'`)).toBe(2);
    expect((await send("pm", "DELETE", `/api/v1/allocations/${a.id}/group`, undefined, 1)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE group_id = '${g.groupId}'`)).toBe(0);
  });

  it("Prefer: return=representation : 200 avec TOUTES les lignes supprimées, état d'avant (lignes divergentes comprises) ; sinon 204", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }, { personId: "3" }] });
    // Une ligne a divergé (« celle-ci ») : autre projet et autres dates, toujours dans le groupe.
    await send("pm", "PATCH", `/api/v1/allocations/${g.items[1]!.id}`, { projectId: "2", startDate: "2027-01-04", endDate: "2027-01-05" }, 1);
    const before = await Promise.all(g.items.map((a) => row(a.id)));
    const r = await dispatch(deps, { method: "DELETE", url: `/api/v1/allocations/${g.items[0]!.id}/group`, headers: { authorization: "pm", "if-match": "\"1\"", prefer: "return=representation" }, body: undefined });
    expect(r.status).toBe(200);
    const out = AllocationGroup.parse(r.body);
    expect(out.groupId).toBe(g.groupId);
    expect(out.items).toEqual(before);
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE group_id = '${g.groupId}'`)).toBe(0);
    // Autre valeur de Prefer : ignorée (RFC 7240), 204.
    const g2 = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const r2 = await dispatch(deps, { method: "DELETE", url: `/api/v1/allocations/${g2.items[0]!.id}/group`, headers: { authorization: "pm", "if-match": "\"1\"", prefer: "return=minimal" }, body: undefined });
    expect([r2.status, r2.body]).toEqual([204, undefined]);
    // Liste de préférences (RFC 7240) : return=representation y suffit.
    const g3 = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    const r3 = await dispatch(deps, { method: "DELETE", url: `/api/v1/allocations/${g3.items[0]!.id}/group`, headers: { authorization: "pm", "if-match": "\"1\"", prefer: "respond-async, Return=Representation" }, body: undefined });
    expect([r3.status, AllocationGroup.parse(r3.body).items.length]).toEqual([200, 2]);
  });

  it("supprimée une fois, la seconde demande est un 404 allocation", async () => {
    const g = await create({ ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] });
    expect((await send("pm", "DELETE", `/api/v1/allocations/${g.items[0]!.id}/group`, undefined, 1)).status).toBe(204);
    expect(err(await send("pm", "DELETE", `/api/v1/allocations/${g.items[0]!.id}/group`, undefined, 1)).params.entity).toBe("allocation");
  });
});

describe("hors des routes de groupe", () => {
  it("les routes inconnues le restent : GET et PUT sur /group, GET sur /allocation-groups", async () => {
    for (const [m, u] of [["GET", "/api/v1/allocations/1/group"], ["PUT", "/api/v1/allocations/1/group"], ["GET", GROUPS], ["DELETE", GROUPS]] as const) {
      const r = await send("pm", m, u, undefined, 1);
      expect([r.status, err(r).params.entity], `${m} ${u}`).toEqual([404, "route"]);
    }
  });
});

describe("garde de rôle dans les fonctions elles-mêmes (en plus de la couche HTTP)", () => {
  const member = roles.member!;
  it.each([
    ["createAllocationGroup", () => createAllocationGroup(db, member, { ...base, load: h(1), members: [{ personId: "1" }, { personId: "2" }] })],
    ["updateAllocationGroup", () => updateAllocationGroup(db, member, "1", 1, { name: "x" })],
    ["deleteAllocationGroup", () => deleteAllocationGroup(db, member, "1", 1)],
  ])("%s refuse un membre", async (_n, call) => {
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
