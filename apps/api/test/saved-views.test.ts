// Vues sauvegardées contre schema.sql + migration 0003 réels (PGlite) : visibilité, droits par rôle, unicité, verrou optimiste, multi-compte.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SavedView, SavedViewList } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// Utilisateurs du compte 1 : 1 owner, 2 admin, 3 project_manager, 4 member, 5 guest ; utilisateur 6 : admin du compte 2.
const users: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "2", role: "admin" },
  pm: { accountId: "1", userId: "3", role: "project_manager" },
  member: { accountId: "1", userId: "4", role: "member" },
  guest: { accountId: "1", userId: "5", role: "guest" },
  ghost: { accountId: "1", userId: "99", role: "admin" }, // authentifié mais sans appartenance au compte
  other: { accountId: "2", userId: "6", role: "admin" },
  anon: null,
};
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const deps: HttpDeps = { db, authenticate: async (h) => users[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, version?: number) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(version === undefined ? {} : { "if-match": `"${version}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const code = (r: { body: unknown }) => (r.body as { code: string }).code;
const create = async (who: string, name: string, extra: object = {}) => (await send(who, "POST", "/api/v1/saved-views", { name, ...extra })).body as SavedView;
const names = async (who: string) => ((await send(who, "GET", "/api/v1/saved-views")).body as SavedViewList).items.map((v) => v.name).sort();

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0003_saved_views.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) SELECT 'u' || g || '@x.test' FROM generate_series(1, 6) g;
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO account_members (account_id, user_id, role) VALUES (1,1,'owner'), (1,2,'admin'), (1,3,'project_manager'), (1,4,'member'), (1,5,'guest'), (2,6,'admin');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("/api/v1/saved-views", () => {
  it("crée une vue privée (201, forme du contrat, version 1, canManage), pour tout rôle", async () => {
    for (const who of ["owner", "admin", "pm", "member", "guest"]) {
      const r = await send(who, "POST", "/api/v1/saved-views", { name: `Mes équipes ${who}`, filters: { departmentIds: ["1"], zoom: "week" } });
      expect(r.status).toBe(201);
      expect(SavedView.safeParse(r.body).success).toBe(true);
      expect(r.body).toMatchObject({ version: 1, kind: "schedule", shared: false, position: 0, canManage: true, filters: { departmentIds: ["1"], zoom: "week" } });
    }
  });

  it("densité d'affichage (RT-007) : enregistrée, relue, modifiée ; une vue sans densité n'en porte pas ; valeur inconnue : 400", async () => {
    const v = await create("member", "Aérée", { filters: { density: "airy", zoom: "week" } });
    expect(v.filters).toEqual({ density: "airy", zoom: "week" });
    const list = (await send("member", "GET", "/api/v1/saved-views")).body as { items: SavedView[] };
    expect(list.items.find((x) => x.id === v.id)?.filters.density).toBe("airy");
    const patched = await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, { filters: { density: "compact" } }, 1);
    expect([patched.status, (patched.body as SavedView).filters]).toEqual([200, { density: "compact" }]);
    expect((await create("member", "Sans densité")).filters).toEqual({});
    const bad = await send("member", "POST", "/api/v1/saved-views", { name: "x", filters: { density: "dense" } });
    expect([bad.status, code(bad)]).toEqual([400, "VALIDATION_FAILED"]);
  });

  it("refuse sans authentification (401) et rejette les corps invalides (400) : clé de filtre inconnue, nom vide, corps vide", async () => {
    expect((await send("anon", "GET", "/api/v1/saved-views")).status).toBe(401);
    expect((await send("anon", "POST", "/api/v1/saved-views", { name: "x" })).status).toBe(401);
    for (const bad of [{ name: "" }, { name: "  " }, { name: "x", filters: { inconnu: 1 } }, { name: "x", filters: { zoom: "year" } }, { name: "x", kind: "projects" }, {}]) {
      const r = await send("member", "POST", "/api/v1/saved-views", bad);
      expect([r.status, code(r)]).toEqual([400, "VALIDATION_FAILED"]);
    }
  });

  it("un nom déjà pris par le même utilisateur : ALREADY_EXISTS ; un autre utilisateur peut réutiliser le nom", async () => {
    await create("member", "Doublon");
    const again = await send("member", "POST", "/api/v1/saved-views", { name: "Doublon" });
    expect([again.status, code(again)]).toEqual([409, "ALREADY_EXISTS"]);
    expect(again.body).toMatchObject({ params: { entity: "saved_view", field: "name" } });
    expect((await send("guest", "POST", "/api/v1/saved-views", { name: "Doublon" })).status).toBe(201);
  });

  it("partager exige owner, admin ou project_manager (FORBIDDEN pour member et guest, rien n'est écrit)", async () => {
    for (const who of ["member", "guest"]) {
      const r = await send(who, "POST", "/api/v1/saved-views", { name: "Partagée refusée", shared: true });
      expect([r.status, code(r)]).toEqual([403, "FORBIDDEN"]);
    }
    expect(await names("owner")).not.toContain("Partagée refusée");
    for (const who of ["owner", "admin", "pm"]) expect((await send(who, "POST", "/api/v1/saved-views", { name: `Partagée ${who}`, shared: true })).status).toBe(201);
  });

  it("visibilité : mes vues + les vues partagées du compte, jamais les vues privées d'un autre ni d'un autre compte", async () => {
    await create("pm", "Privée PM");
    const mine = await names("pm");
    expect(mine).toContain("Privée PM");
    expect(mine).toEqual(expect.arrayContaining(["Partagée owner", "Partagée admin", "Partagée pm"]));
    expect(mine).not.toContain("Mes équipes owner");
    expect(await names("guest")).not.toContain("Privée PM");
    expect(await names("other")).toEqual([]);
    const priv = (await create("member", "Privée membre")).id;
    expect((await send("pm", "GET", `/api/v1/saved-views/${priv}`)).status).toBe(404);
    expect((await send("other", "GET", `/api/v1/saved-views/${priv}`)).status).toBe(404);
    expect((await send("member", "GET", `/api/v1/saved-views/${priv}`)).status).toBe(200);
  });

  it("un utilisateur sans appartenance au compte ne peut pas créer de vue (FORBIDDEN, pas de 500)", async () => {
    const r = await send("ghost", "POST", "/api/v1/saved-views", { name: "Fantôme" });
    expect([r.status, code(r)]).toEqual([403, "FORBIDDEN"]);
  });

  it("filtre par kind et pagine par curseur (limit, nextCursor, total)", async () => {
    const first = (await send("owner", "GET", "/api/v1/saved-views?limit=2")).body as SavedViewList;
    expect(first.items).toHaveLength(2);
    expect(first.page.nextCursor).toBeTypeOf("string");
    const second = (await send("owner", "GET", `/api/v1/saved-views?limit=2&cursor=${first.page.nextCursor}`)).body as SavedViewList;
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(first.page.total).toBeGreaterThan(2);
    expect(((await send("owner", "GET", "/api/v1/saved-views?kind=schedule")).body as SavedViewList).page.total).toBe(first.page.total);
    expect(code(await send("owner", "GET", "/api/v1/saved-views?kind=projects"))).toBe("VALIDATION_FAILED");
    expect(code(await send("owner", "GET", "/api/v1/saved-views?cursor=zzz"))).toBe("SCHEDULE_CURSOR_INVALID");
  });

  it("modifie avec If-Match (version +1) ; version périmée : VERSION_CONFLICT ; If-Match absent : 428", async () => {
    const v = await create("member", "A modifier");
    const ok = await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, { name: "Modifiée", filters: { roleIds: ["2"], peopleSort: "role" }, position: 3 }, 1);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Modifiée", version: 2, position: 3, filters: { roleIds: ["2"], peopleSort: "role" } });
    const stale = await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, { name: "Encore" }, 1);
    expect(stale.body).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
    expect(code(await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, { name: "Encore" }))).toBe("PRECONDITION_REQUIRED");
    expect(code(await send("member", "DELETE", `/api/v1/saved-views/${v.id}`, undefined, 1))).toBe("VERSION_CONFLICT");
    expect(code(await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, {}, 2))).toBe("VALIDATION_FAILED");
  });

  it("renommer vers un nom déjà pris : ALREADY_EXISTS", async () => {
    const a = await create("guest", "Nom A");
    await create("guest", "Nom B");
    expect(code(await send("guest", "PATCH", `/api/v1/saved-views/${a.id}`, { name: "Nom B" }, 1))).toBe("ALREADY_EXISTS");
  });

  it("la vue privée d'un autre : NOT_FOUND en modification et suppression (même pour un admin) ; autre compte : NOT_FOUND", async () => {
    const v = await create("member", "Secrète");
    for (const who of ["admin", "owner", "other"]) {
      expect(code(await send(who, "PATCH", `/api/v1/saved-views/${v.id}`, { name: "Piratée" }, 1))).toBe("NOT_FOUND");
      expect(code(await send(who, "DELETE", `/api/v1/saved-views/${v.id}`, undefined, 1))).toBe("NOT_FOUND");
    }
    expect(code(await send("member", "PATCH", "/api/v1/saved-views/abc", { name: "x" }, 1))).toBe("NOT_FOUND");
    expect(code(await send("member", "PATCH", "/api/v1/saved-views/999999", { name: "x" }, 1))).toBe("NOT_FOUND");
  });

  it("vue partagée d'un autre : owner et admin la gèrent (canManage), pm et member non (FORBIDDEN) ; ils ne changent pas `shared`", async () => {
    const v = await create("pm", "Partagée gérée", { shared: true });
    expect(v.canManage).toBe(true);
    const asMember = (await send("member", "GET", `/api/v1/saved-views/${v.id}`)).body as SavedView;
    expect(asMember.canManage).toBe(false);
    expect(((await send("owner", "GET", `/api/v1/saved-views/${v.id}`)).body as SavedView).canManage).toBe(true);
    expect(code(await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, { name: "Non" }, 1))).toBe("FORBIDDEN");
    expect(code(await send("guest", "DELETE", `/api/v1/saved-views/${v.id}`, undefined, 1))).toBe("FORBIDDEN");
    const other = await create("owner", "Partagée gérée", { shared: true }); // même nom, autre propriétaire : autorisé
    expect(code(await send("pm", "PATCH", `/api/v1/saved-views/${other.id}`, { name: "Non" }, 1))).toBe("FORBIDDEN");
    expect(code(await send("admin", "PATCH", `/api/v1/saved-views/${v.id}`, { shared: false }, 1))).toBe("FORBIDDEN");
    const renamed = await send("admin", "PATCH", `/api/v1/saved-views/${v.id}`, { name: "Renommée par admin", filters: { personIds: ["1"] } }, 1);
    expect(renamed.body).toMatchObject({ name: "Renommée par admin", shared: true, ownerId: "3", version: 2 });
    expect((await send("admin", "DELETE", `/api/v1/saved-views/${v.id}`, undefined, 2)).status).toBe(204);
    expect((await send("pm", "GET", `/api/v1/saved-views/${v.id}`)).status).toBe(404);
  });

  it("le propriétaire partage et reprivatise sa vue ; partager reste réservé aux rôles d'écriture", async () => {
    const v = await create("member", "A partager");
    expect(code(await send("member", "PATCH", `/api/v1/saved-views/${v.id}`, { shared: true }, 1))).toBe("FORBIDDEN");
    const mine = await create("pm", "Devient partagée");
    const shared = await send("pm", "PATCH", `/api/v1/saved-views/${mine.id}`, { shared: true }, 1);
    expect(shared.body).toMatchObject({ shared: true, version: 2 });
    expect(await names("guest")).toContain("Devient partagée");
    const back = await send("pm", "PATCH", `/api/v1/saved-views/${mine.id}`, { shared: false }, 2);
    expect(back.body).toMatchObject({ shared: false, version: 3 });
    expect(await names("guest")).not.toContain("Devient partagée");
  });

  it("supprime avec If-Match (204), puis NOT_FOUND ; le propriétaire supprime sa vue partagée", async () => {
    const v = await create("pm", "A supprimer", { shared: true });
    expect((await send("pm", "DELETE", `/api/v1/saved-views/${v.id}`, undefined, 1)).status).toBe(204);
    expect(code(await send("pm", "DELETE", `/api/v1/saved-views/${v.id}`, undefined, 1))).toBe("NOT_FOUND");
    expect(code(await send("pm", "DELETE", `/api/v1/saved-views/${v.id}`))).toBe("PRECONDITION_REQUIRED");
  });

  it("RLS (migration 0003) : sans filtre applicatif, la base cache la vue privée d'un autre utilisateur du compte", async () => {
    const seen = await pg.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE app_user");
      await tx.query("SELECT set_config('app.account_id', '1', true), set_config('app.user_id', '5', true)");
      return (await tx.query<{ name: string }>("SELECT name FROM saved_views")).rows.map((r) => r.name);
    });
    expect(seen).toContain("Partagée owner");
    expect(seen).not.toContain("Privée PM");
    expect(seen).not.toContain("Secrète");
  });
});
