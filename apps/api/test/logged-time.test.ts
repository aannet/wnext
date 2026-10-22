// Temps saisis contre schema.sql réel (PGlite) : pré-remplissage (BR-11), cycle de vie et verrouillage (BR-12), plafond 24 h (BR-28), placeholder (BR-27).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoggedTime, LoggedTimeList, LoggedTimePrefillResult, LoggedTimeSubmitResult } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-11 @BR-12 @BR-27 @BR-28
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

const send = (who: string, method: string, url: string, opts: { body?: unknown; ifMatch?: string } = {}) =>
  dispatch(deps, {
    method, url,
    headers: { authorization: who, ...(opts.ifMatch !== undefined && { "if-match": opts.ifMatch }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

// Chaque test prend sa propre semaine : les totaux par jour d'une même personne ne se mélangent pas d'un test à l'autre.
let slot = 0;
const week = () => {
  const start = new Date(Date.UTC(2026, 5, 1 + 14 * slot++));
  const at = (n: number) => new Date(start.getTime() + n * 86400000).toISOString().slice(0, 10);
  return { mon: at(0), tue: at(1), wed: at(2), thu: at(3), fri: at(4), sat: at(5), sun: at(6) };
};
const alloc = (w: { mon: string; fri: string }, over: Record<string, unknown> = {}) => {
  const f = { person_id: 1, project_id: 1, start_date: w.mon, end_date: w.fri, mode: "hours", hours_per_day: 6, status: "confirmed", ...over };
  return pg.query<{ id: string }>(
    `INSERT INTO allocations (account_id, person_id, project_id, phase_id, project_task_id, start_date, end_date, mode, hours_per_day, percent, status)
     VALUES (1, ${f.person_id}, ${f.project_id}, ${(f as any).phase_id ?? "NULL"}, ${(f as any).task_id ?? "NULL"}, '${f.start_date}', '${f.end_date}', '${f.mode}', ${(f as any).percent ? "NULL" : f.hours_per_day}, ${(f as any).percent ?? "NULL"}, '${f.status}')
     RETURNING id`,
  ).then((r) => r.rows[0]!.id);
};
const window = (w: { mon: string; sun: string }, personId = "1") => ({ personId, from: w.mon, to: w.sun });
const prefill = (body: unknown, who = "pm") => send(who, "POST", "/api/v1/logged-time/prefill", { body });
const submit = (body: unknown, who = "pm") => send(who, "POST", "/api/v1/logged-time/submit", { body });
const list = (q: string, who = "guest") => send(who, "GET", `/api/v1/logged-time?${q}`);
const create = (body: Record<string, unknown>, who = "pm") => send(who, "POST", "/api/v1/logged-time", { body });
const ifm = (v: number | string) => (typeof v === "number" ? `"${v}"` : v);
const patch = (id: string, v: number | string, body: unknown, who = "pm") => send(who, "PATCH", `/api/v1/logged-time/${id}`, { body, ifMatch: ifm(v) });
const del = (id: string, v: number | string, who = "pm") => send(who, "DELETE", `/api/v1/logged-time/${id}`, { ifMatch: ifm(v) });
const unlock = (id: string, v: number | string, who = "admin") => send(who, "POST", `/api/v1/logged-time/${id}/unlock`, { ifMatch: ifm(v) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };
const row = async (id: string) => (await pg.query<any>("SELECT * FROM logged_time WHERE id = $1", [id])).rows[0];
const made = async (extra: Record<string, unknown> = {}, w = week()) => (await create({ personId: "1", projectId: "1", workDate: w.mon, hours: 3, ...extra })).body as any;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (1, 'Bob');
    INSERT INTO people (account_id, name, people_type) VALUES (1, 'Place', 'placeholder');
    INSERT INTO people (account_id, name) VALUES (2, 'Intrus');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
    INSERT INTO projects (account_id, name, status) VALUES (1, 'Tentatif', 'tentative');
    INSERT INTO projects (account_id, name) VALUES (2, 'Autre');
    -- BR-33 : l'utilisateur 1 (joué aussi en project_manager) gère les projets du compte 1.
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'project_manager');
    INSERT INTO project_managers (project_id, account_id, user_id) SELECT id, account_id, 1 FROM projects WHERE account_id = 1;
    INSERT INTO phases (account_id, project_id, name) VALUES (1, 1, 'Facturable');
    INSERT INTO phases (account_id, project_id, name, non_billable) VALUES (1, 1, 'Interne', TRUE);
    INSERT INTO phases (account_id, project_id, name) VALUES (1, 2, 'Autre projet');
    INSERT INTO project_tasks (account_id, project_id, name) VALUES (1, 1, 'Design');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("POST /logged-time/prefill (BR-11)", () => {
  it("matérialise un brouillon par jour ouvré et par allocation confirmée, avec l'allocation source", async () => {
    const w = week();
    const a = await alloc(w, { hours_per_day: 6 });
    const r = await prefill(window(w));
    expect(r.status).toBe(200);
    expect(LoggedTimePrefillResult.safeParse(r.body).success).toBe(true);
    expect(r.body.createdCount).toBe(5);
    expect(r.body.items.map((i: any) => i.workDate)).toEqual([w.mon, w.tue, w.wed, w.thu, w.fri]);
    expect(r.body.items[0]).toMatchObject({ personId: "1", projectId: "1", allocationId: String(a), hours: 6, billable: true, status: "draft", version: 1, phaseId: null, taskId: null });
  });

  it("ignore les allocations tentatives et celles d'un projet tentatif", async () => {
    const w = week();
    await alloc(w, { status: "tentative" });
    await alloc(w, { project_id: 2 });
    const r = await prefill(window(w));
    expect(r.body).toMatchObject({ createdCount: 0, items: [] });
  });

  it("reprend phase et tâche de l'allocation ; une phase non facturable donne une ligne non facturable", async () => {
    const w = week();
    await alloc(w, { phase_id: 2, task_id: 1, start_date: w.mon, end_date: w.mon });
    const r = await prefill(window(w));
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ phaseId: "2", taskId: "1", billable: false });
  });

  it("pourcentage : converti sur les heures brutes du jour", async () => {
    const w = week();
    await alloc(w, { mode: "percentage", percent: 50, start_date: w.mon, end_date: w.mon });
    expect((await prefill(window(w))).body.items[0].hours).toBe(4);
  });

  it("idempotent : rejouer ne crée rien ; une ligne supprimée est recréée", async () => {
    const w = week();
    await alloc(w, { start_date: w.mon, end_date: w.tue });
    const first = await prefill(window(w));
    expect(first.body.createdCount).toBe(2);
    const again = await prefill(window(w));
    expect(again.body.createdCount).toBe(0);
    expect(again.body.items).toEqual(first.body.items);
    const gone = first.body.items[0];
    expect((await del(gone.id, gone.version)).status).toBe(204);
    expect((await prefill(window(w))).body.createdCount).toBe(1);
  });

  it("ne touche pas aux lignes déjà soumises (ni ne les double)", async () => {
    const w = week();
    await alloc(w, { start_date: w.mon, end_date: w.mon });
    await prefill(window(w));
    await submit(window(w));
    const r = await prefill(window(w));
    expect(r.body.createdCount).toBe(0);
    expect(r.body.items[0].status).toBe("submitted");
  });

  it("BR-28 : le total d'un jour ne dépasse pas 24 h, le brouillon est tronqué", async () => {
    const w = week();
    await made({ workDate: w.mon, hours: 20 }, w);
    await alloc(w, { hours_per_day: 8, start_date: w.mon, end_date: w.mon });
    const r = await prefill(window(w));
    const mirrored = r.body.items.find((i: any) => i.allocationId !== null);
    expect(mirrored.hours).toBe(4);
  });

  it("un placeholder ne logue pas de temps (BR-27) : 400 ; personne inconnue ou d'un autre compte : 404", async () => {
    const w = week();
    expect(err(await prefill(window(w, "3")))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "personId" } });
    expect(err(await prefill(window(w, "999")))).toMatchObject({ code: "NOT_FOUND", params: { entity: "person" } });
    expect(err(await prefill(window(w, "4")))).toMatchObject({ code: "NOT_FOUND", params: { entity: "person" } });
  });

  it("rôles et validation : 401, 403 avant la validation, fenêtre trop longue, fenêtre inversée", async () => {
    const w = week();
    expect((await prefill(window(w), "anon")).status).toBe(401);
    expect(err(await prefill({}, "member")).code).toBe("FORBIDDEN");
    expect(err(await prefill({ personId: "1", from: "2026-01-01", to: "2027-06-01" })).code).toBe("SCHEDULE_RANGE_INVALID");
    expect(err(await prefill({ personId: "1", from: w.fri, to: w.mon })).code).toBe("VALIDATION_FAILED");
  });
});

