// Lecture de l'équipe d'un projet (GET /projects/{p}/team) contre schema.sql réel (PGlite) : pagination par curseur, isolation, rôles,
// cohérence avec l'ajout et le retrait.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { TeamMemberList } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-10 @Q-07
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
const send = (who: string, method: string, url: string, body?: unknown) =>
  dispatch(deps, { method, url, headers: { authorization: who }, body: body === undefined ? undefined : JSON.stringify(body) });
const team = (who: string, project: string, qs = "") => send(who, "GET", `/api/v1/projects/${project}/team${qs}`);
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const list = (r: { body: unknown }) => r.body as { items: { personId: string; name: string }[]; page: { nextCursor: string | null; total: number } };

// Personnes du compte A : 1..6 (alice..franck), compte B : 7. Projets : 1 P1 (équipe 1,2,3,4,5), 2 P2 (vide), 3 R (compte B), 4 archivé (équipe 1).
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'alice'), (1,'bob'), (1,'carol'), (1,'dave'), (1,'eve'), (1,'franck'), (2,'intrus');
    INSERT INTO projects (account_id, name, status) VALUES (1,'P1','planned'), (1,'P2','planned'), (2,'R','planned'), (1,'Archivé','archived');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
    INSERT INTO project_team (account_id, project_id, person_id) VALUES (1,1,5), (1,1,2), (1,1,1), (1,1,4), (1,1,3), (1,4,1), (2,3,7);
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 6, 1, '2026-03-02', '2026-03-06', 'hours', 8);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /projects/{p}/team", () => {
  it("tout membre lit, quel que soit son rôle ; anonyme : 401", async () => {
    for (const who of ["owner", "admin", "pm", "member", "guest"]) expect((await team(who, "1")).status, who).toBe(200);
    const r = await team("anon", "1");
    expect(r.status).toBe(401);
    expect(err(r).code).toBe("UNAUTHENTICATED");
  });
  it("forme du contrat, tri par identifiant de personne, noms lus dans people, total", async () => {
    const r = await team("member", "1");
    expect(TeamMemberList.safeParse(r.body).success).toBe(true);
    expect(list(r)).toEqual({
      items: [{ personId: "1", name: "alice" }, { personId: "2", name: "bob" }, { personId: "3", name: "carol" }, { personId: "4", name: "dave" }, { personId: "5", name: "eve" }],
      page: { nextCursor: null, total: 5 },
    });
  });
  it("l'équipe n'est pas la liste des personnes allouées (Q-07) : franck est alloué mais absent", async () => {
    expect(list(await team("member", "1")).items.map((m) => m.name)).not.toContain("franck");
  });
  it("équipe vide : 200 et liste vide", async () => {
    expect(list(await team("member", "2"))).toEqual({ items: [], page: { nextCursor: null, total: 0 } });
  });
  it("un projet archivé se lit", async () => expect(list(await team("member", "4")).items.map((m) => m.name)).toEqual(["alice"]));

  describe("isolation entre comptes", () => {
    it.each([["projet d'un autre compte", "3"], ["projet inconnu", "999"], ["identifiant illisible", "abc"], ["séquence % illisible", "%E0%A4%A"]])("%s : 404 entity project", async (_n, project) => {
      const r = await team("member", project);
      expect(r.status).toBe(404);
      expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity: "project" } });
    });
    it("l'autre compte ne voit pas l'équipe du compte A, et lit la sienne", async () => {
      expect((await team("other", "1")).status).toBe(404);
      expect(list(await team("other", "3")).items).toEqual([{ personId: "7", name: "intrus" }]);
    });
  });

  describe("pagination", () => {
    it("parcours complet par pages de 2 : tout, une fois, dans l'ordre ; total stable", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = list(await team("member", "1", `?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
        expect(r.page.total).toBe(5);
        expect(r.items.length).toBeLessThanOrEqual(2);
        seen.push(...r.items.map((m) => m.personId));
        cursor = r.page.nextCursor;
        pages++;
      } while (cursor);
      expect(seen).toEqual(["1", "2", "3", "4", "5"]);
      expect(pages).toBe(3);
    });
    it("page exactement pleine : pas de curseur de trop", async () => {
      const r = list(await team("member", "1", "?limit=5"));
      expect(r.items).toHaveLength(5);
      expect(r.page.nextCursor).toBeNull();
    });
    it("un ajout pendant le parcours ne crée ni doublon ni trou pour ce qui précède", async () => {
      const p1 = list(await team("member", "1", "?limit=2"));
      await pg.exec("INSERT INTO project_team (account_id, project_id, person_id) VALUES (1,1,6)");
      const rest = list(await team("member", "1", `?limit=10&cursor=${p1.page.nextCursor}`));
      expect([...p1.items, ...rest.items].map((m) => m.personId)).toEqual(["1", "2", "3", "4", "5", "6"]);
      await pg.exec("DELETE FROM project_team WHERE project_id = 1 AND person_id = 6");
    });
    it.each([["limit=0"], ["limit=501"], ["limit=abc"], ["limit=1&limit=2"], ["foo=1"], ["cursor="]])("requête invalide (%s) : 400 VALIDATION_FAILED", async (qs) => {
      const r = await team("member", "1", `?${qs}`);
      expect(r.status).toBe(400);
      expect(err(r).code).toBe("VALIDATION_FAILED");
    });
    it.each(["zz", "e30", Buffer.from('{"id":"abc"}').toString("base64url"), Buffer.from("pas du json").toString("base64url")])("curseur illisible %j : 400 SCHEDULE_CURSOR_INVALID", async (cursor) => {
      const r = await team("member", "1", `?cursor=${cursor}`);
      expect(r.status).toBe(400);
      expect(err(r).code).toBe("SCHEDULE_CURSOR_INVALID");
    });
    it("un curseur d'un autre projet ne fuit rien : il ne fait que borner la page", async () => {
      const r = list(await team("member", "2", `?cursor=${Buffer.from('{"id":"3"}').toString("base64url")}`));
      expect(r.items).toEqual([]);
    });
  });

  describe("cohérence avec l'ajout et le retrait d'équipe", () => {
    it("PUT ajoute la personne à la lecture, le retrait l'en enlève", async () => {
      expect((await send("pm", "PUT", "/api/v1/projects/2/team/6")).status).toBe(200);
      expect(list(await team("member", "2")).items).toEqual([{ personId: "6", name: "franck" }]);
      const rm = await send("pm", "POST", "/api/v1/projects/2/team/6/removal", {});
      expect(rm.status).toBe(200);
      expect(list(await team("member", "2")).items).toEqual([]);
    });
  });
});
