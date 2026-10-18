// Jalons de projet contre schema.sql réel (PGlite) : écriture, lecture filtrée, rôles, isolation, journalisation des suppressions.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { Milestone, MilestoneList } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMilestone, deleteMilestone, dispatch, updateMilestone, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-14
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const roles: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "1", role: "admin" },
  pm: { accountId: "1", userId: "1", role: "project_manager" },
  member: { accountId: "1", userId: "1", role: "member" },
  guest: { accountId: "1", userId: "1", role: "guest" },
  other: { accountId: "2", userId: "1", role: "admin" },
  anon: null,
};
const deps: HttpDeps = { db, authenticate: async (h) => roles[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, body?: unknown, version?: number | string) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(version === undefined ? {} : { "if-match": `"${version}"` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await pg.query<{ n: string }>(sql)).rows[0]!.n);
type Page = { items: { id: string; name: string; projectId: string; phaseId: string | null; dueDate: string }[]; page: { nextCursor: string | null; total: number } };
const url = "/api/v1/milestones";
const names = (r: { body: unknown }) => (r.body as Page).items.map((m) => m.name);

// Projets A : 1 P1, 2 P2 ; B : 3 Q. Phases : 1 (P1), 2 (P2), 3 (Q).
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO projects (account_id, name) VALUES (1,'P1'), (1,'P2'), (2,'Q');
    INSERT INTO phases (account_id, project_id, name) VALUES (1,1,'Ph1'), (1,2,'Ph2'), (2,3,'PhQ');
    INSERT INTO milestones (account_id, project_id, name, due_date) VALUES (2, 3, 'Jalon étranger', '2026-06-01');
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("rôles", () => {
  it("owner, admin et project_manager écrivent ; member et guest non (403) ; anonyme 401 ; tous les membres lisent", async () => {
    const create = { projectId: "1", name: "Rôles", dueDate: "2026-06-30" };
    for (const who of ["owner", "admin", "pm"]) expect((await send(who, "POST", url, create)).status).toBe(201);
    for (const who of ["member", "guest"]) {
      const r = await send(who, "POST", url, create);
      expect(r.status).toBe(403);
      expect(err(r).code).toBe("FORBIDDEN");
      expect((await send(who, "GET", url)).status).toBe(200);
    }
    expect((await send("anon", "POST", url, create)).status).toBe(401);
    expect((await send("anon", "GET", url)).status).toBe(401);
    await pg.exec("DELETE FROM milestones WHERE name = 'Rôles'");
  });
});

describe("écriture", () => {
  it("crée (201) : forme du contrat, version 1, phase facultative", async () => {
    const a = Milestone.parse((await send("pm", "POST", url, { projectId: "1", name: "Livraison", dueDate: "2026-06-30" })).body);
    expect(a).toMatchObject({ projectId: "1", phaseId: null, name: "Livraison", dueDate: "2026-06-30", version: 1 });
    const b = Milestone.parse((await send("pm", "POST", url, { projectId: "1", name: "Recette", dueDate: "2026-05-15", phaseId: "1" })).body);
    expect(b.phaseId).toBe("1");
  });
  it("corps invalide : 400 VALIDATION_FAILED (champ nommé) ; rôle contrôlé avant le corps", async () => {
    for (const [b, field] of [[{ name: "x", dueDate: "2026-06-30" }, "projectId"], [{ projectId: "1", dueDate: "2026-06-30" }, "name"], [{ projectId: "1", name: "x" }, "dueDate"], [{ projectId: "1", name: "x", dueDate: "2026-02-30" }, "dueDate"]] as const) {
      const r = await send("pm", "POST", url, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(err(r)).toMatchObject({ code: "VALIDATION_FAILED", params: { field } });
    }
    expect((await send("member", "POST", url, {})).status).toBe(403);
  });
  it("phase d'un autre projet, d'un autre compte ou illisible : 404 entity phase ; rien n'est écrit", async () => {
    for (const phaseId of ["2", "3", "abc", "999"]) {
      const r = await send("pm", "POST", url, { projectId: "1", name: "Refusé", dueDate: "2026-06-30", phaseId });
      expect(r.status, phaseId).toBe(404);
      expect(err(r).params.entity).toBe("phase");
    }
    expect(await n("SELECT count(*) AS n FROM milestones WHERE name = 'Refusé'")).toBe(0);
  });
  it("projet inconnu, d'un autre compte ou illisible : 404 entity project", async () => {
    for (const projectId of ["999", "3", "abc"]) {
      const r = await send("pm", "POST", url, { projectId, name: "x", dueDate: "2026-06-30" });
      expect(r.status).toBe(404);
      expect(err(r).params.entity).toBe("project");
    }
  });
  it("modifie : nom, échéance, phase posée puis retirée ; projet immuable ; phase d'un autre projet refusée ; champs conservés", async () => {
    const m = Milestone.parse((await send("pm", "POST", url, { projectId: "2", name: "Bêta", dueDate: "2026-09-01" })).body);
    let r = await send("pm", "PATCH", `${url}/${m.id}`, { dueDate: "2026-09-15" }, 1);
    expect(Milestone.parse(r.body)).toMatchObject({ name: "Bêta", dueDate: "2026-09-15", phaseId: null, version: 2 });
    r = await send("pm", "PATCH", `${url}/${m.id}`, { phaseId: "2", name: "Bêta 2", projectId: "1" }, 2);
    expect(Milestone.parse(r.body)).toMatchObject({ projectId: "2", phaseId: "2", name: "Bêta 2", dueDate: "2026-09-15" });
    r = await send("pm", "PATCH", `${url}/${m.id}`, { phaseId: "1" }, 3);
    expect(r.status).toBe(404);
    expect(err(r).params.entity).toBe("phase");
    r = await send("pm", "PATCH", `${url}/${m.id}`, { name: "Bêta 3" }, 3); // le refus ci-dessus n'a rien modifié
    expect(Milestone.parse(r.body)).toMatchObject({ phaseId: "2", version: 4 });
    r = await send("pm", "PATCH", `${url}/${m.id}`, { phaseId: null }, 4);
    expect(Milestone.parse(r.body).phaseId).toBeNull();
  });
  it("verrou optimiste : version périmée 409 avec la version courante ; en-tête absent 428 ; corps vide 400", async () => {
    const m = Milestone.parse((await send("pm", "POST", url, { projectId: "1", name: "Verrou", dueDate: "2026-07-01" })).body);
    const stale = await send("pm", "PATCH", `${url}/${m.id}`, { name: "x" }, 7);
    expect(stale.status).toBe(409);
    expect(err(stale)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 1 } });
    expect((await send("pm", "PATCH", `${url}/${m.id}`, { name: "x" })).status).toBe(428);
    expect((await send("pm", "PATCH", `${url}/${m.id}`, {}, 1)).status).toBe(400);
  });
});