describe("GET /logged-time", () => {
  it("liste la fenêtre d'une personne, filtrable par statut, lisible par un guest", async () => {
    const w = week();
    const a = await made({ workDate: w.mon }, w);
    await made({ workDate: w.tue }, w);
    await made({ workDate: w.thu, personId: "2" }, w);
    await submit({ personId: "1", from: w.tue, to: w.tue });
    const all = await list(`personId=1&from=${w.mon}&to=${w.sun}`);
    expect(all.status).toBe(200);
    expect(LoggedTimeList.safeParse(all.body).success).toBe(true);
    expect(all.body.items.map((i: any) => i.workDate)).toEqual([w.mon, w.tue]);
    expect(all.body.items[0].id).toBe(a.id);
    const submitted = await list(`personId=1&from=${w.mon}&to=${w.sun}&status=submitted`);
    expect(submitted.body.items.map((i: any) => i.workDate)).toEqual([w.tue]);
  });

  it("401, fenêtre invalide, personne inconnue ou d'un autre compte, paramètre manquant", async () => {
    const w = week();
    expect((await list(`personId=1&from=${w.mon}&to=${w.sun}`, "anon")).status).toBe(401);
    expect(err(await list("personId=1&from=2026-01-01&to=2027-06-01")).code).toBe("SCHEDULE_RANGE_INVALID");
    expect(err(await list(`personId=999&from=${w.mon}&to=${w.sun}`)).code).toBe("NOT_FOUND");
    expect(err(await list(`personId=1&from=${w.mon}&to=${w.sun}`, "other")).code).toBe("NOT_FOUND");
    expect(err(await list(`from=${w.mon}&to=${w.sun}`)).code).toBe("VALIDATION_FAILED");
  });
});

