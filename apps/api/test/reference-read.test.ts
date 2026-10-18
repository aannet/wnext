// Lecture des entités de référence (liste paginée, lecture par id) contre schema.sql réel (PGlite).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DepartmentList, HolidayList, ProjectDetail, ProjectList, RoleList, ScheduleDepartment, ScheduleHoliday, ScheduleRole, ScheduleTimeoffType, TimeoffTypeList } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  member: { accountId: "1", userId: "1", role: "member" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const get = (who: string, url: string) => dispatch(deps, { method: "GET", url, headers: { authorization: who } });
type Page = { items: Array<{ id: string; version: number }>; page: { nextCursor: string | null; total: number } };
const page = (r: { body: unknown }) => r.body as Page;
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, unknown> };

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (2,'intrus');
    INSERT INTO departments (account_id, name) SELECT 1, 'D' || g FROM generate_series(1, 5) g;
    INSERT INTO departments (account_id, name) VALUES (2, 'Autre compte');
    INSERT INTO roles (account_id, name) VALUES (1, 'Senior'), (1, 'Junior'), (2, 'Intrus');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances'), (2, 'Intrus');
    INSERT INTO holidays (account_id, name, hdate) VALUES (1, 'Nouvel an', '2026-01-01'), (1, 'Noël', '2026-12-25'), (1, 'Pâques', '2026-04-06'), (2, 'Intrus', '2026-05-01');
    INSERT INTO projects (account_id, name, status, tags, notes) VALUES (1, 'Actif', 'in_progress', '{a,b}', 'n'), (1, 'Prévu', 'planned', '{}', NULL), (1, 'Vieux', 'archived', '{}', NULL), (2, 'Intrus', 'in_progress', '{}', NULL);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

const entities = [
  { path: "departments", list: DepartmentList, one: ScheduleDepartment, total: 5 },
  { path: "roles", list: RoleList, one: ScheduleRole, total: 2 },
  { path: "timeoff-types", list: TimeoffTypeList, one: ScheduleTimeoffType, total: 1 },
  { path: "holidays", list: HolidayList, one: ScheduleHoliday, total: 3 },
  { path: "projects", list: ProjectList, one: ProjectDetail, total: 2 }, // l'archivé n'est pas listé par défaut
] as const;

