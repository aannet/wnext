// Lecture des allocations d'une personne sur une fenêtre contre schema.sql réel (PGlite).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PersonAllocationList } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-01 @BR-25
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  guest: { accountId: "1", userId: "1", role: "guest" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const get = (who: string, url: string) => dispatch(deps, { method: "GET", url, headers: { authorization: who } });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
type Page = { items: { id: string; personId: string; status: string; repeatState: string }[]; page: { nextCursor: string | null; total: number } };
const W = "from=2026-03-02&to=2026-03-06";
const list = (who: string, person: string, qs = W) => get(who, `/api/v1/people/${person}/allocations?${qs}`);
const ids = (r: { body: unknown }) => (r.body as Page).items.map((a) => a.id);

// Personnes A : 1 alice, 2 bob, 3 carol (désactivée) ; B : 4. Projets A : 1 P1, 2 P2, 3 archivé ; B : 4 R.
// Allocations (id = ordre d'insertion), fenêtre W = 2026-03-02..2026-03-06 :
//  1 P1 alice 03-02..03-04 confirmée (dedans)            2 P1 bob 03-06..03-10 provisoire % (chevauche la fin)
//  3 P1 alice 02-23..03-01 (finit la veille : dehors)     4 P1 carol 03-04 (désactivée : dedans)
//  5 P1 alice 02-02 + série quotidienne jusqu'au 03-31 (dedans par la série, renvoyée UNE fois)
//  6 P1 bob 03-07..03-09 (commence le lendemain : dehors) 7 P2 bob 03-02..03-06 (autre projet) 8 P1 alice 03-06 (borne haute incluse)
//  9 archivé P3 alice 03-03 ; 10 compte B sur R.
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name, active) VALUES (1,'alice',true), (1,'bob',true), (1,'carol',false), (2,'intrus',true);
    INSERT INTO projects (account_id, name, status) VALUES (1,'P1','planned'), (1,'P2','planned'), (1,'P3','archived'), (2,'R','planned');
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, percent, status, repeat_state, repeat_end_date) VALUES
      (1,1,1,'2026-03-02','2026-03-04','hours',8,NULL,'confirmed','none',NULL),
      (1,2,1,'2026-03-06','2026-03-10','percentage',NULL,50,'tentative','none',NULL),
      (1,1,1,'2026-02-23','2026-03-01','hours',8,NULL,'confirmed','none',NULL),
      (1,3,1,'2026-03-04','2026-03-04','hours',4,NULL,'confirmed','none',NULL),
      (1,1,1,'2026-02-02','2026-02-02','hours',2,NULL,'confirmed','daily','2026-03-31'),
      (1,2,1,'2026-03-07','2026-03-09','hours',8,NULL,'confirmed','none',NULL),
      (1,2,2,'2026-03-02','2026-03-06','hours',8,NULL,'confirmed','none',NULL),
      (1,1,1,'2026-03-06','2026-03-06','hours',1,NULL,'confirmed','none',NULL),
      (1,1,3,'2026-03-03','2026-03-03','hours',1,NULL,'confirmed','none',NULL),
      (2,4,4,'2026-03-03','2026-03-03','hours',1,NULL,'confirmed','none',NULL);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /people/{id}/allocations", () => {
  it("owner, pm et guest lisent ; member sans personne liée : 404 (RT-048) ; anonyme : 401 avant la validation", async () => {
    for (const who of ["owner", "pm", "guest"]) expect((await list(who, "1")).status, who).toBe(200);
    expect((await list("member", "1")).status).toBe(404);
    expect((await list("anon", "1")).status).toBe(401);
    expect((await list("anon", "1", "from=pas-une-date")).status).toBe(401);
  });
  it("chevauchement : bornes incluses, série prolongée, une ligne par série, tous projets (archivé compris)", async () => {
    const r = await list("guest", "1");
    expect(PersonAllocationList.safeParse(r.body).success).toBe(true);
    expect(ids(r)).toEqual(["1", "5", "8", "9"]);
    expect((r.body as Page).page.total).toBe(4);
  });
  it("seulement cette personne ; une désactivée se lit ; le total suit", async () => {
    expect(ids(await list("guest", "2"))).toEqual(["2", "7"]);
    expect(ids(await list("guest", "3"))).toEqual(["4"]);
  });
  it("mêmes données que GET /schedule", async () => {
    const sched = (await get("guest", `/api/v1/schedule?${W}&includeInactive=true`)).body as { allocations: { id: string; personId: string }[] };
    const expected = sched.allocations.filter((a) => a.personId === "1").sort((a, b) => Number(a.id) - Number(b.id));
    expect((await list("guest", "1")).body).toMatchObject({ items: expected });
  });
  it("fenêtre vide et fenêtre d'un jour aux extrémités", async () => {
    expect((await list("guest", "1", "from=2027-01-01&to=2027-01-31")).body).toEqual({ items: [], page: { nextCursor: null, total: 0 } });
    expect(ids(await list("guest", "1", "from=2026-03-01&to=2026-03-01"))).toEqual(["3", "5"]);
  });

  describe("filtres", () => {
    it("projet", async () => {
      expect(ids(await list("guest", "1", `${W}&projectId=1`))).toEqual(["1", "5", "8"]);
      expect(ids(await list("guest", "1", `${W}&projectId=3`))).toEqual(["9"]);
      expect(ids(await list("guest", "1", `${W}&projectId=999`))).toEqual([]);
      expect(ids(await list("guest", "1", `${W}&projectId=4`))).toEqual([]); // le projet d'un autre compte ne révèle rien
    });
    it("statut, et total qui suit les filtres", async () => {
      expect(ids(await list("guest", "2", `${W}&status=tentative`))).toEqual(["2"]);
      expect(ids(await list("guest", "2", `${W}&status=confirmed`))).toEqual(["7"]);
      expect(((await list("guest", "1", `${W}&projectId=1`)).body as Page).page.total).toBe(3);
    });
  });

  describe("validation", () => {
    it.each([["sans fenêtre", "", "from"], ["from seul", "from=2026-03-02", "to"], ["date illisible", "from=demain&to=2026-03-06", "from"], ["projectId illisible", `${W}&projectId=abc`, "projectId"],
      ["statut inconnu", `${W}&status=draft`, "status"], ["paramètre inconnu", `${W}&foo=1`, "foo"], ["paramètre répété", `${W}&projectId=1&projectId=2`, "projectId"], ["limit nul", `${W}&limit=0`, "limit"]])("%s : 400 VALIDATION_FAILED", async (_n, qs, field) => {
      const r = await list("guest", "1", qs);
      expect(r.status).toBe(400);
      expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
    });
    it("fenêtre inversée ou de plus de 400 jours : 400 SCHEDULE_RANGE_INVALID ; 400 jours exactement passe", async () => {
      for (const qs of ["from=2026-03-06&to=2026-03-02", "from=2026-01-01&to=2027-03-01"]) {
        const r = await list("guest", "1", qs);
        expect(r.status, qs).toBe(400);
        expect(err(r).code).toBe("SCHEDULE_RANGE_INVALID");
      }
      expect((await list("guest", "1", "from=2026-01-01&to=2027-02-05")).status).toBe(200);
    });
    it("curseur illisible : 400 SCHEDULE_CURSOR_INVALID", async () => {
      expect(err(await list("guest", "1", `${W}&cursor=zz`)).code).toBe("SCHEDULE_CURSOR_INVALID");
    });
  });

  describe("personne introuvable : 404 entity person", () => {
    it.each([["personne d'un autre compte", "4"], ["inconnue", "999"], ["illisible", "abc"], ["séquence % illisible", "%E0%A4%A"]])("%s", async (_n, person) => {
      const r = await list("guest", person);
      expect(r.status).toBe(404);
      expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity: "person" } });
    });
    it("l'autre compte ne lit pas la personne du compte A, et lit la sienne", async () => {
      expect((await list("other", "1")).status).toBe(404);
      expect(ids(await list("other", "4"))).toEqual(["10"]);
    });
  });

  describe("pagination", () => {
    it("parcours par pages de 2 : tout, une fois, dans l'ordre ; total stable", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r = (await list("guest", "1", `${W}&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body as Page;
        expect(r.page.total).toBe(4);
        seen.push(...r.items.map((a) => a.id));
        cursor = r.page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["1", "5", "8", "9"]);
    });
    it("page exactement pleine : pas de curseur de trop", async () => {
      const r = (await list("guest", "1", `${W}&limit=4`)).body as Page;
      expect(r.items).toHaveLength(4);
      expect(r.page.nextCursor).toBeNull();
    });
    it("une allocation ajoutée pendant le parcours apparaît sans doublon ni trou", async () => {
      const p1 = (await list("guest", "1", `${W}&limit=2`)).body as Page;
      await pg.exec("INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1,1,2,'2026-03-03','2026-03-03','hours',1)");
      const rest = (await list("guest", "1", `${W}&limit=10&cursor=${p1.page.nextCursor}`)).body as Page;
      expect([...p1.items, ...rest.items].map((a) => a.id)).toEqual(["1", "5", "8", "9", "11"]);
      await pg.exec("DELETE FROM allocations WHERE id = 11");
    });
  });
});