describe("POST /logged-time", () => {
  it("201 : brouillon, version 1, facturable par défaut", async () => {
    const w = week();
    const r = await create({ personId: "1", projectId: "1", phaseId: "1", taskId: "1", workDate: w.mon, hours: 2.5, notes: "revue" });
    expect(r.status).toBe(201);
    expect(LoggedTime.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ version: 1, status: "draft", hours: 2.5, billable: true, allocationId: null, phaseId: "1", taskId: "1", notes: "revue" });
  });

  it("BR-28 : plus de 24 h dans la journée, tous projets confondus -> 409 LOGGED_TIME_DAY_LIMIT", async () => {
    const w = week();
    await made({ workDate: w.mon, hours: 20 }, w);
    const r = await create({ personId: "1", projectId: "2", workDate: w.mon, hours: 5 });
    expect(err(r).code).toBe("LOGGED_TIME_DAY_LIMIT");
    expect((await create({ personId: "1", projectId: "2", workDate: w.mon, hours: 4 })).status).toBe(201);
  });

  it("BR-27 : un placeholder ne logue pas de temps -> 400", async () => {
    expect(err(await create({ personId: "3", projectId: "1", workDate: week().mon, hours: 1 }))).toMatchObject({ code: "VALIDATION_FAILED", params: { field: "personId" } });
  });

  it("références : personne, projet, phase d'un autre projet, projet d'un autre compte -> 404", async () => {
    const w = week();
    const base = { personId: "1", projectId: "1", workDate: w.mon, hours: 1 };
    expect(err(await create({ ...base, personId: "999" })).params).toMatchObject({ entity: "person" });
    expect(err(await create({ ...base, projectId: "999" })).params).toMatchObject({ entity: "project" });
    expect(err(await create({ ...base, projectId: "3" })).params).toMatchObject({ entity: "project" });
    expect(err(await create({ ...base, phaseId: "3" })).params).toMatchObject({ entity: "phase" });
  });

  it("validation : heures hors bornes ou au-delà du centième, rôle", async () => {
    const w = week();
    const base = { personId: "1", projectId: "1", workDate: w.mon };
    for (const hours of [0, -1, 25, 0.001, 1.234]) expect((await create({ ...base, hours })).status).toBe(400);
    expect(err(await create({ ...base, hours: 1 }, "member")).code).toBe("FORBIDDEN");
    expect((await create({ ...base, hours: 1 }, "anon")).status).toBe(401);
  });
});

