// Ajout en lot à l'équipe (POST /projects/{p}/team) contre schema.sql réel (PGlite) : tout ou rien, idempotence, ordre, isolation, rôles.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { TEAM_BATCH_MAX, TeamBatchResult } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManyToTeam, dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-01 @Q-07
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
const post = (who: string, project: string, body?: unknown) =>
  dispatch(deps, { method: "POST", url: `/api/v1/projects/${project}/team`, headers: { authorization: who }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const batch = (who: string, project: string, personIds: string[]) => post(who, project, { personIds });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
const members = async (project: string) => (await pg.query<{ person_id: string }>(`SELECT person_id FROM project_team WHERE project_id = ${project} ORDER BY person_id`)).rows.map((r) => String(r.person_id));

// Compte A : personnes 1..8 puis 9..508 (500 de plus) ; compte B : personne 509. Projets : 1..4 (A), 5 (B).
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) SELECT 1, 'p' || g FROM generate_series(1, 508) g;
    INSERT INTO people (account_id, name) VALUES (2, 'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P1'), (1,'P2'), (1,'P3'), (1,'P4'), (2,'R');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("POST /projects/{p}/team", () => {
  it("ajoute plusieurs personnes : 200, forme du contrat, lignes d'équipe, aucune allocation", async () => {
    const r = await batch("pm", "1", ["3", "1", "2"]);
    expect(r.status).toBe(200);
    expect(TeamBatchResult.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({ added: ["3", "1", "2"], alreadyInTeam: [] }); // ordre du corps
    expect(await members("1")).toEqual(["1", "2", "3"]);
    expect(await n("SELECT count(*) AS n FROM allocations")).toBe(0);
  });
  it("idempotent : rejouer le même lot ne change rien", async () => {
    const r = await batch("pm", "1", ["3", "1", "2"]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ added: [], alreadyInTeam: ["3", "1", "2"] });
    expect(await members("1")).toEqual(["1", "2", "3"]);
  });
  it("lot mixte : les nouveaux et les présents sont séparés, dans l'ordre reçu", async () => {
    const r = await batch("admin", "1", ["5", "2", "4", "1"]);
    expect(r.body).toEqual({ added: ["5", "4"], alreadyInTeam: ["2", "1"] });
    expect(await members("1")).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("cohérent avec la lecture de l'équipe et avec l'ajout unitaire", async () => {
    await batch("owner", "2", ["7", "6"]);
    const single = await dispatch(deps, { method: "PUT", url: "/api/v1/projects/2/team/7", headers: { authorization: "pm" } });
    expect(single.body).toEqual({ added: false });
    const read = await dispatch(deps, { method: "GET", url: "/api/v1/projects/2/team", headers: { authorization: "member" } });
    expect((read.body as { items: { personId: string }[] }).items.map((m) => m.personId)).toEqual(["6", "7"]);
  });

  describe("tout ou rien", () => {
    it("une personne inconnue annule tout et est nommée (la première fautive dans l'ordre reçu)", async () => {
      const before = await members("3");
      const r = await batch("pm", "3", ["1", "9999", "2", "8888"]);
      expect(r.status).toBe(404);
      expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity: "person", personId: "9999" } });
      expect(await members("3")).toEqual(before);
      expect(before).toEqual([]);
    });
    it("une personne d'un autre compte, ou un identifiant illisible, est refusé de la même façon (jamais une 500)", async () => {
      for (const bad of ["509", "abc", "99999999999999999999", "-1"]) {
        const r = await batch("pm", "3", ["1", bad]);
        expect(r.status, bad).toBe(404);
        expect(err(r).params, bad).toEqual({ entity: "person", personId: bad });
      }
      expect(await members("3")).toEqual([]);
    });
    it("le projet est vérifié avant les personnes", async () => {
      for (const project of ["999", "5", "abc"]) {
        const r = await batch("pm", project, ["9999"]);
        expect(r.status, project).toBe(404);
        expect(err(r).params.entity).toBe("project");
      }
    });
    it("l'autre compte ne peut pas toucher l'équipe du compte A", async () => {
      expect((await batch("other", "3", ["509"])).status).toBe(404);
      expect(await members("3")).toEqual([]);
      const own = await batch("other", "5", ["509"]);
      expect(own.body).toEqual({ added: ["509"], alreadyInTeam: [] });
    });
  });

  describe("rôles", () => {
    it.each(["owner", "admin", "pm"])("%s écrit", async (who) => expect((await batch(who, "4", ["8"])).status).toBe(200));
    it.each(["member", "guest"])("%s : 403, rien d'écrit, même avec un corps invalide (le rôle passe avant la validation)", async (who) => {
      const before = await members("4");
      for (const b of [{ personIds: ["1"] }, "pas du json"]) {
        const r = await post(who, "4", b);
        expect(r.status).toBe(403);
        expect(err(r).code).toBe("FORBIDDEN");
      }
      expect(await members("4")).toEqual(before);
    });
    it("anonyme : 401", async () => expect((await batch("anon", "4", ["1"])).status).toBe(401));
    it("la fonction refuse aussi un membre d'elle-même", async () => {
      await expect(addManyToTeam(db, roles.member!, "4", { personIds: ["1"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("corps invalide : 400", () => {
    it.each([
      ["liste vide", { personIds: [] }, "personIds"],
      ["doublon", { personIds: ["1", "2", "1"] }, "personIds"],
      ["champ absent", {}, "personIds"],
      ["identifiant numérique", { personIds: [1] }, "personIds"],
      ["identifiant vide", { personIds: [""] }, "personIds"],
      ["non JSON", "pas du json", "body"],
      ["corps absent", undefined, "body"],
      ["trop de personnes", { personIds: Array.from({ length: TEAM_BATCH_MAX + 1 }, (_, i) => String(i + 1)) }, "personIds"],
    ])("%s", async (_n, body, field) => {
      const r = await post("pm", "4", body);
      expect(r.status).toBe(400);
      expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
    });
  });

  it("le maximum (500 personnes) passe en une transaction", async () => {
    const ids = Array.from({ length: TEAM_BATCH_MAX }, (_, i) => String(i + 9));
    const r = await batch("pm", "4", ids);
    expect(r.status).toBe(200);
    expect((r.body as { added: string[] }).added).toEqual(ids);
    expect(await n("SELECT count(*) AS n FROM project_team WHERE project_id = 4")).toBe(TEAM_BATCH_MAX + 1); // + la personne 8 ajoutée plus haut
  });

  it("deux lots qui se chevauchent lancés ensemble : chaque personne est ajoutée exactement une fois", async () => {
    const [a, b] = await Promise.all([batch("pm", "2", ["20", "21", "22", "23"]), batch("admin", "2", ["23", "22", "24", "21"])]);
    const added = [...(a.body as { added: string[] }).added, ...(b.body as { added: string[] }).added].sort();
    expect(added).toEqual(["20", "21", "22", "23", "24"]);
    expect(await members("2")).toEqual(["20", "21", "22", "23", "24", "6", "7"].sort((x, y) => Number(x) - Number(y)));
  });
});
