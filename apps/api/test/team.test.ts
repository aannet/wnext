// Retrait d'équipe (BR-10) contre schema.sql réel (PGlite) : récapitulatif sans écriture, garde de confirmation, temps verrouillés,
// suppressions exactes et journalisées, isolation, rôles.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TeamRemovalResult, TeamRemovalSummary } from "@wnext/contracts";
import { dispatch, getTeamRemovalSummary, readChanges, removeFromTeam, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-10 @BR-12 @BR-14 @BR-31
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  admin: { accountId: "1", userId: "1", role: "admin" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, raw?: string) =>
  dispatch(deps, { method, url, headers: { authorization: who }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
const summary = (p: string, who: string, per: string) => send(who, "GET", `/api/v1/projects/${p}/team/${per}/removal-summary`);
const remove = (p: string, per: string, body?: unknown, who = "admin") => send(who, "POST", `/api/v1/projects/${p}/team/${per}/removal`, body);
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
const confirm = { allocationCount: 2, logCount: 3, logHours: 11.5 };

// Personnes : 1 hal, 2 eve, 3 locke (temps soumis), 4 vide, 5 intrus (compte B). Projets : 1 P, 2 Q, 3 R (compte B).
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (1,'eve'), (1,'locke'), (1,'vide'), (2,'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P'), (1,'Q'), (2,'R');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
    INSERT INTO project_team (account_id, project_id, person_id) VALUES (1,1,1), (1,1,2), (1,1,3), (1,2,1), (1,1,4);
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, repeat_state, repeat_end_date) VALUES
      (1,1,1,'2026-03-09','2026-03-10','hours',8,'none',NULL),
      (1,1,1,'2026-02-02','2026-02-03','hours',4,'weekly','2026-04-30'),
      (1,1,2,'2026-03-09','2026-03-10','hours',8,'none',NULL),
      (1,2,1,'2026-03-09','2026-03-10','hours',8,'none',NULL),
      (1,3,1,'2026-03-09','2026-03-10','hours',8,'none',NULL);
    INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES
      (1,1,1,'2026-03-09',8), (1,1,1,'2026-03-10',2.5), (1,1,1,'2026-03-11',1),
      (1,1,2,'2026-03-09',8), (1,2,1,'2026-03-09',8), (1,3,1,'2026-03-09',4);
    UPDATE logged_time SET status = 'submitted' WHERE person_id = 3;
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET .../removal-summary", () => {
  it("compte allocations (fin de série incluse) et temps de la paire projet/personne, rien d'autre", async () => {
    const r = await summary("1", "admin", "1");
    expect(r.status).toBe(200);
    expect(TeamRemovalSummary.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({ inTeam: true, allocationCount: 2, firstAllocation: "2026-02-02", lastAllocation: "2026-04-30", logCount: 3, logHours: 11.5, lockedLogCount: 0, canRemove: true });
  });

  it("personne sans rien : zéros, dates nulles ; personne hors équipe : inTeam faux", async () => {
    expect((await summary("1", "admin", "4")).body).toMatchObject({ inTeam: true, allocationCount: 0, firstAllocation: null, lastAllocation: null, logCount: 0, logHours: 0, canRemove: true });
    expect((await summary("2", "admin", "2")).body).toMatchObject({ inTeam: false, allocationCount: 0 });
  });

  it("temps soumis : canRemove faux", async () => {
    expect((await summary("1", "admin", "3")).body).toMatchObject({ lockedLogCount: 1, canRemove: false });
  });

  it("n'écrit rien : mêmes lignes, même curseur du journal", async () => {
    const head = async () => ((await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as any).changeCursor;
    const [a, l, h] = [await n("SELECT count(*) AS n FROM allocations"), await n("SELECT count(*) AS n FROM logged_time"), await head()];
    await summary("1", "admin", "1");
    expect([await n("SELECT count(*) AS n FROM allocations"), await n("SELECT count(*) AS n FROM logged_time"), await head()]).toEqual([a, l, h]);
  });

  it("404 (projet, personne, autre compte, non numérique), 403 member, 401 anonyme", async () => {
    expect(err(await summary("999", "admin", "1")).params).toEqual({ entity: "project" });
    expect(err(await summary("1", "admin", "999")).params).toEqual({ entity: "person" });
    expect((await summary("1", "other", "1")).status).toBe(404); // projet du compte A vu depuis B
    expect((await summary("3", "other", "5")).status).toBe(200); // le compte B voit ses propres projet et personne
    expect(err(await summary("3", "other", "1")).params).toEqual({ entity: "person" }); // personne du compte A vue depuis B
    expect((await summary("abc", "admin", "1")).status).toBe(404);
    expect((await summary("1", "member", "1")).status).toBe(403);
    expect((await summary("1", "anon", "1")).status).toBe(401);
  });
});

describe("POST .../removal", () => {
  it("sans confirmation alors qu'il y a des suppressions : 428 avec le récapitulatif, rien supprimé", async () => {
    const r = await remove("1", "1");
    expect(r.status).toBe(428);
    expect(err(r)).toMatchObject({ code: "TEAM_REMOVAL_CONFIRMATION_REQUIRED", params: { inTeam: true, allocationCount: 2, logCount: 3, logHours: 11.5, firstAllocation: "2026-02-02", lastAllocation: "2026-04-30" } });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1 AND project_id = 1")).toBe(2);
  });

  it("confirmation qui ne correspond plus : 409 avec le NOUVEAU récapitulatif, rien supprimé", async () => {
    for (const bad of [{ ...confirm, allocationCount: 1 }, { ...confirm, logCount: 2 }, { ...confirm, logHours: 11 }, { allocationCount: 0, logCount: 0, logHours: 0 }]) {
      const r = await remove("1", "1", { confirmation: bad });
      expect(r.status).toBe(409);
      expect(err(r)).toMatchObject({ code: "TEAM_REMOVAL_STALE_CONFIRMATION", params: { allocationCount: 2, logCount: 3, logHours: 11.5 } });
    }
    expect(await n("SELECT count(*) AS n FROM logged_time WHERE person_id = 1 AND project_id = 1")).toBe(3);
  });

  it("une allocation ajoutée entre le récapitulatif et le clic rend la confirmation périmée", async () => {
    await pg.exec("INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1,1,1,'2026-05-04','2026-05-05','hours',2)");
    const r = await remove("1", "1", { confirmation: confirm });
    expect(err(r)).toMatchObject({ code: "TEAM_REMOVAL_STALE_CONFIRMATION", params: { allocationCount: 3 } });
    await pg.exec("DELETE FROM allocations WHERE start_date = '2026-05-04'");
  });

  it("temps verrouillés : 409 même avec une confirmation exacte et un rôle admin ; rien supprimé (BR-31)", async () => {
    const r = await remove("1", "3", { confirmation: { allocationCount: 1, logCount: 1, logHours: 4 } }, "admin");
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "TEAM_REMOVAL_LOCKED_LOGS", params: { lockedLogCount: 1, canRemove: false } });
    expect(await n("SELECT count(*) AS n FROM logged_time WHERE person_id = 3")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 3")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM project_team WHERE person_id = 3")).toBe(1);
  });

  it("rôles : member 403 (même corps invalide), anonyme 401 ; le domaine refuse aussi", async () => {
    expect((await remove("1", "1", { confirmation: "x" }, "member")).status).toBe(403);
    expect((await remove("1", "1", confirm, "anon")).status).toBe(401);
    await expect(removeFromTeam(db, roles.member!, "1", "1", { confirmation: confirm })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getTeamRemovalSummary(db, roles.member!, "1", "1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1 AND project_id = 1")).toBe(2);
  });

  it("400 sur confirmation mal formée ; 404 projet/personne inconnus ou d'un autre compte", async () => {
    expect((await remove("1", "1", { confirmation: { allocationCount: -1, logCount: 0, logHours: 0 } })).status).toBe(400);
    expect((await send("admin", "POST", "/api/v1/projects/1/team/1/removal", undefined, "{x")).status).toBe(400);
    expect(err(await remove("999", "1", {})).params).toEqual({ entity: "project" });
    expect(err(await remove("1", "999", {})).params).toEqual({ entity: "person" });
    expect((await remove("1", "1", confirm, "other")).status).toBe(404);
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1 AND project_id = 1")).toBe(2);
  });

  it("exécution : supprime exactement les allocations, les temps et la ligne d'équipe de la paire, rien d'autre", async () => {
    const head = ((await send("admin", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as any).changeCursor;
    const logged = async (entity: string) => n(`SELECT count(*) AS n FROM delete_log WHERE entity = '${entity}'`);
    const [delAlloc, delLogs] = [await logged("allocations"), await logged("logged_time")];
    const r = await remove("1", "1", { confirmation: confirm }, "pm");
    expect(r.status).toBe(200);
    expect(TeamRemovalResult.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({ removedAllocations: 2, removedLogs: 3, removedLogHours: 11.5, wasInTeam: true });
    // la paire est vide
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1 AND project_id = 1")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM logged_time WHERE person_id = 1 AND project_id = 1")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM project_team WHERE person_id = 1 AND project_id = 1")).toBe(0);
    // le reste est intact : même personne sur un autre projet, autres personnes sur ce projet
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1 AND project_id = 2")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM logged_time WHERE person_id = 1 AND project_id = 2")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM project_team WHERE person_id = 1 AND project_id = 2")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 2 AND project_id = 1")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM logged_time WHERE person_id = 2 AND project_id = 1")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM project_team WHERE person_id = 2 AND project_id = 1")).toBe(1);
    // BR-14 : une entrée de delete_log par suppression
    expect((await logged("allocations")) - delAlloc).toBe(2);
    expect((await logged("logged_time")) - delLogs).toBe(3);
    // temps réel : les allocations et les temps saisis supprimés sont dans le journal
    const ch = await readChanges(db, roles.admin!, head);
    if (ch.status !== "ok") throw new Error("expiré");
    const del = (entity: string) => [entity, expect.any(String), "delete"];
    expect(ch.changes.map((c) => [c.entity, c.id, c.op]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))))
      .toEqual([del("allocations"), del("allocations"), del("logged_time"), del("logged_time"), del("logged_time"), ["project_team", "1", "update"]]);
  });

  it("rejouer le retrait : rien à supprimer, pas de confirmation requise, 200 à zéro", async () => {
    const r = await remove("1", "1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ removedAllocations: 0, removedLogs: 0, removedLogHours: 0, wasInTeam: false });
  });

  it("personne en équipe sans rien à supprimer : retirée sans confirmation", async () => {
    const r = await remove("1", "4");
    expect(r.body).toEqual({ removedAllocations: 0, removedLogs: 0, removedLogHours: 0, wasInTeam: true });
    expect(await n("SELECT count(*) AS n FROM project_team WHERE person_id = 4")).toBe(0);
  });

  it("allocations sans ligne d'équipe (Q-07) : supprimées sur confirmation, wasInTeam faux", async () => {
    await pg.exec("INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1,2,2,'2026-03-09','2026-03-09','hours',3)");
    const r = await remove("2", "2", { confirmation: { allocationCount: 1, logCount: 0, logHours: 0 } });
    expect(r.body).toEqual({ removedAllocations: 1, removedLogs: 0, removedLogHours: 0, wasInTeam: false });
  });
});
