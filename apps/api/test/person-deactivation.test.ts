// Désactivation d'une personne (BR-31) contre schema.sql réel (PGlite) : récapitulatif sans écriture, garde de confirmation,
// réaffectation / suppression des allocations futures, remplaçant validé, isolation, rôles.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersonDeactivationResult, PersonDeactivationSummary } from "@wnext/contracts";
import { deactivatePerson, dispatch, getPersonDeactivationSummary, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-31 @BR-04 @BR-01
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
const AS_OF = "2026-06-01";
const summary = (id: string, who = "admin", q = `?asOf=${AS_OF}`) => send(who, "GET", `/api/v1/people/${id}/deactivation-summary${q}`);
const deactivate = (id: string, body?: unknown, who = "admin") => send(who, "POST", `/api/v1/people/${id}/deactivation`, body);
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
const confirm2 = { allocationCount: 3 };

// Personnes : 1 hal (3 allocations futures), 2 eve (remplaçante), 3 vide, 4 inactive, 5 intrus (compte B).
// Allocations de hal : passée (fin 2026-05-29), commencée et en cours (fin 2026-06-02), future sur Q, série dont la fin de série est future.
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name, active) VALUES (1,'hal',true), (1,'eve',true), (1,'vide',true), (1,'inactive',false), (2,'intrus',true), (1,'gwen',true), (1,'ian',true), (1,'zoe',true);
    INSERT INTO projects (account_id, name) VALUES (1,'P'), (1,'Q'), (2,'R');
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, repeat_state, repeat_end_date) VALUES
      (1,1,1,'2026-05-25','2026-05-29','hours',8,'none',NULL),
      (1,1,1,'2026-06-01','2026-06-02','hours',8,'none',NULL),
      (1,1,2,'2026-09-07','2026-09-08','hours',4,'none',NULL),
      (1,1,1,'2026-01-05','2026-01-06','hours',2,'weekly','2026-07-31'),
      (1,2,1,'2026-06-08','2026-06-09','hours',8,'none',NULL),
      (1,4,1,'2026-06-08','2026-06-09','hours',8,'none',NULL);
    -- BR-26 : gwen (6) et ian (7) ont chacun une ligne du groupe 1111… ; gwen a aussi une ligne hors groupe.
    INSERT INTO allocations (account_id, person_id, project_id, group_id, start_date, end_date, mode, hours_per_day, repeat_state) VALUES
      (1,6,1,'11111111-1111-4111-8111-111111111111','2026-09-07','2026-09-08','hours',4,'none'),
      (1,7,1,'11111111-1111-4111-8111-111111111111','2026-09-07','2026-09-08','hours',4,'none');
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, repeat_state) VALUES
      (1,6,2,'2026-10-05','2026-10-06','hours',4,'none');
    INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1,1,1,'2026-05-26',8);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET .../deactivation-summary", () => {
  it("compte les allocations dont la fin effective (série comprise) est >= asOf, pas le passé", async () => {
    const r = await summary("1");
    expect(r.status).toBe(200);
    expect(PersonDeactivationSummary.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual({ alreadyInactive: false, asOf: AS_OF, allocationCount: 3, projectCount: 2, firstAllocation: "2026-01-05", lastAllocation: "2026-09-08" });
  });

  it("sans allocation future : zéros et dates nulles ; asOf par défaut = aujourd'hui", async () => {
    expect((await summary("3")).body).toMatchObject({ allocationCount: 0, projectCount: 0, firstAllocation: null, lastAllocation: null });
    expect((await summary("3", "admin", "")).body).toMatchObject({ asOf: new Date().toISOString().slice(0, 10) });
  });

  it("personne déjà désactivée : alreadyInactive", async () => {
    expect((await summary("4")).body).toMatchObject({ alreadyInactive: true, allocationCount: 1 });
  });

  it("n'écrit rien", async () => {
    const before = [await n("SELECT count(*) AS n FROM allocations"), await n("SELECT count(*) AS n FROM people WHERE active")];
    await summary("1");
    expect([await n("SELECT count(*) AS n FROM allocations"), await n("SELECT count(*) AS n FROM people WHERE active")]).toEqual(before);
  });

  it("404 (inconnue, autre compte, non numérique), 400 asOf invalide, 403 member, 401 anonyme", async () => {
    expect((await summary("999")).status).toBe(404);
    expect((await summary("5")).status).toBe(404);
    expect((await summary("abc")).status).toBe(404);
    expect((await summary("1", "admin", "?asOf=nope")).status).toBe(400);
    expect((await summary("1", "member")).status).toBe(403);
    expect((await summary("1", "anon")).status).toBe(401);
    await expect(getPersonDeactivationSummary(db, roles.member!, "1", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("POST .../deactivation", () => {
  it("allocations futures sans confirmation : 428 avec le récapitulatif, rien changé", async () => {
    const r = await deactivate("1", { asOf: AS_OF });
    expect(r.status).toBe(428);
    expect(err(r)).toMatchObject({ code: "PERSON_DEACTIVATION_CONFIRMATION_REQUIRED", params: { allocationCount: 3, projectCount: 2, firstAllocation: "2026-01-05", lastAllocation: "2026-09-08" } });
    const noDisposition = await deactivate("1", { asOf: AS_OF, confirmation: confirm2 });
    expect(err(noDisposition).code).toBe("PERSON_DEACTIVATION_CONFIRMATION_REQUIRED");
    expect(await n("SELECT count(*) AS n FROM people WHERE id = 1 AND active")).toBe(1);
  });

  it("confirmation périmée : 409 avec le nouveau récapitulatif", async () => {
    const r = await deactivate("1", { asOf: AS_OF, disposition: "delete", confirmation: { allocationCount: 2 } });
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "PERSON_DEACTIVATION_STALE_CONFIRMATION", params: { allocationCount: 3 } });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1")).toBe(4);
  });

  it("400 : reassign sans replacementId, delete avec replacementId, corps illisible", async () => {
    expect((await deactivate("1", { disposition: "reassign", confirmation: confirm2 })).status).toBe(400);
    expect((await deactivate("1", { disposition: "delete", replacementId: "2", confirmation: confirm2 })).status).toBe(400);
    expect((await deactivate("1", { replacementId: "2" })).status).toBe(400);
    expect((await send("admin", "POST", "/api/v1/people/1/deactivation", undefined, "{x")).status).toBe(400);
  });

  it("remplaçant : inconnu ou d'un autre compte 404, soi-même ou désactivé 409 ; rien changé", async () => {
    const base = { asOf: AS_OF, disposition: "reassign", confirmation: confirm2 };
    expect(err(await deactivate("1", { ...base, replacementId: "999" })).params).toEqual({ entity: "person", replacementId: "999" });
    expect((await deactivate("1", { ...base, replacementId: "5" })).status).toBe(404);
    expect(err(await deactivate("1", { ...base, replacementId: "1" }))).toMatchObject({ code: "PERSON_DEACTIVATION_INVALID_REPLACEMENT", params: { reason: "same_person" } });
    expect(err(await deactivate("1", { ...base, replacementId: "4" }))).toMatchObject({ code: "PERSON_DEACTIVATION_INVALID_REPLACEMENT", params: { reason: "inactive" } });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1")).toBe(4);
    expect(await n("SELECT count(*) AS n FROM people WHERE id = 1 AND active")).toBe(1);
  });

  it("BR-26 : remplaçant déjà membre du groupe d'une allocation à réaffecter -> 409 already_in_group, rien changé", async () => {
    const r = await deactivate("6", { asOf: AS_OF, disposition: "reassign", replacementId: "7", confirmation: { allocationCount: 2 } });
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "PERSON_DEACTIVATION_INVALID_REPLACEMENT", params: { reason: "already_in_group", conflictingAllocations: 1 } });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 6")).toBe(2);
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 7")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM people WHERE id = 6 AND active")).toBe(1);
  });

  it("BR-26 : avec un remplaçant hors du groupe la réaffectation passe, le group_id est conservé", async () => {
    const r = await deactivate("6", { asOf: AS_OF, disposition: "reassign", replacementId: "8", confirmation: { allocationCount: 2 } });
    expect(r.status).toBe(200);
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 8 AND group_id = '11111111-1111-4111-8111-111111111111'")).toBe(1);
  });

  it("rôles : member 403 (même corps invalide), anonyme 401, autre compte 404", async () => {
    expect((await deactivate("1", { disposition: 1 }, "member")).status).toBe(403);
    expect((await deactivate("1", {}, "anon")).status).toBe(401);
    expect((await deactivate("1", { asOf: AS_OF, disposition: "delete", confirmation: confirm2 }, "other")).status).toBe(404);
    await expect(deactivatePerson(db, roles.member!, "1", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 1")).toBe(4);
  });

  it("reassign : les 3 lignes futures passent au remplaçant, le passé et les temps restent, la personne est désactivée", async () => {
    const r = await deactivate("1", { asOf: AS_OF, disposition: "reassign", replacementId: "2", confirmation: confirm2 }, "pm");
    expect(r.status).toBe(200);
    expect(PersonDeactivationResult.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ person: { id: "1", active: false }, reassignedAllocations: 3, deletedAllocations: 0 });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 2")).toBe(4);
    expect((await pg.query<{ end_date: string }>("SELECT end_date::text FROM allocations WHERE person_id = 1")).rows).toEqual([{ end_date: "2026-05-29" }]);
    expect(await n("SELECT count(*) AS n FROM logged_time WHERE person_id = 1")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM people WHERE id = 1 AND NOT active")).toBe(1);
  });

  it("delete sur une personne déjà désactivée : supprime ses allocations futures, garde le passé", async () => {
    const r = await deactivate("4", { asOf: AS_OF, disposition: "delete", confirmation: { allocationCount: 1 } });
    expect(r.body).toMatchObject({ person: { id: "4", active: false }, reassignedAllocations: 0, deletedAllocations: 1 });
    expect(await n("SELECT count(*) AS n FROM allocations WHERE person_id = 4")).toBe(0);
  });

  it("sans allocation future : désactive sans confirmation ; rejouer ne change rien (version stable)", async () => {
    const first = await deactivate("3", { asOf: AS_OF });
    expect(first.body).toMatchObject({ person: { id: "3", active: false }, reassignedAllocations: 0, deletedAllocations: 0 });
    const v = (first.body as any).person.version;
    const again = await deactivate("3", { asOf: AS_OF });
    expect(again.status).toBe(200);
    expect((again.body as any).person.version).toBe(v);
  });

  it("404 personne inconnue", async () => {
    expect((await deactivate("999", {})).status).toBe(404);
  });
});
