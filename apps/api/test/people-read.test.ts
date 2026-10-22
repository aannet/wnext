// Lecture des personnes (liste filtrable, par id) et de leurs projets contre schema.sql réel (PGlite).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PersonDetail, PersonList, PersonProjectList, SchedulePerson } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-10 @Q-07
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "2", role: "member" }, // lié à la personne 2 : sa seule personne lisible (RT-048)
  guest: { accountId: "1", userId: "1", role: "guest" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const get = (who: string, url: string) => dispatch(deps, { method: "GET", url, headers: { authorization: who } });
const send = (who: string, method: string, url: string, body?: unknown) => dispatch(deps, { method, url, headers: { authorization: who }, body: body === undefined ? undefined : JSON.stringify(body) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
type PersonPage = { items: { id: string; name: string; active: boolean }[]; page: { nextCursor: string | null; total: number } };
const people = async (who: string, qs = "") => get(who, `/api/v1/people${qs}`);
const names = (r: { body: unknown }) => (r.body as PersonPage).items.map((p) => p.name);

// Compte A. Départements : 1 Design, 2 Dev. Rôles : 1 Senior, 2 Junior.
//  1 Alice (dept 1, rôle 1, tags senior/front) ; 2 Bob (dept 2, rôle 1) ; 3 Carol (désactivée) ; 4 « 50%_Dév » ; 5 ÉLODIE ; 6 Zoé (dept 1, rôle 2)
// Compte B : 7 « Alice B ». Projets A : 1 P1, 2 P2, 3 P3 (archivé), 4 P4 (vide) ; B : 5.
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test'), ('bob@x.test'), ('b@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO departments (account_id, name) VALUES (1,'Design'), (1,'Dev');
    INSERT INTO roles (account_id, name) VALUES (1,'Senior'), (1,'Junior');
    INSERT INTO people (account_id, name, department_id, role_id, tags, active) VALUES
      (1,'Alice',1,1,'{senior,front}',true), (1,'Bob',2,1,'{}',true), (1,'Carol',NULL,NULL,'{}',false),
      (1,'50%_Dév',NULL,NULL,'{}',true), (1,'ÉLODIE',NULL,NULL,'{}',true), (1,'Zoé',1,2,'{front}',true), (2,'Alice B',NULL,NULL,'{}',true);
    INSERT INTO projects (account_id, name, status) VALUES (1,'P1','planned'), (1,'P2','planned'), (1,'P3','archived'), (1,'P4','planned'), (2,'Q','planned');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    -- RT-040 : Bob (2) a un accès dans A (utilisateur 2) ; Alice B (7) dans B (utilisateur 3).
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (1, 2, 'member', 2), (2, 3, 'member', 7);
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
    INSERT INTO project_team (account_id, project_id, person_id) VALUES (1,1,1), (1,3,1), (1,4,2);
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES
      (1,1,1,'2026-03-02','2026-03-03','hours',8), (1,1,1,'2026-03-09','2026-03-10','hours',8), (1,1,2,'2026-03-02','2026-03-06','hours',4),
      (1,2,1,'2026-03-02','2026-03-06','hours',8), (1,3,2,'2026-03-02','2026-03-06','hours',2);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /people", () => {
  it("tout membre lit, y compris un guest ; anonyme : 401", async () => {
    for (const who of ["owner", "pm", "member", "guest"]) expect((await people(who)).status, who).toBe(200);
    expect((await people("anon")).status).toBe(401);
  });
  it("forme du contrat ; désactivées exclues par défaut ; tri par id ; total", async () => {
    const r = await people("guest");
    expect(PersonList.safeParse(r.body).success).toBe(true);
    expect(names(r)).toEqual(["Alice", "Bob", "50%_Dév", "ÉLODIE", "Zoé"]);
    expect((r.body as PersonPage).page.total).toBe(5);
    for (const p of (r.body as PersonPage).items) expect(Object.keys(SchedulePerson.parse(p)).sort()).toEqual(Object.keys(p).sort()); // ni plus, ni moins : aucune fuite
  });
  it("includeInactive=true inclut les désactivées", async () => {
    const r = await people("guest", "?includeInactive=true");
    expect(names(r)).toContain("Carol");
    expect((r.body as PersonPage).page.total).toBe(6);
    expect(names(await people("guest", "?includeInactive=false"))).not.toContain("Carol");
  });
  it("identique à GET /schedule pour les mêmes personnes", async () => {
    const byId = (a: { id: string }, b: { id: string }) => Number(a.id) - Number(b.id); // le Schedule trie par nom, la liste par id
    const sched = (await get("guest", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as { people: { id: string }[] };
    expect((await people("guest")).body).toMatchObject({ items: [...sched.people].sort(byId) });
  });

  describe("filtres", () => {
    it("département, rôle, tag, et leurs combinaisons (ET)", async () => {
      expect(names(await people("guest", "?departmentId=1"))).toEqual(["Alice", "Zoé"]);
      expect(names(await people("guest", "?roleId=1"))).toEqual(["Alice", "Bob"]);
      expect(names(await people("guest", "?tag=front"))).toEqual(["Alice", "Zoé"]);
      expect(names(await people("guest", "?departmentId=1&roleId=1&tag=front"))).toEqual(["Alice"]);
      expect(names(await people("guest", "?tag=inexistant"))).toEqual([]);
    });
    it("search : sous-chaîne sans tenir compte de la casse", async () => {
      expect(names(await people("guest", "?search=ALI"))).toEqual(["Alice"]);
      expect(names(await people("guest", "?search=lice"))).toEqual(["Alice"]);
      expect(names(await people("guest", "?search=%C3%A9lodie"))).toEqual(["ÉLODIE"]); // é/É : la casse Unicode est ignorée
    });
    it("search : % et _ sont des caractères, pas des jokers", async () => {
      expect(names(await people("guest", "?search=%25"))).toEqual(["50%_Dév"]);
      expect(names(await people("guest", "?search=_"))).toEqual(["50%_Dév"]);
      expect(names(await people("guest", "?search=%25_D"))).toEqual(["50%_Dév"]);
      expect(names(await people("guest", "?search=%5C"))).toEqual([]); // le backslash n'est pas un joker non plus
    });
    it("search et injection : traité comme du texte", async () => {
      expect(names(await people("guest", `?search=${encodeURIComponent("'; DROP TABLE people; --")}`))).toEqual([]);
      expect(await pg.query("SELECT count(*) FROM people")).toBeTruthy();
    });
    it("search avec inactives : suit includeInactive", async () => {
      expect(names(await people("guest", "?search=carol"))).toEqual([]);
      expect(names(await people("guest", "?search=carol&includeInactive=true"))).toEqual(["Carol"]);
    });
    it.each([["departmentId=abc", "departmentId"], ["roleId=1;2", "roleId"], ["includeInactive=oui", "includeInactive"], ["search=", "search"], ["search=%20%20", "search"], ["tag=", "tag"], ["foo=1", "foo"], ["limit=0", "limit"], ["departmentId=1&departmentId=2", "departmentId"]])("requête invalide %s : 400", async (qs, field) => {
      const r = await people("guest", `?${qs}`);
      expect(r.status).toBe(400);
      expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
    });
  });

  describe("isolation entre comptes", () => {
    it("l'autre compte ne voit que ses personnes, même en cherchant « alice »", async () => {
      expect(names(await people("other"))).toEqual(["Alice B"]);
      expect(names(await people("other", "?search=alice"))).toEqual(["Alice B"]);
      expect(names(await people("guest", "?search=alice"))).toEqual(["Alice"]);
      expect(names(await people("other", "?departmentId=1"))).toEqual([]); // le département du compte A ne révèle rien
    });
  });

  describe("pagination", () => {
    it("parcours par pages de 2 : tout, une fois, dans l'ordre ; total stable", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r = (await people("guest", `?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body as PersonPage;
        expect(r.page.total).toBe(5);
        seen.push(...r.items.map((p) => p.name));
        cursor = r.page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["Alice", "Bob", "50%_Dév", "ÉLODIE", "Zoé"]);
    });
    it("le curseur garde les filtres de la requête qui le suit", async () => {
      const p1 = (await people("guest", "?limit=1&tag=front")).body as PersonPage;
      const p2 = await people("guest", `?limit=1&tag=front&cursor=${p1.page.nextCursor}`);
      expect(names(p2)).toEqual(["Zoé"]);
      expect((p2.body as PersonPage).page.nextCursor).toBeNull();
    });
    it.each(["zz", Buffer.from('{"id":"x"}').toString("base64url")])("curseur illisible %j : 400 SCHEDULE_CURSOR_INVALID", async (c) => {
      expect(err(await people("guest", `?cursor=${c}`)).code).toBe("SCHEDULE_CURSOR_INVALID");
    });
  });
});

describe("GET /people/{id}", () => {
  it("une personne avec sa version ; une désactivée se lit aussi", async () => {
    const a = await get("guest", "/api/v1/people/1");
    expect(SchedulePerson.parse(a.body)).toMatchObject({ id: "1", name: "Alice", version: 1, departmentId: "1", tags: ["senior", "front"], active: true });
    expect(SchedulePerson.parse((await get("guest", "/api/v1/people/3")).body)).toMatchObject({ name: "Carol", active: false });
  });
  it("la version suit une modification (relire après un VERSION_CONFLICT)", async () => {
    await send("pm", "PATCH", "/api/v1/people/2", { tags: ["x"] }).then(() => undefined);
    const patch = await dispatch(deps, { method: "PATCH", url: "/api/v1/people/2", headers: { authorization: "pm", "if-match": '"1"' }, body: JSON.stringify({ tags: ["x"] }) });
    expect(patch.status).toBe(200);
    expect(SchedulePerson.parse((await get("guest", "/api/v1/people/2")).body)).toMatchObject({ version: 2, tags: ["x"] });
  });
  it.each([["autre compte", "7"], ["inconnue", "999"], ["illisible", "abc"], ["séquence %", "%E0%A4%A"]])("%s : 404 entity person", async (_n, id) => {
    const r = await get("guest", `/api/v1/people/${id}`);
    expect(r.status).toBe(404);
    expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity: "person" } });
  });
  it("401 sans identité", async () => expect((await get("anon", "/api/v1/people/1")).status).toBe(401));
});

// RT-040 : `access` (PersonDetail) dit si un utilisateur du compte est lié à la personne (account_members.person_id).
describe("access (RT-040)", () => {
  type Item = { id: string; access?: string };
  const items = async (who: string, qs = "") => ((await people(who, qs)).body as { items: Item[] }).items;
  const accessById = (list: Item[]) => Object.fromEntries(list.map((p) => [p.id, p.access]));
  it("owner, admin et project_manager : member si une ligne account_members la lie, none sinon", async () => {
    for (const who of ["owner", "pm"]) {
      const r = await people(who, "?includeInactive=true");
      expect(PersonDetail.array().parse((r.body as PersonPage).items)).toHaveLength(6);
      expect(accessById(await items(who, "?includeInactive=true")), who).toEqual({ 1: "none", 2: "member", 3: "none", 4: "none", 5: "none", 6: "none" });
      expect((await get(who, "/api/v1/people/2")).body, who).toMatchObject({ id: "2", access: "member" });
      expect((await get(who, "/api/v1/people/3")).body, who).toMatchObject({ id: "3", access: "none" });
    }
  });
  it("member et guest : la clé est absente (liste et lecture par id)", async () => {
    for (const who of ["member", "guest"]) {
      for (const p of await items(who)) expect(Object.keys(p), who).not.toContain("access");
      expect(Object.keys((await get(who, "/api/v1/people/2")).body as object), who).not.toContain("access");
    }
  });
  it("isolation entre comptes : chaque compte ne voit que ses propres liens", async () => {
    expect(accessById(await items("other"))).toEqual({ 7: "member" });
    await pg.exec("UPDATE account_members SET person_id = NULL WHERE account_id = 2");
    try {
      expect(accessById(await items("other"))).toEqual({ 7: "none" });
      expect(accessById(await items("owner"))[2]).toBe("member"); // le lien de A ne dépend pas de B
    } finally {
      await pg.exec("UPDATE account_members SET person_id = 7 WHERE account_id = 2");
    }
  });
  it("PATCH renvoie access ; GET /schedule ne le porte jamais", async () => {
    const cur = (await get("owner", "/api/v1/people/2")).body as { version: number };
    const r = await dispatch(deps, { method: "PATCH", url: "/api/v1/people/2", headers: { authorization: "owner", "if-match": `"${cur.version}"` }, body: JSON.stringify({ tags: ["acces"] }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "2", access: "member" });
    const sched = (await get("owner", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body as { people: object[] };
    for (const p of sched.people) expect(Object.keys(p)).not.toContain("access");
  });
});

describe("GET /people/{id}/projects", () => {
  type Page = { items: { project: { id: string; name: string; status: string }; inTeam: boolean; allocationCount: number }[]; page: { nextCursor: string | null; total: number } };
  const projects = (who: string, id: string, qs = "") => get(who, `/api/v1/people/${id}/projects${qs}`);
  const summary = (r: { body: unknown }) => (r.body as Page).items.map((i) => [i.project.name, i.inTeam, i.allocationCount]);

  it("équipe OU allocations : l'équipe n'est pas exigée pour allouer (Q-07) ; compte des lignes d'allocation", async () => {
    const r = await projects("guest", "1");
    expect(PersonProjectList.safeParse(r.body).success).toBe(true);
    // P1 : équipe + 2 allocations ; P2 : 1 allocation hors équipe ; P3 archivé exclu ; P4 sans lien
    expect(summary(r)).toEqual([["P1", true, 2], ["P2", false, 1]]);
    expect((r.body as Page).page.total).toBe(2);
  });
  it("équipe sans allocation (P4 pour Bob) et allocation sans équipe (P1 pour Bob) apparaissent", async () => {
    expect(summary(await projects("guest", "2"))).toEqual([["P1", false, 1], ["P4", true, 0]]);
  });
  it("archivés exclus par défaut, listés avec status=archived ; autre statut filtré", async () => {
    expect(summary(await projects("guest", "1", "?status=archived"))).toEqual([["P3", true, 0]]);
    expect(summary(await projects("guest", "1", "?status=planned"))).toEqual([["P1", true, 2], ["P2", false, 1]]);
    expect(summary(await projects("guest", "1", "?status=on_hold"))).toEqual([]);
  });
  it("personne sans projet : liste vide ; personne désactivée : garde ses projets", async () => {
    expect((await projects("guest", "5")).body).toEqual({ items: [], page: { nextCursor: null, total: 0 } });
    expect(summary(await projects("guest", "3"))).toEqual([["P2", false, 1]]);
  });
  it("pagination par projet, total stable, pas de doublon", async () => {
    const p1 = (await projects("guest", "1", "?limit=1")).body as Page;
    expect(p1.items.map((i) => i.project.name)).toEqual(["P1"]);
    expect(p1.page.total).toBe(2);
    const p2 = (await projects("guest", "1", `?limit=1&cursor=${p1.page.nextCursor}`)).body as Page;
    expect(p2.items.map((i) => i.project.name)).toEqual(["P2"]);
    expect(p2.page.nextCursor).toBeNull();
  });
  it("personne inconnue, d'un autre compte ou illisible : 404 ; autre compte ne voit rien des projets du compte A", async () => {
    for (const id of ["999", "7", "abc"]) {
      const r = await projects("guest", id);
      expect(r.status, id).toBe(404);
      expect(err(r).params.entity).toBe("person");
    }
    expect((await projects("other", "1")).status).toBe(404);
    expect((await projects("other", "7")).body).toEqual({ items: [], page: { nextCursor: null, total: 0 } });
  });
  it.each([["status=active", "status"], ["foo=1", "foo"], ["limit=501", "limit"]])("requête invalide %s : 400", async (qs, field) => {
    const r = await projects("guest", "1", `?${qs}`);
    expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
  });
  it("cursor illisible : 400 SCHEDULE_CURSOR_INVALID ; 401 sans identité", async () => {
    expect(err(await projects("guest", "1", "?cursor=zz")).code).toBe("SCHEDULE_CURSOR_INVALID");
    expect((await projects("anon", "1")).status).toBe(401);
  });
  it("suit l'équipe : ajout puis retrait avec confirmation font apparaître puis disparaître le projet", async () => {
    expect((await send("pm", "PUT", "/api/v1/projects/4/team/5")).status).toBe(200);
    expect(summary(await projects("guest", "5"))).toEqual([["P4", true, 0]]);
    expect((await send("pm", "POST", "/api/v1/projects/4/team/5/removal", {})).status).toBe(200);
    expect(summary(await projects("guest", "5"))).toEqual([]);
  });
});