describe.each(entities)("GET /api/v1/$path", ({ path, list, one, total }) => {
  const url = `/api/v1/${path}`;

  it.each(["owner", "member"])("liste pour le rôle %s : forme du contrat, tri par id, uniquement le compte, total", async (who) => {
    const r = await get(who, url);
    expect(r.status).toBe(200);
    expect(list.safeParse(r.body).success).toBe(true);
    const ids = page(r).items.map((i) => BigInt(i.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    expect(page(r).page).toEqual({ nextCursor: null, total });
    expect(page(r).items).toHaveLength(total);
    expect(JSON.stringify(r.body)).not.toContain("Intrus");
  });

  it("le compte voisin ne voit que ses lignes", async () => {
    const r = await get("other", url);
    expect(page(r).items.length).toBeGreaterThan(0);
    expect(page(r).items.length).toBe(page(r).page.total);
    const mine = new Set(page(await get("owner", url)).items.map((i) => i.id));
    expect(page(r).items.some((i) => mine.has(i.id))).toBe(false);
  });

  it("401 sans identité, y compris pour la lecture par id", async () => {
    expect((await get("anon", url)).status).toBe(401);
    expect((await get("anon", `${url}/1`)).status).toBe(401);
  });

  it("lecture par id : forme du contrat, version ; autre compte, inconnu et non numérique = 404", async () => {
    const first = page(await get("owner", url)).items[0]!;
    const r = await get("member", `${url}/${first.id}`);
    expect(r.status).toBe(200);
    expect(one.safeParse(r.body).success).toBe(true);
    expect(r.body).toEqual(first);
    const foreign = page(await get("other", url)).items[0]!.id;
    for (const id of [foreign, "999999", "abc", "%", "1;2"]) {
      const x = await get("owner", `${url}/${encodeURIComponent(id)}`);
      expect(x.status, id).toBe(404);
      expect(err(x).code).toBe("NOT_FOUND");
    }
  });

  it.each([
    ["limit nul", "limit=0", "limit"],
    ["limit trop grand", "limit=501", "limit"],
    ["limit décimal", "limit=1.5", "limit"],
    ["limit non numérique", "limit=abc", "limit"],
    ["paramètre inconnu", "foo=1", "foo"],
    ["paramètre répété", "limit=1&limit=2", "limit"],
  ])("400 VALIDATION_FAILED : %s", async (_n, qs, field) => {
    const r = await get("owner", `${url}?${qs}`);
    expect(r.status).toBe(400);
    expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
  });

  it.each(["!!!", "e30", "eyJpZCI6IjEifQ" + "x", Buffer.from('{"id":"abc"}').toString("base64url"), Buffer.from("pas du json").toString("base64url")])("curseur illisible %s : SCHEDULE_CURSOR_INVALID", async (c) => {
    const r = await get("owner", `${url}?cursor=${c}`);
    expect(r.status).toBe(400);
    expect(err(r).code).toBe("SCHEDULE_CURSOR_INVALID");
  });
});

describe("pagination", () => {
  it("parcourt tout sans trou ni doublon, total stable, dernière page sans curseur", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await get("owner", `/api/v1/departments?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      const p = page(r);
      expect(p.page.total).toBe(5);
      seen.push(...p.items.map((i) => i.id));
      cursor = p.page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(page(await get("owner", "/api/v1/departments")).items.map((i) => i.id));
  });

  it("page exacte : 5 éléments par pages de 5 = pas de curseur fantôme", async () => {
    expect(page(await get("owner", "/api/v1/departments?limit=5")).page.nextCursor).toBeNull();
  });

  it("un ajout pendant le parcours n'est ni dupliqué ni cause de trou", async () => {
    const first = page(await get("owner", "/api/v1/roles?limit=1"));
    await pg.exec("INSERT INTO roles (account_id, name) VALUES (1, 'Nouveau')");
    const second = page(await get("owner", `/api/v1/roles?limit=1&cursor=${first.page.nextCursor}`));
    const third = page(await get("owner", `/api/v1/roles?limit=5&cursor=${second.page.nextCursor}`));
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
    await pg.exec("DELETE FROM roles WHERE name = 'Nouveau'");
  });
});

describe("filtres", () => {
  it("fériés : from et to inclus, total des seuls correspondants, from > to refusé", async () => {
    const names = async (qs: string) => page(await get("owner", `/api/v1/holidays?${qs}`)).items.map((i) => (i as unknown as { name: string }).name).sort();
    expect(await names("from=2026-04-06&to=2026-12-25")).toEqual(["Noël", "Pâques"]);
    expect(await names("from=2026-12-25")).toEqual(["Noël"]);
    expect(await names("to=2026-01-01")).toEqual(["Nouvel an"]);
    expect(page(await get("owner", "/api/v1/holidays?from=2026-04-06&to=2026-12-25&limit=1")).page.total).toBe(2);
    const bad = await get("owner", "/api/v1/holidays?from=2026-12-25&to=2026-01-01");
    expect(bad.status).toBe(400);
    expect(err(bad).params.field).toBe("to");
    expect((await get("owner", "/api/v1/holidays?from=demain")).status).toBe(400);
  });

  it("projets : archivés exclus par défaut, listés sur demande ; détail complet", async () => {
    const all = page(await get("owner", "/api/v1/projects")).items as unknown as Array<{ name: string; status: string; tags: string[]; notes: string | null }>;
    expect(all.map((p) => p.name).sort()).toEqual(["Actif", "Prévu"]);
    expect(all.find((p) => p.name === "Actif")).toMatchObject({ tags: ["a", "b"], notes: "n" });
    const archived = page(await get("owner", "/api/v1/projects?status=archived"));
    expect(archived.page.total).toBe(1);
    expect((archived.items[0] as unknown as { name: string }).name).toBe("Vieux");
    expect(page(await get("owner", "/api/v1/projects?status=in_progress")).page.total).toBe(1);
    expect((await get("owner", "/api/v1/projects?status=perdu")).status).toBe(400);
    expect((await get("owner", `/api/v1/projects/${archived.items[0]!.id}`)).status).toBe(200); // par id : l'archivé reste lisible
  });
});

describe("lecture et écriture ensemble", () => {
  it("après un VERSION_CONFLICT, le GET donne la version courante à renvoyer", async () => {
    const a = { ...roles.owner!, role: "admin" as const };
    void a;
    const created = await dispatch(deps, { method: "POST", url: "/api/v1/roles", headers: { authorization: "owner" }, body: JSON.stringify({ name: "Conflit" }) });
    const id = (created.body as { id: string }).id;
    const patch = (v: number) => dispatch(deps, { method: "PATCH", url: `/api/v1/roles/${id}`, headers: { authorization: "owner", "if-match": `"${v}"` }, body: JSON.stringify({ name: `Conflit ${v}` }) });
    expect((await patch(1)).status).toBe(200);
    const stale = await patch(1);
    expect(stale.status).toBe(409);
    const current = (await get("member", `/api/v1/roles/${id}`)).body as { version: number };
    expect(current.version).toBe((stale.body as { params: { currentVersion: number } }).params.currentVersion);
    expect((await patch(current.version)).status).toBe(200);
  });
});
