// Ajout à l'équipe projet (PUT /projects/{p}/team/{person}) contre schema.sql réel (PGlite) : idempotence, isolation, rôles,
// aucune allocation créée, contrepartie du retrait BR-10.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TeamMembership } from "@wnext/contracts";
import { addToTeam, dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-10 @Q-07
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
const put = (who: string, p: string, per: string, method = "PUT") => dispatch(deps, { method, url: `/api/v1/projects/${p}/team/${per}`, headers: { authorization: who } });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);

// Personnes : 1 hal, 2 eve, 3 intrus (compte B). Projets : 1 P, 2 R (compte B).
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (1,'eve'), (2,'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P'), (2,'R');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("PUT /projects/{p}/team/{person}", () => {
  it("ajoute : 200 added=true, une ligne, aucune allocation créée", async () => {
    const r = await put("admin", "1", "1");
    expect(r.status).toBe(200);
    expect(TeamMembership.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({ added: true });
    expect(await n("SELECT count(*) AS n FROM project_team WHERE project_id = 1 AND person_id = 1")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM allocations")).toBe(0);
  });

  it("idempotent : rejouer donne added=false et reste à une seule ligne", async () => {
    const r = await put("pm", "1", "1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ added: false });
    expect(await n("SELECT count(*) AS n FROM project_team")).toBe(1);
  });

  it("une autre personne s'ajoute indépendamment", async () => {
    expect((await put("admin", "1", "2")).body).toEqual({ added: true });
    expect(await n("SELECT count(*) AS n FROM project_team")).toBe(2);
  });

  it("anonyme 401, membre 403 (rôle en params), sans écriture", async () => {
    expect(err(await put("anon", "1", "1")).code).toBe("UNAUTHENTICATED");
    const r = await put("member", "1", "2");
    expect(r.status).toBe(403);
    expect(err(r)).toMatchObject({ code: "FORBIDDEN", params: { role: "member" } });
    await expect(addToTeam(db, roles.member!, "1", "2")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each([
    ["projet inconnu", "99", "1", "project"],
    ["personne inconnue", "1", "99", "person"],
    ["projet d'un autre compte", "2", "1", "project"],
    ["personne d'un autre compte", "1", "3", "person"],
    ["id illisible", "1", "%E0", "person"],
    ["id non numérique", "abc", "1", "project"],
  ])("404 : %s", async (_n, p, per, entity) => {
    const before = await n("SELECT count(*) AS n FROM project_team");
    const r = await put("admin", p, per);
    expect(r.status).toBe(404);
    expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity } });
    expect(await n("SELECT count(*) AS n FROM project_team")).toBe(before);
  });

  it("le compte B ajoute sa propre personne à son projet, sans toucher le compte A", async () => {
    expect((await put("other", "2", "3")).body).toEqual({ added: true });
    expect(await n("SELECT count(*) AS n FROM project_team WHERE account_id = 1")).toBe(2);
  });

  it("autres méthodes sur la ressource : pas de route (404 route)", async () => {
    for (const m of ["GET", "POST", "PATCH", "DELETE"]) {
      const r = await put("admin", "1", "1", m);
      expect(r.status, m).toBe(404);
      expect(err(r).params).toMatchObject({ entity: "route" });
    }
  });

  it("contrepartie du retrait : après ajout puis retrait, wasInTeam vrai puis la ligne a disparu", async () => {
    const r = await dispatch(deps, { method: "POST", url: "/api/v1/projects/1/team/2/removal", headers: { authorization: "admin" }, body: "{}" });
    expect(r.body).toEqual({ removedAllocations: 0, removedLogs: 0, removedLogHours: 0, wasInTeam: true });
    expect((await put("admin", "1", "2")).body).toEqual({ added: true });
  });
});