describe("PATCH et DELETE /logged-time/{id}", () => {
  it("modifie un brouillon, version incrémentée ; champs absents inchangés", async () => {
    const t = await made({ notes: "n", phaseId: "1" });
    const r = await patch(t.id, t.version, { hours: 4.25, billable: false, phaseId: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ hours: 4.25, billable: false, phaseId: null, notes: "n", version: 2 });
  });

  it("verrou optimiste : If-Match absent 428, périmé 409 avec la version courante, corps vide 400", async () => {
    const t = await made();
    expect((await send("pm", "PATCH", `/api/v1/logged-time/${t.id}`, { body: { hours: 1 } })).status).toBe(428);
    await patch(t.id, 1, { hours: 1 });
    expect(err(await patch(t.id, 1, { hours: 2 }))).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
    expect((await patch(t.id, 2, {})).status).toBe(400);
  });

  it("BR-28 : monter les heures au-delà de 24 h dans la journée -> 409 LOGGED_TIME_DAY_LIMIT", async () => {
    const w = week();
    await made({ workDate: w.mon, hours: 20 }, w);
    const t = await made({ workDate: w.mon, hours: 2 }, w);
    expect(err(await patch(t.id, t.version, { hours: 5 })).code).toBe("LOGGED_TIME_DAY_LIMIT");
    expect((await patch(t.id, t.version, { hours: 4 })).status).toBe(200);
  });

  it("BR-12 : une ligne soumise ne se modifie ni ne se supprime, même par un admin -> 409 LOGGED_TIME_LOCKED", async () => {
    const w = week();
    const t = await made({ workDate: w.mon }, w);
    await submit(window(w));
    const cur = (await list(`personId=1&from=${w.mon}&to=${w.sun}`)).body.items[0];
    expect(err(await patch(t.id, cur.version, { hours: 1 }, "admin"))).toMatchObject({ code: "LOGGED_TIME_LOCKED", params: { status: "submitted" } });
    expect(err(await del(t.id, cur.version, "admin")).code).toBe("LOGGED_TIME_LOCKED");
    expect((await row(t.id)).hours).toBe("3.00");
  });

  it("DELETE : 204, journalisé dans delete_log (BR-14) ; rôle, inconnu, autre compte", async () => {
    const t = await made();
    expect((await del(t.id, t.version, "member")).status).toBe(403);
    expect((await del(t.id, t.version, "other")).status).toBe(404);
    expect((await del(t.id, t.version)).status).toBe(204);
    expect((await pg.query<any>("SELECT 1 FROM delete_log WHERE entity = 'logged_time' AND entity_id = $1", [t.id])).rows).toHaveLength(1);
    expect((await del(t.id, t.version)).status).toBe(404);
    expect((await patch("abc", 1, { hours: 1 })).status).toBe(404);
  });
});