describe("lecture", () => {
  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO milestones (account_id, project_id, phase_id, name, due_date) VALUES
        (1, 2, 2, 'L1', '2027-01-10'), (1, 2, NULL, 'L2', '2027-02-10'), (1, 2, 2, 'L3', '2027-03-10'), (1, 2, NULL, 'L4', '2027-03-10');
    `);
  });
  const qs = (extra: string) => `${url}?projectId=2&${extra}`;
  it("liste paginée au contrat, tout membre ; autre compte isolé", async () => {
    const r = await send("guest", "GET", qs("dueFrom=2027-01-01"));
    expect(MilestoneList.safeParse(r.body).success).toBe(true);
    expect(names(r)).toEqual(["L1", "L2", "L3", "L4"]);
    const all = await send("member", "GET", url);
    expect(names(all)).not.toContain("Jalon étranger");
    expect(names(await send("other", "GET", url))).toEqual(["Jalon étranger"]);
  });
  it("filtres projet et phase", async () => {
    expect(names(await send("member", "GET", qs("phaseId=2&dueFrom=2027-01-01")))).toEqual(["L1", "L3"]);
    expect(names(await send("member", "GET", `${url}?projectId=1&dueFrom=2027-01-01`))).toEqual([]);
    expect(names(await send("member", "GET", `${url}?projectId=3`))).toEqual([]); // le projet d'un autre compte ne révèle rien
  });
  it("intervalle d'échéance : bornes incluses, indépendantes ; inversé = vide", async () => {
    expect(names(await send("member", "GET", qs("dueFrom=2027-02-10&dueTo=2027-03-10")))).toEqual(["L2", "L3", "L4"]);
    expect(names(await send("member", "GET", qs("dueFrom=2027-01-01&dueTo=2027-01-10")))).toEqual(["L1"]);
    expect(names(await send("member", "GET", qs("dueFrom=2027-03-11")))).toEqual([]);
    expect(names(await send("member", "GET", qs("dueTo=2027-01-09&dueFrom=2027-01-01")))).toEqual([]);
    expect(names(await send("member", "GET", qs("dueFrom=2027-03-10&dueTo=2027-01-01")))).toEqual([]);
  });
  it("le total suit les filtres ; pagination sans doublon ni trou", async () => {
    expect(((await send("member", "GET", qs("dueFrom=2027-01-01"))).body as Page).page.total).toBe(4);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = (await send("member", "GET", `${qs("dueFrom=2027-01-01&limit=3")}${cursor ? `&cursor=${cursor}` : ""}`)).body as Page;
      expect(r.page.total).toBe(4);
      seen.push(...r.items.map((m) => m.name));
      cursor = r.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["L1", "L2", "L3", "L4"]);
  });
  it("paramètre illisible : 400 VALIDATION_FAILED ; lecture par id (autre compte, inconnu, illisible : 404 milestone)", async () => {
    for (const [q, field] of [["dueFrom=hier", "dueFrom"], ["dueTo=2027-13-01", "dueTo"], ["phaseId=x", "phaseId"], ["projectId=", "projectId"]] as const) {
      const r = await send("member", "GET", `${url}?${q}`);
      expect(r.status, q).toBe(400);
      expect(err(r).params.field).toBe(field);
    }
    const one = (await pg.query<{ id: string }>("SELECT id FROM milestones WHERE name = 'L1'")).rows[0]!.id;
    expect(Milestone.parse((await send("guest", "GET", `${url}/${one}`)).body)).toMatchObject({ name: "L1", dueDate: "2027-01-10", version: 1 });
    const foreign = String((await pg.query<{ id: string }>("SELECT id FROM milestones WHERE account_id = 2")).rows[0]!.id);
    for (const id of [foreign, "99999", "abc"]) {
      const r = await send("member", "GET", `${url}/${id}`);
      expect(r.status, id).toBe(404);
      expect(err(r).params.entity).toBe("milestone");
    }
    for (const [m, b] of [["PATCH", { name: "x" }], ["DELETE"]] as const) expect((await send("admin", m, `${url}/${foreign}`, b, 1)).status).toBe(404);
    expect(await n("SELECT count(*) AS n FROM milestones WHERE account_id = 2")).toBe(1);
  });
});

describe("suppression", () => {
  it("libre, journalisée (BR-14), refusée à member ; version périmée 409 ; un jalon supprimé n'est plus lisible", async () => {
    const m = Milestone.parse((await send("pm", "POST", url, { projectId: "1", name: "À supprimer", dueDate: "2026-12-01" })).body);
    expect((await send("member", "DELETE", `${url}/${m.id}`, undefined, 1)).status).toBe(403);
    expect((await send("pm", "DELETE", `${url}/${m.id}`, undefined, 9)).status).toBe(409);
    expect((await send("pm", "DELETE", `${url}/${m.id}`, undefined, 1)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = 'milestones' AND entity_id = ${m.id}`)).toBe(1);
    expect((await send("pm", "GET", `${url}/${m.id}`)).status).toBe(404);
    expect((await send("pm", "DELETE", `${url}/${m.id}`, undefined, 1)).status).toBe(404);
  });
  it("supprimer le projet ou la phase : une phase qui porte un jalon est refusée (jalons comptés)", async () => {
    await send("pm", "POST", url, { projectId: "1", name: "Sur phase", dueDate: "2026-12-01", phaseId: "1" });
    const r = await send("pm", "DELETE", "/api/v1/phases/1", undefined, 1);
    expect(r.status).toBe(409);
    expect(err(r).params.milestones).toBeGreaterThan(0);
    expect(await n("SELECT count(*) AS n FROM milestones WHERE name = 'Sur phase'")).toBe(1);
  });
});

describe("hors temps réel", () => {
  it("ces écritures ne produisent aucun changement dans le journal du Schedule", async () => {
    const before = await n("SELECT count(*) AS n FROM change_log WHERE account_id = 1");
    const m = Milestone.parse((await send("pm", "POST", url, { projectId: "1", name: "Silence", dueDate: "2026-12-01" })).body);
    await send("pm", "PATCH", `${url}/${m.id}`, { name: "Silence 2" }, 1);
    await send("pm", "DELETE", `${url}/${m.id}`, undefined, 2);
    expect(await n("SELECT count(*) AS n FROM change_log WHERE account_id = 1")).toBe(before);
  });
});

describe("garde de rôle dans les fonctions elles-mêmes (en plus de la couche HTTP)", () => {
  const member = roles.member!;
  it.each([
    ["createMilestone", () => createMilestone(db, member, { projectId: "1", name: "x", dueDate: "2026-06-30" })],
    ["updateMilestone", () => updateMilestone(db, member, "1", 1, { name: "x" })],
    ["deleteMilestone", () => deleteMilestone(db, member, "1", 1)],
  ])("%s refuse un membre", async (_n, call) => {
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
