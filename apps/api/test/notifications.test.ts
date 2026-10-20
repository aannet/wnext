// Notifications in-app (FR-10, US-7.3, BR-36) contre la base MIGRÉE (schema.sql puis migrations/, PGlite) : émission par les écritures
// ordinaires (auteur jamais notifié), regroupement par transaction, conflit d'édition, lu / non lu, préférences par type,
// isolation par utilisateur ET par compte (zéro fuite, rôle owner compris).
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { Notification, NotificationList, NotificationPreferences, NotificationReadAllResult } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// Compte 1 : owner (user 1, personne 1), admin (user 2, personne 2), member (user 3, personne 3), guest (user 4).
// Compte 2 : other (user 5, admin, personne 4).
const users: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "2", role: "admin" },
  member: { accountId: "1", userId: "3", role: "member" },
  guest: { accountId: "1", userId: "4", role: "guest" },
  other: { accountId: "2", userId: "5", role: "admin" },
  anon: null,
};
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const errors: unknown[] = [];
const deps: HttpDeps = { db, authenticate: async (h) => users[String(h.authorization)] ?? null, newRequestId: () => "r", onError: (e) => errors.push(e) };
const send = (who: string, method: string, url: string, body?: unknown, version?: number) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(version === undefined ? {} : { "if-match": `"${version}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async (who: string, q = "") => {
  const r = await send(who, "GET", `/api/v1/notifications${q}`);
  expect(r.status).toBe(200);
  expect(NotificationList.safeParse(r.body).success).toBe(true);
  return r.body as NotificationList;
};
type NotificationList = { items: Notification[]; page: { nextCursor: string | null; total: number }; unreadCount: number };
const alloc = async (who: string, personId: string, startDate: string, extra: object = {}) => {
  const r = await send(who, "POST", "/api/v1/allocations", { personId, projectId: personId === "4" ? "2" : "1", startDate, endDate: startDate, load: { mode: "hours", hoursPerDay: 2 }, ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; version: number };
};
const readAll = (who: string) => send(who, "POST", "/api/v1/notifications/read-all");

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email, name) VALUES ('o@x.test', 'Olga'), ('a@x.test', 'Adam'), ('m@x.test', 'Mia'), ('g@x.test', NULL), ('x@x.test', 'Xavier');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Olga'), (1, 'Adam'), (1, 'Mia'), (2, 'Xavier');
    INSERT INTO projects (account_id, name) VALUES (1, 'P'), (2, 'Q');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'CP');
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (1,1,'owner',1), (1,2,'admin',2), (1,3,'member',3), (1,4,'guest',NULL), (2,5,'admin',4);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("émission par les écritures de l'API", () => {
  it("allocation créée par l'admin pour Mia : Mia notifiée (forme du contrat), l'admin auteur et les autres non", async () => {
    const a = await alloc("admin", "3", "2026-03-02");
    const mine = await list("member");
    expect(mine.unreadCount).toBe(1);
    expect(mine.items[0]).toMatchObject({ type: "allocation_changed", entity: "allocations", entityId: a.id, actor: { id: "2", name: "Adam" },
      counts: { created: 1, updated: 0, deleted: 0, approved: 0, declined: 0 }, startDate: "2026-03-02", currentVersion: null, readAt: null });
    expect(mine.items[0]!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const who of ["admin", "owner", "guest", "other"]) expect((await list(who)).items).toEqual([]);
    await alloc("admin", "2", "2026-03-03"); // sa propre personne
    expect((await list("admin")).unreadCount).toBe(0);
  });

  it("regroupement : une découpe de série (2 écritures, 1 transaction) donne UNE notification « 1 modifiée, 1 créée »", async () => {
    await readAll("member");
    const s = await alloc("owner", "3", "2026-04-06", { repeatState: "weekly", repeatEndDate: "2026-04-27" });
    const r = await send("owner", "POST", `/api/v1/allocations/${s.id}/split`, { occurrenceDate: "2026-04-13", delete: true }, s.version);
    expect(r.status).toBe(200);
    const { items, unreadCount } = await list("member", "?unread=true");
    expect(unreadCount).toBe(2);
    expect(items.map((n) => n.counts)).toEqual([
      { created: 1, updated: 1, deleted: 0, approved: 0, declined: 0 }, // la découpe
      { created: 1, updated: 0, deleted: 0, approved: 0, declined: 0 }, // la création de la série
    ]);
    expect(items[0]!.actor).toEqual({ id: "1", name: "Olga" });
  });

  it("congé de Mia approuvé puis refusé par l'admin : timeoff_decided ; le poser en attente ne notifie pas", async () => {
    await readAll("member");
    const t = await send("admin", "POST", "/api/v1/timeoffs", { personId: "3", typeId: "1", startDate: "2026-05-04", endDate: "2026-05-05" });
    expect(t.status).toBe(201);
    expect((await list("member")).unreadCount).toBe(0);
    const id = (t.body as { id: string }).id;
    const ok = await send("admin", "PATCH", `/api/v1/timeoffs/${id}`, { approvalStatus: "approved" }, 1);
    expect(ok.status).toBe(200);
    await send("admin", "PATCH", `/api/v1/timeoffs/${id}`, { notes: "ok" }, 2); // statut inchangé : rien
    await send("admin", "PATCH", `/api/v1/timeoffs/${id}`, { approvalStatus: "declined" }, 3);
    const { items, unreadCount } = await list("member", "?unread=true");
    expect(unreadCount).toBe(2);
    expect(items.map((n) => [n.type, n.entity, n.entityId, n.counts.approved, n.counts.declined, n.startDate])).toEqual([
      ["timeoff_decided", "timeoffs", id, 0, 1, "2026-05-04"], ["timeoff_decided", "timeoffs", id, 1, 0, "2026-05-04"],
    ]);
  });

  it("conflit d'édition (BR-36) : le perdant est notifié avec l'auteur et la version gagnante ; le 409 est inchangé", async () => {
    const a = await alloc("admin", "1", "2026-03-10");
    await readAll("admin"); await readAll("owner");
    expect((await send("owner", "PATCH", `/api/v1/allocations/${a.id}`, { notes: "gagnant" }, a.version)).status).toBe(200);
    const lost = await send("admin", "PATCH", `/api/v1/allocations/${a.id}`, { notes: "perdant" }, a.version);
    expect([lost.status, (lost.body as { code: string }).code]).toEqual([409, "VERSION_CONFLICT"]);
    const del = await send("admin", "DELETE", `/api/v1/allocations/${a.id}`, undefined, a.version);
    expect(del.status).toBe(409);
    const { items } = await list("admin", "?unread=true");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "edit_conflict", entity: "allocations", entityId: a.id, actor: { id: "1", name: "Olga" }, currentVersion: 2, startDate: null });
    expect((await list("owner", "?unread=true")).items.filter((n) => n.type === "edit_conflict")).toEqual([]); // le gagnant n'est pas notifié du conflit
    // Autre ressource à verrou optimiste : une personne.
    const p = await send("admin", "PATCH", "/api/v1/people/3", { name: "Mia" }, 999);
    expect(p.status).toBe(409);
    expect((await list("admin", "?limit=1")).items[0]).toMatchObject({ type: "edit_conflict", entity: "people", entityId: "3" });
    expect(errors).toEqual([]);
  });
});

describe("lu / non lu, pagination", () => {
  it("marquer lu : idempotent (la date reste), compteur décrémenté ; tout marquer lu", async () => {
    const before = await list("member", "?unread=true");
    expect(before.unreadCount).toBeGreaterThan(1);
    const first = await send("member", "POST", `/api/v1/notifications/${before.items[0]!.id}/read`);
    expect(first.status).toBe(200);
    expect(Notification.safeParse(first.body).success).toBe(true);
    const readAt = (first.body as Notification).readAt;
    expect(readAt).not.toBeNull();
    const again = await send("member", "POST", `/api/v1/notifications/${before.items[0]!.id}/read`);
    expect((again.body as Notification).readAt).toBe(readAt);
    expect((await list("member")).unreadCount).toBe(before.unreadCount - 1);
    const all = await send("member", "POST", "/api/v1/notifications/read-all");
    expect(NotificationReadAllResult.safeParse(all.body).success).toBe(true);
    expect(all.body).toEqual({ marked: before.unreadCount - 1, unreadCount: 0 });
    expect((await list("member", "?unread=true")).items).toEqual([]);
  });

  it("pagination : la plus récente d'abord, curseur, total ; requêtes invalides en 400", async () => {
    const all = (await list("member")).items.map((n) => n.id);
    expect(all.length).toBeGreaterThan(2);
    expect([...all].sort((x, y) => Number(y) - Number(x))).toEqual(all);
    const p1 = await list("member", "?limit=2");
    expect(p1.page.total).toBe(all.length);
    const p2 = await list("member", `?limit=2&cursor=${p1.page.nextCursor}`);
    expect([...p1.items, ...p2.items].map((n) => n.id)).toEqual(all.slice(0, 4));
    for (const q of ["?unread=oui", "?limit=0", "?cursor=zz", "?x=1"]) expect((await send("member", "GET", `/api/v1/notifications${q}`)).status).toBe(400);
  });
});

describe("isolation : destinataire seul, compte seul", () => {
  it("la notification de Mia : 404 pour l'owner, l'admin, le guest et un autre compte ; jamais listée chez eux ; 401 anonyme", async () => {
    const id = (await list("member")).items[0]!.id;
    for (const who of ["owner", "admin", "guest", "other"]) {
      const r = await send(who, "POST", `/api/v1/notifications/${id}/read`);
      expect([r.status, (r.body as { code: string }).code]).toEqual([404, "NOT_FOUND"]);
      expect((await list(who)).items.map((n) => n.id)).not.toContain(id);
    }
    for (const bad of ["abc", "%zz", "999999"]) expect((await send("member", "POST", `/api/v1/notifications/${bad}/read`)).status).toBe(404);
    await send("owner", "POST", "/api/v1/notifications/read-all");
    expect((await send("member", "GET", "/api/v1/notifications?unread=true")).status).toBe(200);
    for (const [m, u] of [["GET", "/api/v1/notifications"], ["POST", `/api/v1/notifications/${id}/read`], ["POST", "/api/v1/notifications/read-all"], ["GET", "/api/v1/notification-preferences"], ["PUT", "/api/v1/notification-preferences"]] as const) {
      expect((await send("anon", m, u, m === "PUT" ? { items: [{ type: "edit_conflict", enabled: false }] } : undefined)).status).toBe(401);
    }
  });

  it("autre compte : ses écritures ne notifient que chez lui", async () => {
    await alloc("owner", "1", "2026-03-20"); // owner sur sa personne : rien
    await pg.exec("INSERT INTO users (email) VALUES ('y@x.test'); INSERT INTO people (account_id, name) VALUES (2, 'Yann'); INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (2, 6, 'admin', 5)");
    users.yann = { accountId: "2", userId: "6", role: "admin" };
    await alloc("yann", "4", "2026-03-02");
    expect((await list("other")).items.map((n) => n.actor?.id)).toEqual(["6"]);
    expect((await list("member", "?unread=true")).items).toEqual([]);
  });
});

describe("préférences par type", () => {
  it("par défaut tout est abonné ; désabonné : plus de ligne ; réabonné : de nouveau ; propre à chacun", async () => {
    const def = await send("member", "GET", "/api/v1/notification-preferences");
    expect(NotificationPreferences.safeParse(def.body).success).toBe(true);
    expect(def.body).toEqual({ items: [{ type: "allocation_changed", enabled: true }, { type: "timeoff_decided", enabled: true }, { type: "edit_conflict", enabled: true }] });
    const put = await send("member", "PUT", "/api/v1/notification-preferences", { items: [{ type: "allocation_changed", enabled: false }] });
    expect(put.body).toEqual({ items: [{ type: "allocation_changed", enabled: false }, { type: "timeoff_decided", enabled: true }, { type: "edit_conflict", enabled: true }] });
    expect(((await send("admin", "GET", "/api/v1/notification-preferences")).body as { items: Array<{ enabled: boolean }> }).items.every((i) => i.enabled)).toBe(true);
    const before = (await list("member")).page.total;
    await alloc("admin", "3", "2026-06-01");
    expect((await list("member")).page.total).toBe(before);
    await send("member", "PUT", "/api/v1/notification-preferences", { items: [{ type: "allocation_changed", enabled: true }] });
    await alloc("admin", "3", "2026-06-02");
    expect((await list("member")).page.total).toBe(before + 1);
    // conflit désabonné
    await send("admin", "PUT", "/api/v1/notification-preferences", { items: [{ type: "edit_conflict", enabled: false }] });
    const n0 = (await list("admin")).page.total;
    expect((await send("admin", "PATCH", "/api/v1/people/3", { name: "Mia" }, 999)).status).toBe(409);
    expect((await list("admin")).page.total).toBe(n0);
  });

  it("corps invalides : 400", async () => {
    for (const bad of [{}, { items: [] }, { items: [{ type: "mail", enabled: false }] }, { items: [{ type: "edit_conflict", enabled: false }, { type: "edit_conflict", enabled: true }] }, { items: [{ type: "edit_conflict" }] }]) {
      const r = await send("member", "PUT", "/api/v1/notification-preferences", bad);
      expect([r.status, (r.body as { code: string }).code]).toEqual([400, "VALIDATION_FAILED"]);
    }
  });
});