describe("POST /logged-time/submit (BR-12)", () => {
  it("soumet tous les brouillons de la personne dans la fenêtre, et seulement eux", async () => {
    const w = week();
    await made({ workDate: w.mon }, w);
    await made({ workDate: w.tue }, w);
    await made({ workDate: w.wed, personId: "2" }, w);
    const outside = await made({ workDate: w.fri }, w);
    const r = await submit({ personId: "1", from: w.mon, to: w.thu });
    expect(r.status).toBe(200);
    expect(LoggedTimeSubmitResult.safeParse(r.body).success).toBe(true);
    expect(r.body.submittedCount).toBe(2);
    expect(r.body.items.map((i: any) => i.status)).toEqual(["submitted", "submitted"]);
    expect((await row(outside.id)).status).toBe("draft");
    const bob = (await list(`personId=2&from=${w.mon}&to=${w.sun}`)).body.items;
    expect(bob.map((i: any) => i.status)).toEqual(["draft"]);
    expect((await row(r.body.items[0].id)).submitted_at).not.toBeNull();
  });

  it("rejouer ne soumet plus rien ; une fenêtre vide n'est pas une erreur", async () => {
    const w = week();
    await made({ workDate: w.mon }, w);
    await submit(window(w));
    expect((await submit(window(w))).body.submittedCount).toBe(0);
    expect((await submit(window(week()))).body).toMatchObject({ submittedCount: 0, items: [] });
  });

  it("rôles et références : 401, 403, 404, fenêtre trop longue", async () => {
    const w = week();
    expect(err(await submit(window(w), "member")).code).toBe("FORBIDDEN");
    expect((await submit(window(w), "anon")).status).toBe(401);
    expect(err(await submit(window(w, "999"))).code).toBe("NOT_FOUND");
    expect(err(await submit(window(w, "4"))).code).toBe("NOT_FOUND");
    expect(err(await submit({ personId: "1", from: "2026-01-01", to: "2027-06-01" })).code).toBe("SCHEDULE_RANGE_INVALID");
  });
});

describe("POST /logged-time/{id}/unlock (BR-12)", () => {
  it("un admin déverrouille : retour en brouillon, déverrouillage tracé, la ligne redevient modifiable", async () => {
    const w = week();
    const t = await made({ workDate: w.mon }, w);
    await submit(window(w));
    const locked = (await list(`personId=1&from=${w.mon}&to=${w.sun}`)).body.items[0];
    const r = await unlock(t.id, locked.version);
    expect(r.status).toBe(200);
    expect(LoggedTime.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ status: "draft", version: locked.version + 1 });
    const db1 = await row(t.id);
    expect(String(db1.unlocked_by)).toBe("1");
    expect(db1.unlocked_at).not.toBeNull();
    expect(db1.submitted_at).toBeNull();
    expect((await patch(t.id, r.body.version, { hours: 1 })).status).toBe(200);
  });

  it("réservé à owner et admin : un project_manager reçoit 403, un membre aussi", async () => {
    const w = week();
    const t = await made({ workDate: w.mon }, w);
    await submit(window(w));
    expect(err(await unlock(t.id, 1, "pm")).code).toBe("FORBIDDEN");
    expect(err(await unlock(t.id, 1, "member")).code).toBe("FORBIDDEN");
    expect((await unlock(t.id, 1, "anon")).status).toBe(401);
    expect((await row(t.id)).status).toBe("submitted");
  });

  it("verrou optimiste, ligne inconnue ou d'un autre compte, ligne déjà en brouillon rendue telle quelle", async () => {
    const w = week();
    const t = await made({ workDate: w.mon }, w);
    expect(err(await unlock(t.id, 5)).code).toBe("VERSION_CONFLICT");
    expect((await send("admin", "POST", `/api/v1/logged-time/${t.id}/unlock`)).status).toBe(428);
    expect((await unlock("999", 1)).status).toBe(404);
    expect((await unlock(t.id, 1, "other")).status).toBe(404);
    const same = await unlock(t.id, t.version);
    expect(same.body).toMatchObject({ status: "draft", version: t.version });
  });
});

describe("trigger guard_logged_time : dernier rempart", () => {
  it("une écriture directe non admin sur une ligne soumise est refusée par la base (BR-12)", async () => {
    const w = week();
    const t = await made({ workDate: w.mon }, w);
    await submit(window(w));
    await expect(db.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.account_id', '1', true), set_config('app.role', 'project_manager', true)");
      await tx.query("UPDATE logged_time SET hours = 1 WHERE id = $1::bigint", [t.id]);
    })).rejects.toMatchObject({ code: "42501" });
  });
});
