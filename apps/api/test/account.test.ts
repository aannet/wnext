// GET et PATCH /api/v1/account (RT-041, PO-05) contre schema.sql réel (PGlite, rôle app_user donc RLS active) : forme du contrat,
// matrice des rôles (lecture : tout membre ; écriture : owner et admin, 403 avant la lecture du corps), If-Match (428, 409 avec
// la version courante), fuseau validé contre pg_timezone_names, langue fr|en, seuil 1-100, isolation entre comptes, et relecture :
// GET /me (fuseau, semaine, langue) et GET /schedule (semaine, seuil, fuseau) voient la nouvelle valeur.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountSettings, Me, ScheduleResponse } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

const users: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "2", role: "admin" },
  pm: { accountId: "1", userId: "3", role: "project_manager" },
  member: { accountId: "1", userId: "4", role: "member" },
  guest: { accountId: "1", userId: "5", role: "guest" },
  other: { accountId: "2", userId: "6", role: "admin" },
  anon: null,
};
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const deps: HttpDeps = { db, authenticate: async (h) => users[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, ifMatch?: number | string) =>
  dispatch(deps, {
    method, url,
    headers: { authorization: who, ...(ifMatch === undefined ? {} : { "if-match": typeof ifMatch === "number" ? `"${ifMatch}"` : ifMatch }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (who: string) => send(who, "GET", "/api/v1/account");
const patch = (who: string, body: unknown, version?: number | string) => send(who, "PATCH", "/api/v1/account", body, version);
const code = (r: { body: unknown }) => (r.body as { code: string }).code;
const params = (r: { body: unknown }) => (r.body as { params: Record<string, unknown> }).params;
const version = async (who = "owner") => AccountSettings.parse((await get(who)).body).version;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email, name) VALUES ('o@x.test','Owner'), ('a@x.test','Admin'), ('pm@x.test','Chef'), ('m@x.test','Membre'), ('g@x.test','Invité'), ('b@x.test','Autre');
    INSERT INTO accounts (name, timezone, week_start, default_locale) VALUES ('Compte A', 'Europe/Paris', 1, 'fr');
    INSERT INTO accounts (name, timezone, week_start, default_locale, capacity_thresholds) VALUES ('Compte B', 'America/New_York', 7, 'en', '{"under_percent": 60, "note": "garde"}');
    INSERT INTO account_members (account_id, user_id, role) VALUES (1,1,'owner'), (1,2,'admin'), (1,3,'project_manager'), (1,4,'member'), (1,5,'guest'), (2,6,'admin');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);
// Chaque test part du compte A d'origine (les versions avancent, le contenu est remis).
beforeEach(async () => {
  await pg.exec(`UPDATE accounts SET timezone = 'Europe/Paris', week_start = 1, default_locale = 'fr', capacity_thresholds = '{"under_percent": 80}' WHERE id = 1`);
});

describe("GET /api/v1/account", () => {
  it("tout membre lit les réglages de son compte, forme du contrat", async () => {
    for (const who of ["owner", "admin", "pm", "member", "guest"]) {
      const r = await get(who);
      expect(r.status).toBe(200);
      const body = AccountSettings.parse(r.body);
      expect(body).toMatchObject({ id: "1", name: "Compte A", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr", capacityThresholds: { underPercent: 80 } });
      expect(body.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("borné au compte de la requête ; 401 sans authentification", async () => {
    expect((await get("other")).body).toMatchObject({ id: "2", name: "Compte B", timezone: "America/New_York", weekStart: 7, defaultLocale: "en", capacityThresholds: { underPercent: 60 } });
    const anon = await get("anon");
    expect([anon.status, code(anon)]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("PATCH /api/v1/account : droits et préconditions", () => {
  it("project_manager, member et guest : 403 FORBIDDEN, avant la lecture du corps et de If-Match", async () => {
    for (const who of ["pm", "member", "guest"]) {
      const r = await patch(who, "pas du json");
      expect([r.status, code(r)]).toEqual([403, "FORBIDDEN"]);
      expect(params(r)).toEqual({ role: users[who]!.role });
    }
    expect((await patch("anon", { weekStart: 2 }, 1)).status).toBe(401);
  });

  it("If-Match absent : 428 ; mal formé : 400 ; version périmée : 409 avec la version courante, rien n'est écrit", async () => {
    const r428 = await patch("admin", { weekStart: 2 });
    expect([r428.status, code(r428)]).toEqual([428, "PRECONDITION_REQUIRED"]);
    const r400 = await patch("admin", { weekStart: 2 }, "3");
    expect([r400.status, params(r400)]).toEqual([400, { field: "If-Match" }]);
    const v = await version();
    const r409 = await patch("admin", { weekStart: 2 }, v - 1);
    expect([r409.status, code(r409), params(r409)]).toEqual([409, "VERSION_CONFLICT", { currentVersion: v }]);
    expect(AccountSettings.parse((await get("owner")).body)).toMatchObject({ version: v, weekStart: 1 });
  });

  it.each([
    ["corps vide", {}, "body"],
    ["nom seul (lecture seule)", { name: "Renommé" }, "body"],
    ["fuseau inconnu de pg_timezone_names", { timezone: "Mars/Olympus_Mons" }, "timezone"],
    ["fuseau à la mauvaise casse", { timezone: "europe/paris" }, "timezone"],
    ["langue hors fr|en", { defaultLocale: "de" }, "defaultLocale"],
    ["semaine 0", { weekStart: 0 }, "weekStart"],
    ["semaine 8", { weekStart: 8 }, "weekStart"],
    ["seuil 0", { capacityThresholds: { underPercent: 0 } }, "capacityThresholds"],
    ["seuil 101", { capacityThresholds: { underPercent: 101 } }, "capacityThresholds"],
  ])("400 VALIDATION_FAILED : %s", async (_n, body, field) => {
    const v = await version();
    const r = await patch("owner", body, v);
    expect([r.status, code(r), params(r)]).toEqual([400, "VALIDATION_FAILED", { field }]);
    expect(await version()).toBe(v);
  });
});

describe("PATCH /api/v1/account : écriture", () => {
  it("owner : tous les champs, nouvelle version, réponse = relecture", async () => {
    const v = await version();
    const r = await patch("owner", { timezone: "America/New_York", weekStart: 7, defaultLocale: "en", capacityThresholds: { underPercent: 65 } }, v);
    expect(r.status).toBe(200);
    const body = AccountSettings.parse(r.body);
    expect(body).toEqual({ id: "1", version: v + 1, name: "Compte A", timezone: "America/New_York", weekStart: 7, defaultLocale: "en", capacityThresholds: { underPercent: 65 } });
    expect((await get("member")).body).toEqual(body);
  });

  it("admin : un champ seul, les autres inchangés ; seuil décimal gardé tel quel", async () => {
    const v = await version();
    const r = await patch("admin", { capacityThresholds: { underPercent: 72.5 } }, v);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: v + 1, timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr", capacityThresholds: { underPercent: 72.5 } });
  });

  it("GET /me voit le nouveau fuseau, la semaine et la langue", async () => {
    await patch("admin", { timezone: "Asia/Tokyo", weekStart: 7, defaultLocale: "en" }, await version());
    const me = Me.parse((await send("member", "GET", "/api/v1/me")).body);
    expect(me.account).toMatchObject({ timezone: "Asia/Tokyo", weekStart: 7, defaultLocale: "en" });
  });

  it("GET /schedule voit le nouveau seuil, la semaine et le fuseau", async () => {
    await patch("owner", { capacityThresholds: { underPercent: 50 }, weekStart: 3, timezone: "UTC" }, await version());
    const s = ScheduleResponse.parse((await send("guest", "GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06")).body);
    expect(s.account).toEqual({ weekStart: 3, capacityThresholds: { underPercent: 50 }, timezone: "UTC" });
  });

  it("isolation : l'admin du compte B n'écrit que le sien, et les autres clés des seuils sont gardées", async () => {
    const before = AccountSettings.parse((await get("owner")).body);
    const vb = AccountSettings.parse((await get("other")).body).version;
    const r = await patch("other", { capacityThresholds: { underPercent: 90 } }, vb);
    expect(r.body).toMatchObject({ id: "2", capacityThresholds: { underPercent: 90 } });
    expect((await get("owner")).body).toEqual(before);
    const raw = (await pg.query<{ t: unknown }>("SELECT capacity_thresholds AS t FROM accounts WHERE id = 2")).rows[0]!.t;
    expect(raw).toEqual({ under_percent: 90, note: "garde" });
  });

  it("auteur de la modification : modified_by = l'utilisateur de la requête", async () => {
    await patch("admin", { weekStart: 2 }, await version());
    const row = (await pg.query<{ by: string }>("SELECT modified_by::text AS by FROM accounts WHERE id = 1")).rows[0]!;
    expect(row.by).toBe("2");
  });
});
