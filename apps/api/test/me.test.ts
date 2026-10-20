// GET /api/v1/me contre schema.sql réel (PGlite, rôle app_user donc RLS active) : forme du contrat, matrice des rôles, personne liée ou non,
// nom affichable de repli, isolation entre comptes, 401.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Me } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// Compte 1 : 1 owner (lié à la personne 1), 2 admin (non planifié), 3 project_manager, 4 member (lié à la personne 2), 5 guest, 7 admin sans nom.
// Compte 2 : utilisateur 6 admin. L'utilisateur 8 appartient aux deux comptes.
const users: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "2", role: "admin" },
  pm: { accountId: "1", userId: "3", role: "project_manager" },
  member: { accountId: "1", userId: "4", role: "member" },
  guest: { accountId: "1", userId: "5", role: "guest" },
  nameless: { accountId: "1", userId: "7", role: "admin" },
  other: { accountId: "2", userId: "6", role: "admin" },
  both1: { accountId: "1", userId: "8", role: "member" },
  both2: { accountId: "2", userId: "8", role: "guest" },
  ghost: { accountId: "1", userId: "99", role: "admin" },
  anon: null,
};
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const deps: HttpDeps = { db, authenticate: async (h) => users[String(h.authorization)] ?? null, newRequestId: () => "r" };
const me = (who: string, method = "GET") => dispatch(deps, { method, url: "/api/v1/me", headers: { authorization: who } });

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email, name) VALUES ('alec@x.test','Alec Annet'), ('admin@x.test','Admin Dev'), ('pm@x.test','Paul Chef'), ('membre@x.test','Mia Membre'),
      ('guest@x.test','Gus Invité'), ('autre@x.test','Autre B');
    INSERT INTO users (email, name) VALUES ('sans.nom@x.test', NULL), ('deux@x.test', 'Deux Comptes');
    INSERT INTO accounts (name, timezone, week_start, default_locale) VALUES ('Compte A', 'Europe/Paris', 1, 'fr'), ('Compte B', 'America/New_York', 7, 'en');
    INSERT INTO people (account_id, name, email) VALUES (1, 'Alec Annet', 'alec@x.test'), (1, 'Mia Membre', 'membre@x.test'), (2, 'Personne B', 'pb@x.test');
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES
      (1,1,'owner',1), (1,2,'admin',NULL), (1,3,'project_manager',NULL), (1,4,'member',2), (1,5,'guest',NULL), (1,7,'admin',NULL),
      (2,6,'admin',NULL), (1,8,'member',NULL), (2,8,'guest',3);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /api/v1/me", () => {
  it("rend la forme du contrat pour chaque rôle, avec le rôle de la base", async () => {
    for (const [who, role, name] of [["owner", "owner", "Alec Annet"], ["admin", "admin", "Admin Dev"], ["pm", "project_manager", "Paul Chef"], ["member", "member", "Mia Membre"], ["guest", "guest", "Gus Invité"]] as const) {
      const r = await me(who);
      expect(r.status).toBe(200);
      const body = Me.parse(r.body);
      expect(body.role).toBe(role);
      expect(body.user.name).toBe(name);
      expect(body.account).toEqual({ id: "1", name: "Compte A", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr" });
    }
  });

  it("personne liée : id et nom si account_members.person_id, null sinon (admin, guest, pm non planifiés)", async () => {
    expect((await me("owner")).body).toMatchObject({ person: { id: "1", name: "Alec Annet" } });
    expect((await me("member")).body).toMatchObject({ person: { id: "2", name: "Mia Membre" } });
    for (const who of ["admin", "pm", "guest"]) expect((await me(who)).body).toMatchObject({ person: null });
  });

  it("nom affichable de repli : partie locale de l'e-mail quand users.name est vide", async () => {
    expect((await me("nameless")).body).toMatchObject({ user: { name: "sans.nom", email: "sans.nom@x.test" } });
  });

  it("borné au compte de la requête : un utilisateur de deux comptes voit le compte, le rôle et la personne de celui demandé", async () => {
    expect((await me("both1")).body).toMatchObject({ role: "member", person: null, account: { id: "1", name: "Compte A" } });
    expect((await me("both2")).body).toMatchObject({ role: "guest", person: { id: "3", name: "Personne B" }, account: { id: "2", name: "Compte B", timezone: "America/New_York", weekStart: 7, defaultLocale: "en" } });
    expect((await me("other")).body).toMatchObject({ user: { id: "6" }, account: { id: "2" }, person: null });
  });

  it("401 UNAUTHENTICATED sans authentification, et aussi quand l'utilisateur n'appartient pas au compte", async () => {
    const anon = await me("anon");
    expect([anon.status, (anon.body as { code: string }).code]).toEqual([401, "UNAUTHENTICATED"]);
    const ghost = await me("ghost");
    expect([ghost.status, (ghost.body as { code: string }).code]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("n'expose rien d'autre que le contrat (pas d'identifiant d'IdP ni de date de connexion)", async () => {
    const text = JSON.stringify((await me("owner")).body);
    expect(text).not.toMatch(/idp|subject|last_login|lastLogin/i);
  });
});
