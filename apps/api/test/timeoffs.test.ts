// Écriture des congés contre schema.sql réel (PGlite) : contrat, verrou optimiste, rôles, isolation, chevauchement, BR-04, journal.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScheduleResponse, ScheduleTimeoff } from "@wnext/contracts";
import { createTimeoff, deleteTimeoff, dispatch, readChanges, updateTimeoff, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-04 @BR-14
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  admin: { accountId: "1", userId: "1", role: "admin" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  guest: { accountId: "1", userId: "1", role: "guest" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };

const send = (who: string, method: string, url: string, opts: { body?: unknown; ifMatch?: string; raw?: string } = {}) =>
  dispatch(deps, {
    method, url,
    headers: { authorization: who, ...(opts.ifMatch !== undefined && { "if-match": opts.ifMatch }) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });

// Chaque test prend sa propre quinzaine : les congés d'une même personne ne se chevauchent pas d'un test à l'autre.
let slot = 0;
const week = () => {
  const start = new Date(Date.UTC(2026, 5, 1 + 14 * slot++));
  const at = (n: number) => new Date(start.getTime() + n * 86400000).toISOString().slice(0, 10);
  return { mon: at(0), tue: at(1), wed: at(2), thu: at(3), fri: at(4) };
};
const create = (body: Record<string, unknown>, who = "admin") => send(who, "POST", "/api/v1/timeoffs", { body });
const base = (w = week()) => ({ personId: "1", typeId: "1", startDate: w.mon, endDate: w.fri });
const made = async (extra: Record<string, unknown> = {}, w = week()) => (await create({ ...base(w), ...extra })).body as any;
const ifm = (v: number | string) => (typeof v === "number" ? `"${v}"` : v);
const patch = (id: string, v: number | string, body: unknown, who = "admin") => send(who, "PATCH", `/api/v1/timeoffs/${id}`, { body, ifMatch: ifm(v) });
const del = (id: string, v: number | string, who = "admin") => send(who, "DELETE", `/api/v1/timeoffs/${id}`, { ifMatch: ifm(v) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };
const row = async (id: string) => (await pg.query<any>("SELECT * FROM timeoffs WHERE id = $1", [id])).rows[0];
const count = async () => Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM timeoffs")).rows[0]!.n);

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (1, 'Bob'), (2, 'Intrus');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances'), (2, 'Autre');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("POST /timeoffs", () => {
  it("201 : valide le contrat, défauts appliqués (approuvé d'emblée, RT-022), version 1", async () => {
    const w = week();
    const r = await create(base(w));
    expect(r.status).toBe(201);
    expect(ScheduleTimeoff.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ version: 1, personId: "1", typeId: "1", startDate: w.mon, endDate: w.fri, scope: "full_day", startHalf: "am", endHalf: "pm", hoursPerDay: null, approvalStatus: "approved" });
  });

  it("congé partiel (heures par jour) et demi-journée", async () => {
    const w = week();
    const p = await create({ ...base(w), endDate: w.tue, scope: "partial", hoursPerDay: 3.5 });
    expect(p.body).toMatchObject({ scope: "partial", hoursPerDay: 3.5, startHalf: "am", endHalf: "pm" });
    const h = await create({ ...base(week()), endDate: undefined, startDate: week().mon });
    expect(h.status).toBe(400); // endDate manquant
    const w2 = week();
    const half = await create({ personId: "2", typeId: "1", startDate: w2.wed, endDate: w2.wed, startHalf: "pm", endHalf: "pm", approvalStatus: "approved", notes: "dentiste" });
    expect(half.body).toMatchObject({ startHalf: "pm", endHalf: "pm", approvalStatus: "approved" });
    expect((await row(half.body.id)).notes).toBe("dentiste");
  });

  it("BR-04 : un congé posé sur des allocations existantes est accepté et ne les touche pas", async () => {
    const w = week();
    await pg.exec(`INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 1, 1, '${w.mon}', '${w.fri}', 'hours', 8)`);
    const before = (await pg.query<any>(`SELECT id, row_version FROM allocations WHERE start_date = '${w.mon}'`)).rows;
    const r = await create(base(w));
    expect(r.status).toBe(201);
    expect((await pg.query<any>(`SELECT id, row_version FROM allocations WHERE start_date = '${w.mon}'`)).rows).toEqual(before);
    expect(r.body).not.toHaveProperty("warnings");
  });

  it.each([
    ["fin avant début", (w: any) => ({ startDate: w.fri, endDate: w.mon })],
    ["partiel sans heures", () => ({ scope: "partial" })],
    ["heures sans partiel", () => ({ hoursPerDay: 4 })],
    ["un jour, après-midi puis matin", (w: any) => ({ endDate: w.mon, startHalf: "pm", endHalf: "am" })],
    ["partiel avec moitié", () => ({ scope: "partial", hoursPerDay: 4, startHalf: "pm" })],
    ["statut inconnu", () => ({ approvalStatus: "maybe" })],
    ["champ inconnu ignoré mais type faux", () => ({ typeId: 5 })],
  ])("400 VALIDATION_FAILED : %s", async (_n, extra) => {
    const w = week();
    const r = await create({ ...base(w), ...extra(w) });
    expect(r.status).toBe(400);
    expect(err(r).code).toBe("VALIDATION_FAILED");
  });

  it("400 sur corps absent ou illisible", async () => {
    expect((await send("admin", "POST", "/api/v1/timeoffs")).status).toBe(400);
    expect((await send("admin", "POST", "/api/v1/timeoffs", { raw: "{pas du json" })).status).toBe(400);
  });

  it.each([
    ["personne inconnue", { personId: "999" }, "person"],
    ["personne d'un autre compte", { personId: "3" }, "person"],
    ["identifiant non numérique", { personId: "1 OR 1=1" }, "person"],
    ["type inconnu", { typeId: "999" }, "timeoffType"],
    ["type d'un autre compte", { typeId: "2" }, "timeoffType"],
  ])("404 NOT_FOUND : %s", async (_n, extra, entity) => {
    const before = await count();
    const r = await create({ ...base(), ...extra });
    expect(r.status).toBe(404);
    expect(err(r)).toMatchObject({ code: "NOT_FOUND", params: { entity } });
    expect(await count()).toBe(before);
  });

  it("rôles : member et guest 403 (même avec un corps invalide), anonyme 401, pm autorisé", async () => {
    const before = await count();
    for (const who of ["member", "guest"]) {
      const r = await create({ n: "corps invalide" }, who);
      expect(r.status).toBe(403);
      expect(err(r).code).toBe("FORBIDDEN");
    }
    expect((await create(base(), "anon")).status).toBe(401);
    expect(await count()).toBe(before);
    expect((await create(base(), "pm")).status).toBe(201);
  });

  it("le domaine refuse aussi un rôle non écrivain, sans passer par HTTP", async () => {
    await expect(createTimeoff(db, roles.member!, base() as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateTimeoff(db, roles.guest!, "1", 1, { notes: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deleteTimeoff(db, roles.member!, "1", 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("chevauchement (TIMEOFF_OVERLAP)", () => {
  it("409 si les dates se recouvrent ; rien n'est écrit", async () => {
    const w = week();
    await made({}, w);
    const before = await count();
    const r = await create({ ...base(w), startDate: w.wed, endDate: w.thu });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe("TIMEOFF_OVERLAP");
    expect(await count()).toBe(before);
  });

  it("à la demi-journée près : matin + après-midi du même jour cohabitent, deux matins non", async () => {
    const w = week();
    const am = { ...base(w), startDate: w.mon, endDate: w.mon, startHalf: "am", endHalf: "am" };
    expect((await create(am)).status).toBe(201);
    expect((await create({ ...am, startHalf: "pm", endHalf: "pm" })).status).toBe(201);
    expect(err(await create(am)).code).toBe("TIMEOFF_OVERLAP");
    expect(err(await create({ ...am, startHalf: "am", endHalf: "pm" })).code).toBe("TIMEOFF_OVERLAP");
  });

  it("deux personnes différentes ne se gênent pas", async () => {
    const w = week();
    expect((await create({ ...base(w), personId: "1" })).status).toBe(201);
    expect((await create({ ...base(w), personId: "2" })).status).toBe(201);
  });

  it("un congé refusé ne bloque pas, et un congé refusé n'est pas bloqué", async () => {
    const w = week();
    await made({ approvalStatus: "declined" }, w);
    expect((await create(base(w))).status).toBe(201);
    expect((await create({ ...base(w), approvalStatus: "declined" })).status).toBe(201);
  });

  it("un congé partiel peut chevaucher un congé en journées entières (heures, pas créneaux)", async () => {
    const w = week();
    await made({}, w);
    expect((await create({ ...base(w), scope: "partial", hoursPerDay: 2 })).status).toBe(201);
  });
});

describe("PATCH /timeoffs/{id}", () => {
  it("200 : version +1, champs absents inchangés, valide le contrat", async () => {
    const w = week();
    const t = await made({ notes: "n" }, w);
    const r = await patch(t.id, t.version, { approvalStatus: "approved" });
    expect(r.status).toBe(200);
    expect(ScheduleTimeoff.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ id: t.id, version: 2, approvalStatus: "approved", startDate: w.mon, endDate: w.fri, typeId: "1" });
    expect((await row(t.id)).notes).toBe("n");
    const cleared = await patch(t.id, 2, { notes: null });
    expect(cleared.body.version).toBe(3);
    expect((await row(t.id)).notes).toBeNull();
  });

  it("déplacer vers une autre personne et changer de type", async () => {
    await pg.exec("INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Maladie') ON CONFLICT DO NOTHING");
    const typeId = String((await pg.query<any>("SELECT id FROM timeoff_types WHERE name = 'Maladie'")).rows[0].id);
    const t = await made();
    const r = await patch(t.id, t.version, { personId: "2", typeId });
    expect(r.body).toMatchObject({ personId: "2", typeId });
  });

  it("409 VERSION_CONFLICT avec currentVersion ; la ligne n'est pas modifiée", async () => {
    const t = await made();
    await patch(t.id, 1, { notes: "premier" });
    const r = await patch(t.id, 1, { notes: "second" });
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
    expect((await row(t.id)).notes).toBe("premier");
  });

  it("428 sans If-Match, 400 si mal formé", async () => {
    const t = await made();
    expect((await send("admin", "PATCH", `/api/v1/timeoffs/${t.id}`, { body: { notes: "x" } })).status).toBe(428);
    for (const bad of ["1", 'W/"1"', '"x"']) expect((await patch(t.id, bad, { notes: "x" })).status).toBe(400);
  });

  it("404 : congé inconnu, identifiant non numérique, congé d'un autre compte, séquence % illisible", async () => {
    expect((await patch("99999", 1, { notes: "x" })).status).toBe(404);
    expect((await patch("abc", 1, { notes: "x" })).status).toBe(404);
    expect((await send("admin", "PATCH", "/api/v1/timeoffs/%E0%A4%A", { body: { notes: "x" }, ifMatch: '"1"' })).status).toBe(404);
    const t = await made();
    const r = await patch(t.id, t.version, { notes: "intrus" }, "other");
    expect(r.status).toBe(404);
    expect((await row(t.id)).notes).toBeNull();
  });

  it("404 si la nouvelle personne ou le nouveau type sort du compte ; rien n'est modifié", async () => {
    const t = await made();
    expect(err(await patch(t.id, t.version, { personId: "3" })).params).toEqual({ entity: "person" });
    expect(err(await patch(t.id, t.version, { typeId: "2" })).params).toEqual({ entity: "timeoffType" });
    expect((await row(t.id)).row_version).toBe(1);
  });

  it("400 si l'état résultant est incohérent (dates croisées avec l'existant)", async () => {
    const w = week();
    const t = await made({}, w);
    // fin avant le début courant, alors que le corps seul est valide
    expect(err(await patch(t.id, 1, { endDate: "2000-01-01" }))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "endDate" } });
    // passer en partiel sans heures
    expect(err(await patch(t.id, 1, { scope: "partial" }))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "hoursPerDay" } });
    // heures sur un congé en journées entières
    expect(err(await patch(t.id, 1, { hoursPerDay: 3 }))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "hoursPerDay" } });
    expect((await row(t.id)).row_version).toBe(1);
  });

  it("400 (champ endHalf) : un seul jour ne peut pas aller de l'après-midi au matin, via PATCH comme via le domaine", async () => {
    const w = week();
    const t = await made({ endDate: w.mon }, w);
    expect(err(await patch(t.id, 1, { startHalf: "pm", endHalf: "am" }))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "endHalf" } });
    await expect(createTimeoff(db, roles.admin!, { ...base(w), endDate: w.mon, startHalf: "pm", endHalf: "am" } as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("scope : partiel -> journées entières retire les heures ; journées entières -> partiel avec heures remet am..pm", async () => {
    const w = week();
    const t = await made({ scope: "partial", hoursPerDay: 4 }, w);
    const full = await patch(t.id, 1, { scope: "full_day" });
    expect(full.body).toMatchObject({ scope: "full_day", hoursPerDay: null });
    const t2 = await made({ startHalf: "pm" }, week());
    const part = await patch(t2.id, 1, { scope: "partial", hoursPerDay: 2 });
    expect(part.body).toMatchObject({ scope: "partial", hoursPerDay: 2, startHalf: "am", endHalf: "pm" });
  });

  it("409 TIMEOFF_OVERLAP si la modification recouvre un autre congé ; la ligne reste inchangée", async () => {
    const w = week();
    const a = await made({ startDate: w.mon, endDate: w.tue }, w);
    const b = await made({ startDate: w.thu, endDate: w.fri }, w);
    const r = await patch(b.id, b.version, { startDate: w.tue });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe("TIMEOFF_OVERLAP");
    expect(await row(b.id)).toMatchObject({ row_version: 1 });
    expect(a.version).toBe(1);
    // un congé ne se chevauche pas lui-même : élargir sa propre plage est permis
    expect((await patch(b.id, 1, { startDate: w.wed })).status).toBe(200);
  });

  it("passer à « refusé » libère les dates ; revenir à « approuvé » les reprend ou échoue", async () => {
    const w = week();
    const a = await made({}, w);
    await patch(a.id, 1, { approvalStatus: "declined" });
    const b = await made({}, w);
    const r = await patch(a.id, 2, { approvalStatus: "approved" });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe("TIMEOFF_OVERLAP");
    expect(b.version).toBe(1);
  });

  it("rôle : member 403, anonyme 401", async () => {
    const t = await made();
    expect((await patch(t.id, t.version, { notes: "x" }, "member")).status).toBe(403);
    expect((await patch(t.id, t.version, { notes: "x" }, "anon")).status).toBe(401);
    expect((await row(t.id)).row_version).toBe(1);
  });
});

describe("DELETE /timeoffs/{id}", () => {
  it("204, journalisé dans delete_log (BR-14), puis 404", async () => {
    const t = await made();
    const r = await del(t.id, t.version);
    expect(r.status).toBe(204);
    expect(r.body).toBeUndefined();
    expect(await row(t.id)).toBeUndefined();
    const log = (await pg.query<any>("SELECT entity FROM delete_log WHERE entity_id = $1 AND entity = 'timeoffs'", [t.id])).rows;
    expect(log).toHaveLength(1);
    expect((await del(t.id, t.version)).status).toBe(404);
  });

  it("409 sur version périmée (rien supprimé), 428 sans If-Match, 404 pour un autre compte, 403 member", async () => {
    const t = await made();
    await patch(t.id, 1, { notes: "x" });
    const stale = await del(t.id, 1);
    expect(stale.status).toBe(409);
    expect(err(stale).params).toEqual({ currentVersion: 2 });
    expect((await send("admin", "DELETE", `/api/v1/timeoffs/${t.id}`)).status).toBe(428);
    expect((await del(t.id, 2, "other")).status).toBe(404);
    expect((await del(t.id, 2, "member")).status).toBe(403);
    expect(await row(t.id)).toBeDefined();
  });
});

describe("cohérence avec la lecture et le journal", () => {
  it("GET /schedule renvoie le congé créé tel que la réponse d'écriture", async () => {
    const w = week();
    const t = await made({ approvalStatus: "approved" }, w);
    const r = await send("admin", "GET", `/api/v1/schedule?from=${w.mon}&to=${w.fri}`);
    const parsed = ScheduleResponse.parse(r.body);
    expect(parsed.timeoffs.find((x) => x.id === t.id)).toEqual(t);
  });

  it("les écritures apparaissent dans change_log avec leur version ; un refus n'ajoute rien", async () => {
    const head = (await send("admin", "GET", `/api/v1/schedule?from=2026-06-01&to=2026-06-05`)).body as { changeCursor: string };
    const w = week();
    const t = await made({}, w);
    const p = await patch(t.id, 1, { notes: "n" });
    await create(base(w)); // refusé : chevauchement
    await patch(t.id, 1, { notes: "périmé" }); // refusé : version
    await del(t.id, p.body.version);
    const r = await readChanges(db, roles.admin!, head.changeCursor);
    if (r.status !== "ok") throw new Error("expiré");
    expect(r.changes.map((c) => [c.entity, c.id, c.op, c.version])).toEqual([
      ["timeoffs", t.id, "insert", 1],
      ["timeoffs", t.id, "update", 2],
      ["timeoffs", t.id, "delete", null],
    ]);
  });
});
