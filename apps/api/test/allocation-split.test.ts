// « Cette occurrence » d'une série répétée (BR-25, décision 10 du registre) contre schema.sql réel (PGlite) :
// POST /allocations/{id}/split découpe la série en avant / occurrence / après, en une transaction, sous verrou optimiste.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { AllocationSplitResult, ScheduleAllocation } from "@wnext/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-25 @BR-01 @BR-14
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, version?: number | string) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(version === undefined ? {} : { "if-match": `"${version}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const err = (r: { status: number; body: unknown }) => [r.status, (r.body as { code: string }).code, (r.body as { params: Record<string, unknown> }).params] as const;
type Alloc = ReturnType<typeof ScheduleAllocation.parse>;
const h = (x: number) => ({ mode: "hours", hoursPerDay: x }) as const;

// Série hebdomadaire de 4 occurrences (lundi-mardi) : 02/03, 09/03, 16/03, 23/03 ; fin de série le 24/03.
const weekly = { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-03", load: h(4), repeatState: "weekly", repeatEndDate: "2026-03-24" };
const create = async (body: unknown = weekly): Promise<Alloc> => {
  const r = await send("pm", "POST", "/api/v1/allocations", body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return ScheduleAllocation.parse(r.body);
};
// version null = sans If-Match.
const split = (a: Alloc, body: unknown, who = "pm", version: number | null = a.version) => send(who, "POST", `/api/v1/allocations/${a.id}/split`, body, version ?? undefined);
const ok = async (a: Alloc, body: unknown) => {
  const r = await split(a, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return AllocationSplitResult.parse(r.body);
};
const count = async () => Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM allocations")).rows[0]!.n);
const pick = (a: Alloc | undefined) => a && { startDate: a.startDate, endDate: a.endDate, repeatState: a.repeatState, repeatEndDate: a.repeatEndDate };

// Compte A : personnes 1 hal, 2 bob ; projet 1. Compte B : personne 3, projet 2.
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (1,'bob'), (2,'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P1'), (2,'Q');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);
beforeEach(async () => { await pg.exec("DELETE FROM allocations"); });

describe("POST /allocations/{id}/split : découpe", () => {
  it("occurrence du milieu : la ligne d'origine devient « avant », l'occurrence et « après » sont des lignes nouvelles", async () => {
    const a = await create();
    const r = await ok(a, { occurrenceDate: "2026-03-09" });
    expect(r.before).toMatchObject({ id: a.id, version: a.version + 1 });
    expect(pick(r.before)).toEqual({ startDate: "2026-03-02", endDate: "2026-03-03", repeatState: "weekly", repeatEndDate: "2026-03-08" });
    expect(pick(r.occurrence)).toEqual({ startDate: "2026-03-09", endDate: "2026-03-10", repeatState: "none", repeatEndDate: null });
    expect(pick(r.after)).toEqual({ startDate: "2026-03-16", endDate: "2026-03-17", repeatState: "weekly", repeatEndDate: "2026-03-24" });
    for (const x of [r.occurrence!, r.after!]) {
      expect(x.id).not.toBe(a.id);
      expect(x).toMatchObject({ version: 1, personId: "1", projectId: "1", mode: "hours", hoursPerDay: 4 });
    }
    expect(await count()).toBe(3);
    // Audit : les lignes nouvelles portent l'auteur de la requête.
    const audit = (await pg.query<{ created_by: number; modified_by: number }>("SELECT created_by, modified_by FROM allocations ORDER BY id")).rows;
    expect(audit.every((x) => Number(x.created_by) === 1 && Number(x.modified_by) === 1)).toBe(true);
  });

  it("première occurrence : la ligne d'origine est supprimée (delete_log), pas de « avant »", async () => {
    const a = await create();
    const r = await ok(a, { occurrenceDate: "2026-03-02" });
    expect(r.before).toBeUndefined();
    expect(pick(r.occurrence)).toEqual({ startDate: "2026-03-02", endDate: "2026-03-03", repeatState: "none", repeatEndDate: null });
    expect(pick(r.after)).toEqual({ startDate: "2026-03-09", endDate: "2026-03-10", repeatState: "weekly", repeatEndDate: "2026-03-24" });
    expect((await send("member", "GET", `/api/v1/allocations/${a.id}`)).status).toBe(404);
    expect((await pg.query("SELECT 1 FROM delete_log WHERE entity = 'allocations' AND entity_id = $1", [a.id])).rows).toHaveLength(1);
    expect(await count()).toBe(2);
  });

  it("dernière occurrence (tronquée à la fin de série) : pas de « après »", async () => {
    const a = await create({ ...weekly, repeatEndDate: "2026-03-23" });
    const r = await ok(a, { occurrenceDate: "2026-03-23" });
    expect(pick(r.before)).toEqual({ startDate: "2026-03-02", endDate: "2026-03-03", repeatState: "weekly", repeatEndDate: "2026-03-22" });
    expect(pick(r.occurrence)).toEqual({ startDate: "2026-03-23", endDate: "2026-03-23", repeatState: "none", repeatEndDate: null });
    expect(r.after).toBeUndefined();
    expect(await count()).toBe(2);
  });

  it("série de deux occurrences : chaque index laisse deux lignes", async () => {
    const two = { ...weekly, repeatEndDate: "2026-03-10" };
    const r0 = await ok(await create(two), { occurrenceDate: "2026-03-02" });
    expect([pick(r0.before), pick(r0.occurrence)?.startDate, pick(r0.after)]).toEqual([
      undefined, "2026-03-02", { startDate: "2026-03-09", endDate: "2026-03-10", repeatState: "weekly", repeatEndDate: "2026-03-10" },
    ]);
    await pg.exec("DELETE FROM allocations");
    const r1 = await ok(await create(two), { occurrenceDate: "2026-03-09" });
    expect([pick(r1.before)?.repeatEndDate, pick(r1.occurrence)?.startDate, r1.after]).toEqual(["2026-03-08", "2026-03-09", undefined]);
    expect(await count()).toBe(2);
  });

  it("le groupId de la série est conservé par les morceaux", async () => {
    const g = await send("pm", "POST", "/api/v1/allocation-groups", { ...weekly, personId: undefined, members: [{ personId: "1" }, { personId: "2" }] });
    expect(g.status).toBe(201);
    const first = ScheduleAllocation.parse((g.body as { items: unknown[] }).items[0]);
    const r = await ok(first, { occurrenceDate: "2026-03-09" });
    for (const x of [r.before!, r.occurrence!, r.after!]) expect(x.groupId).toBe(first.groupId);
  });
});

describe("POST /allocations/{id}/split : patch et suppression de l'occurrence", () => {
  it("patch d'heures : seule l'occurrence change", async () => {
    const r = await ok(await create(), { occurrenceDate: "2026-03-16", patch: { load: h(2), name: "atelier" } });
    expect(r.occurrence).toMatchObject({ hoursPerDay: 2, name: "atelier", version: 1 });
    expect([r.before!.hoursPerDay, r.after!.hoursPerDay, r.before!.name]).toEqual([4, 4, null]);
  });

  it("patch de personne et de dates : l'occurrence est déplacée ; la sur-allocation n'est pas refusée (BR-01)", async () => {
    await create({ ...weekly, personId: "2", repeatState: "none", repeatEndDate: null, startDate: "2026-03-11", endDate: "2026-03-11", load: h(8) });
    const r = await ok(await create(), { occurrenceDate: "2026-03-09", patch: { personId: "2", startDate: "2026-03-11", endDate: "2026-03-12", load: h(8) } });
    expect(r.occurrence).toMatchObject({ personId: "2", startDate: "2026-03-11", endDate: "2026-03-12", repeatState: "none", hoursPerDay: 8 });
    expect([r.before!.personId, r.after!.personId]).toEqual(["1", "1"]);
  });

  it("delete : l'occurrence disparaît, avant et après restent", async () => {
    const a = await create();
    const r = await ok(a, { occurrenceDate: "2026-03-16", delete: true });
    expect(r.occurrence).toBeUndefined();
    expect([pick(r.before)?.repeatEndDate, pick(r.after)?.startDate]).toEqual(["2026-03-15", "2026-03-23"]);
    expect(await count()).toBe(2);
  });

  it("delete de la seule occurrence restante côté « avant » : la ligne d'origine est supprimée, seule « après » reste", async () => {
    const r = await ok(await create(), { occurrenceDate: "2026-03-02", delete: true });
    expect([r.before, r.occurrence, pick(r.after)?.startDate]).toEqual([undefined, undefined, "2026-03-09"]);
    expect(await count()).toBe(1);
  });
});

describe("POST /allocations/{id}/split : refus", () => {
  it("corps invalide : 400 VALIDATION_FAILED, rien n'est écrit", async () => {
    const a = await create();
    for (const body of [
      {}, { occurrenceDate: "09/03/2026" }, { occurrenceDate: "2026-03-09", patch: {} }, { occurrenceDate: "2026-03-09", delete: false },
      { occurrenceDate: "2026-03-09", patch: { name: "x" }, delete: true }, { occurrenceDate: "2026-03-09", patch: { repeatState: "daily" } },
      { occurrenceDate: "2026-03-09", patch: { startDate: "2026-03-12", endDate: "2026-03-11" } }, { occurrenceDate: "2026-03-09", inconnu: 1 },
    ]) expect((await split(a, body)).status, JSON.stringify(body)).toBe(400);
    expect(await count()).toBe(1);
  });

  it("version périmée : 409 VERSION_CONFLICT avec la version courante ; If-Match absent : 428", async () => {
    const a = await create();
    expect(err(await split(a, { occurrenceDate: "2026-03-09" }, "pm", a.version + 1))).toEqual([409, "VERSION_CONFLICT", { currentVersion: a.version }]);
    expect(err(await split(a, { occurrenceDate: "2026-03-09" }, "pm", null)).slice(0, 2)).toEqual([428, "PRECONDITION_REQUIRED"]);
    expect(await count()).toBe(1);
  });

  it("allocation non répétée : 409 NOT_A_SERIES", async () => {
    const a = await create({ ...weekly, repeatState: "none", repeatEndDate: null });
    expect(err(await split(a, { occurrenceDate: "2026-03-02" })).slice(0, 2)).toEqual([409, "NOT_A_SERIES"]);
  });

  it("date qui n'est le début d'aucune occurrence : 404 OCCURRENCE_NOT_FOUND", async () => {
    const a = await create();
    for (const d of ["2026-02-23", "2026-03-03", "2026-03-05", "2026-03-30", "2027-03-01"]) {
      expect(err(await split(a, { occurrenceDate: d })), d).toEqual([404, "OCCURRENCE_NOT_FOUND", { occurrenceDate: d }]);
    }
    expect(await count()).toBe(1);
  });

  it("série non découpable : 409 SERIES_SPLIT_UNSUPPORTED (blocs chevauchants, mensuelle ramenée en fin de mois)", async () => {
    const overlapping = await create({ ...weekly, repeatState: "daily", repeatEndDate: "2026-03-10" });
    expect(err(await split(overlapping, { occurrenceDate: "2026-03-04" }))).toEqual([409, "SERIES_SPLIT_UNSUPPORTED", { reason: "overlapping" }]);
    const clamped = await create({ ...weekly, startDate: "2026-01-31", endDate: "2026-01-31", repeatState: "monthly", repeatEndDate: "2026-06-30" });
    expect(err(await split(clamped, { occurrenceDate: "2026-01-31" }))).toEqual([409, "SERIES_SPLIT_UNSUPPORTED", { reason: "monthly_clamped" }]);
    expect(await count()).toBe(2);
  });

  it("référence inconnue ou d'un autre compte dans le patch : 404, la transaction est annulée", async () => {
    const a = await create();
    expect(err(await split(a, { occurrenceDate: "2026-03-09", patch: { personId: "3" } }))).toEqual([404, "NOT_FOUND", { entity: "person" }]);
    expect(err(await split(a, { occurrenceDate: "2026-03-09", patch: { projectId: "abc" } }))).toEqual([404, "NOT_FOUND", { entity: "project" }]);
    expect(await count()).toBe(1);
    expect((await send("member", "GET", `/api/v1/allocations/${a.id}`)).body).toMatchObject({ version: a.version, repeatEndDate: "2026-03-24" });
  });

  it("autre compte : 404 NOT_FOUND (RLS) ; member : 403 avant la validation du corps ; anonyme : 401", async () => {
    const a = await create();
    expect(err(await split(a, { occurrenceDate: "2026-03-09" }, "other"))).toEqual([404, "NOT_FOUND", { entity: "allocation" }]);
    expect(err(await split(a, { occurrenceDate: "2026-03-09" }, "member")).slice(0, 2)).toEqual([403, "FORBIDDEN"]);
    expect((await split(a, {}, "member")).status).toBe(403);
    expect((await split(a, { occurrenceDate: "2026-03-09" }, "anon")).status).toBe(401);
    expect(err(await send("pm", "POST", "/api/v1/allocations/999999/split", { occurrenceDate: "2026-03-09" }, 1))).toEqual([404, "NOT_FOUND", { entity: "allocation" }]);
    expect(await count()).toBe(1);
  });
});

describe("POST /allocations/{id}/split : journal de changements (outbox temps réel)", () => {
  const head = async () => Number((await pg.query<{ s: string }>("SELECT COALESCE(max(seq), 0) AS s FROM change_log WHERE account_id = 1")).rows[0]!.s);
  const since = async (s: number) =>
    (await pg.query<{ entity: string; entity_id: string; op: string; version: number | null }>(
      "SELECT entity, entity_id::text, op, version FROM change_log WHERE account_id = 1 AND seq > $1 ORDER BY seq", [s],
    )).rows.map((x) => [x.entity, x.entity_id, x.op, x.version]);

  it("milieu : update de la série, insert de l'occurrence puis de « après », dans cet ordre", async () => {
    const a = await create();
    const s = await head();
    const r = await ok(a, { occurrenceDate: "2026-03-09" });
    expect(await since(s)).toEqual([
      ["allocations", a.id, "update", a.version + 1],
      ["allocations", r.occurrence!.id, "insert", 1],
      ["allocations", r.after!.id, "insert", 1],
    ]);
  });

  it("première occurrence supprimée : delete de la série puis insert de « après » ; un refus n'écrit rien", async () => {
    const a = await create();
    const s = await head();
    const r = await ok(a, { occurrenceDate: "2026-03-02", delete: true });
    expect(await since(s)).toEqual([["allocations", a.id, "delete", null], ["allocations", r.after!.id, "insert", 1]]);
    const s2 = await head();
    await split(r.after!, { occurrenceDate: "2026-03-16" }, "pm", 99);
    await split(r.after!, { occurrenceDate: "2026-03-17" });
    expect(await since(s2)).toEqual([]);
  });
});
