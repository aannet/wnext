// Dépenses de projet et lignes de budget contre schema.sql réel (PGlite) : rôles (lecture comprise), montants, unicité, isolation.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { ProjectBudgetLine, ProjectBudgetLineList, ProjectExpense, ProjectExpenseList } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBudgetLine, createExpense, deleteBudgetLine, deleteExpense, dispatch, expenseReader, budgetLineReader, updateBudgetLine, updateExpense, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-14 @BR-22
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
type Page<T> = { items: T[]; page: { nextCursor: string | null; total: number } };
const EX = "/api/v1/project-expenses";
const BL = "/api/v1/project-budget-lines";

// Compte A (devise EUR) : projets 1 P1, 2 P2 ; personnes 1 hal ; tâches 1 (P1), 2 (P2). Compte B : projet 3, personne 2, tâche 3.
beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name, currency_code) VALUES ('A', 'EUR'), ('B', 'USD');
    INSERT INTO people (account_id, name) VALUES (1,'hal'), (2,'intrus');
    INSERT INTO projects (account_id, name) VALUES (1,'P1'), (1,'P2'), (2,'Q');
    INSERT INTO project_tasks (account_id, project_id, name) VALUES (1,1,'T1'), (1,2,'T2'), (2,3,'TQ');
    INSERT INTO project_expenses (account_id, project_id, name, amount, currency) VALUES (2, 3, 'Dépense étrangère', 10, 'USD');
    INSERT INTO project_budget_lines (account_id, project_id, project_task_id, hours) VALUES (2, 3, 3, 5);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe.each([
  ["dépenses", EX, [{ projectId: "1", name: "Rôles", amount: "10" }, { projectId: "1", name: "Rôles", amount: "10" }, { projectId: "1", name: "Rôles", amount: "10" }]],
  ["lignes de budget", BL, [{ projectId: "1", taskId: "1", hours: 8 }, { projectId: "1", personId: "1", hours: 8 }, { projectId: "2", personId: "1", hours: 8 }]],
])("rôles : %s", (_label, url, creates) => {
  const create = creates[0]!;
  it("owner, admin et project_manager lisent et écrivent ; member et guest : 403 en lecture comme en écriture ; anonyme 401", async () => {
    for (const [i, who] of ["owner", "admin", "pm"].entries()) {
      expect((await send(who, "GET", url)).status, who).toBe(200);
      expect((await send(who, "POST", url, creates[i]!)).status, who).toBe(201);
    }
    for (const who of ["member", "guest"]) {
      for (const [m, u, b] of [["GET", url], ["GET", `${url}/1`], ["POST", url, create], ["PATCH", `${url}/1`, { hours: 1, name: "x" }], ["DELETE", `${url}/1`]] as const) {
        const r = await send(who, m, u, b, 1);
        expect(r.status, `${who} ${m} ${u}`).toBe(403);
        expect(err(r).code).toBe("FORBIDDEN");
      }
    }
    for (const m of ["GET", "POST"]) expect((await send("anon", m, url, create)).status).toBe(401);
    await pg.exec("DELETE FROM project_budget_lines WHERE account_id = 1; DELETE FROM project_expenses WHERE account_id = 1");
  });
  it("le rôle est contrôlé avant la validation de la requête", async () => {
    expect((await send("member", "GET", `${url}?foo=1`)).status).toBe(403);
    expect((await send("anon", "GET", `${url}?foo=1`)).status).toBe(401);
  });
});

describe("dépenses", () => {
  it("crée (201) : forme du contrat, devise du compte par défaut, montant normalisé à 2 décimales", async () => {
    const a = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "Licences", amount: "1250.5" })).body);
    expect(a).toMatchObject({ projectId: "1", amount: "1250.50", currency: "EUR", spentOn: null, version: 1 });
    const b = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "Voyage", amount: "99", currency: "USD", spentOn: "2026-03-02" })).body);
    expect(b).toMatchObject({ amount: "99.00", currency: "USD", spentOn: "2026-03-02" });
    const c = ProjectExpense.parse((await send("other", "POST", EX, { projectId: "3", name: "B", amount: "1" })).body);
    expect(c.currency).toBe("USD"); // la devise du compte B, pas celle du compte A
  });
  it("montants extrêmes et exacts : pas d'arrondi flottant", async () => {
    const r = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "Gros", amount: "999999999999.99" })).body);
    expect(r.amount).toBe("999999999999.99");
    const z = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "Zéro", amount: "0" })).body);
    expect(z.amount).toBe("0.00");
    const c = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "Centimes", amount: "0.10" })).body);
    expect(c.amount).toBe("0.10");
  });
  it("corps invalide : 400 avec le champ ; projet inconnu / autre compte / illisible : 404 project", async () => {
    for (const [b, field] of [[{ name: "x", amount: "1" }, "projectId"], [{ projectId: "1", amount: "1" }, "name"], [{ projectId: "1", name: "x" }, "amount"], [{ projectId: "1", name: "x", amount: "-1" }, "amount"], [{ projectId: "1", name: "x", amount: "1", currency: "eur" }, "currency"]] as const) {
      const r = await send("pm", "POST", EX, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(err(r).params.field).toBe(field);
    }
    for (const projectId of ["999", "3", "abc"]) {
      const r = await send("pm", "POST", EX, { projectId, name: "x", amount: "1" });
      expect(r.status, projectId).toBe(404);
      expect(err(r).params.entity).toBe("project");
    }
  });
  it("modifie : champs conservés, date posée puis retirée, projet immuable, devise changeable", async () => {
    const e = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "2", name: "Mod", amount: "10.00", spentOn: "2026-03-02" })).body);
    let r = await send("pm", "PATCH", `${EX}/${e.id}`, { amount: "12.34", projectId: "1" }, 1);
    expect(ProjectExpense.parse(r.body)).toMatchObject({ projectId: "2", name: "Mod", amount: "12.34", currency: "EUR", spentOn: "2026-03-02", version: 2 });
    r = await send("pm", "PATCH", `${EX}/${e.id}`, { spentOn: null, currency: "GBP" }, 2);
    expect(ProjectExpense.parse(r.body)).toMatchObject({ spentOn: null, currency: "GBP", amount: "12.34" });
    expect((await send("pm", "PATCH", `${EX}/${e.id}`, { name: "x" }, 1)).status).toBe(409);
    expect((await send("pm", "PATCH", `${EX}/${e.id}`, {}, 3)).status).toBe(400);
    expect((await send("pm", "PATCH", `${EX}/${e.id}`, { name: "x" })).status).toBe(428);
  });
  describe("lecture", () => {
    beforeAll(async () => {
      await pg.exec(`
        INSERT INTO project_expenses (account_id, project_id, name, amount, currency, spent_on) VALUES
          (1, 2, 'D1', 1, 'EUR', '2027-01-10'), (1, 2, 'D2', 2, 'EUR', '2027-02-10'), (1, 2, 'D3', 3, 'EUR', NULL), (1, 2, 'D4', 4, 'EUR', '2027-03-10');
      `);
    });
    const names = (r: { body: unknown }) => (r.body as Page<{ name: string }>).items.map((x) => x.name);
    const q = (extra: string) => send("pm", "GET", `${EX}?projectId=2&${extra}`);
    it("filtre projet, intervalle de dates inclusif ; les sans-date sortent dès qu'une borne est donnée", async () => {
      expect(names(await q("spentFrom=2027-01-01"))).toEqual(["D1", "D2", "D4"]);
      expect(names(await q("spentFrom=2027-02-10&spentTo=2027-03-10"))).toEqual(["D2", "D4"]);
      expect(names(await q("spentTo=2027-01-10"))).toEqual(["D1"]);
      expect(names(await q("spentFrom=2027-03-11"))).toEqual([]);
      expect(names(await q("spentFrom=2027-03-10&spentTo=2027-01-01"))).toEqual([]);
      expect(names(await q("limit=500")).filter((x) => /^D\d$/.test(x))).toEqual(["D1", "D2", "D3", "D4"]);
    });
    it("page au contrat, total, pagination sans doublon ni trou ; paramètre illisible 400", async () => {
      const first = (await q("limit=3")).body as Page<{ name: string }>;
      expect(ProjectExpenseList.safeParse(first).success).toBe(true);
      const seen = [...first.items];
      let cursor = first.page.nextCursor;
      while (cursor) {
        const r = (await q(`limit=3&cursor=${cursor}`)).body as Page<{ name: string }>;
        seen.push(...r.items);
        cursor = r.page.nextCursor;
      }
      expect(seen.length).toBe(first.page.total);
      expect(new Set(seen.map((x) => x.name)).size).toBe(seen.length);
      for (const [qs, field] of [["spentFrom=hier", "spentFrom"], ["spentTo=2027-13-01", "spentTo"], ["projectId=x", "projectId"]] as const) {
        const r = await send("pm", "GET", `${EX}?${qs}`);
        expect([r.status, err(r).params.field]).toEqual([400, field]);
      }
    });
    it("isolation entre comptes : lecture, modification et suppression d'une dépense étrangère donnent 404", async () => {
      const foreign = String((await pg.query<{ id: string }>("SELECT id FROM project_expenses WHERE account_id = 2 AND name = 'Dépense étrangère'")).rows[0]!.id);
      expect(names(await send("pm", "GET", EX))).not.toContain("Dépense étrangère");
      for (const [m, b] of [["GET"], ["PATCH", { name: "x" }], ["DELETE"]] as const) {
        const r = await send("admin", m, `${EX}/${foreign}`, b, 1);
        expect(r.status, m).toBe(404);
        expect(err(r).params.entity).toBe("project_expense");
      }
      expect((await send("admin", "GET", `${EX}/abc`)).status).toBe(404);
      expect(await n("SELECT count(*) AS n FROM project_expenses WHERE name = 'Dépense étrangère'")).toBe(1);
    });
  });
  it("supprime : libre, journalisée (BR-14), version périmée 409, puis introuvable", async () => {
    const e = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "À supprimer", amount: "5" })).body);
    expect((await send("pm", "DELETE", `${EX}/${e.id}`, undefined, 9)).status).toBe(409);
    expect((await send("pm", "DELETE", `${EX}/${e.id}`, undefined, 1)).status).toBe(204);
    expect(await n(`SELECT count(*) AS n FROM delete_log WHERE entity = 'project_expenses' AND entity_id = ${e.id}`)).toBe(1);
    expect((await send("pm", "GET", `${EX}/${e.id}`)).status).toBe(404);
  });
});

describe("lignes de budget", () => {
  it("crée pour une tâche ou pour une personne ; heures seules, montant seul ou les deux", async () => {
    const a = ProjectBudgetLine.parse((await send("pm", "POST", BL, { projectId: "2", taskId: "2", hours: 40.5 })).body);
    expect(a).toMatchObject({ projectId: "2", taskId: "2", personId: null, hours: 40.5, amount: null, version: 1 });
    const b = ProjectBudgetLine.parse((await send("pm", "POST", BL, { projectId: "2", personId: "1", amount: "5000" })).body);
    expect(b).toMatchObject({ taskId: null, personId: "1", hours: null, amount: "5000.00" });
    const c = ProjectBudgetLine.parse((await send("pm", "POST", BL, { projectId: "1", taskId: "1", hours: 0, amount: "0.5" })).body);
    expect(c).toMatchObject({ hours: 0, amount: "0.50" });
  });
  it("cible : ni les deux ni aucune, aucune valeur : 400 ; heures à 3 décimales : 400", async () => {
    for (const b of [{ projectId: "1", hours: 4 }, { projectId: "1", taskId: "1", personId: "1", hours: 4 }, { projectId: "1", taskId: "1" }, { projectId: "1", taskId: "1", hours: 1.234 }]) {
      const r = await send("pm", "POST", BL, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
  });
  it("références : tâche d'un autre projet ou compte -> 404 project_task ; personne d'un autre compte -> 404 person ; projet -> 404 project ; rien d'écrit", async () => {
    const before = await n("SELECT count(*) AS n FROM project_budget_lines");
    for (const [b, entity] of [
      [{ projectId: "1", taskId: "2", hours: 1 }, "project_task"], [{ projectId: "1", taskId: "3", hours: 1 }, "project_task"], [{ projectId: "1", taskId: "abc", hours: 1 }, "project_task"],
      [{ projectId: "1", personId: "2", hours: 1 }, "person"], [{ projectId: "1", personId: "999", hours: 1 }, "person"],
      [{ projectId: "3", taskId: "1", hours: 1 }, "project"], [{ projectId: "999", personId: "1", hours: 1 }, "project"],
    ] as const) {
      const r = await send("pm", "POST", BL, b);
      expect(r.status, JSON.stringify(b)).toBe(404);
      expect(err(r).params.entity).toBe(entity);
    }
    expect(await n("SELECT count(*) AS n FROM project_budget_lines")).toBe(before);
  });
  it("une seule ligne par cible et par projet : 409 ALREADY_EXISTS ; la même personne dans un autre projet passe", async () => {
    const first = await send("pm", "POST", BL, { projectId: "2", taskId: "2", hours: 1 });
    expect(first.status).toBe(409);
    expect(err(first)).toMatchObject({ code: "ALREADY_EXISTS", params: { entity: "budget_line" } });
    expect((await send("pm", "POST", BL, { projectId: "1", personId: "1", hours: 3 })).status).toBe(201);
    const dup = await send("pm", "POST", BL, { projectId: "1", personId: "1", amount: "1" });
    expect(dup.status).toBe(409);
  });
  it("modifie : l'un ou l'autre, null retire, un état sans valeur est refusé, la cible est immuable", async () => {
    const l = ProjectBudgetLine.parse(((await send("pm", "GET", `${BL}?projectId=1&taskId=1`)).body as Page<unknown>).items[0]); // créée plus haut : heures 0, montant 0.50
    let r = await send("pm", "PATCH", `${BL}/${l.id}`, { hours: null }, 1);
    expect(ProjectBudgetLine.parse(r.body)).toMatchObject({ hours: null, amount: "0.50", version: 2 });
    r = await send("pm", "PATCH", `${BL}/${l.id}`, { amount: null }, 2); // plus rien
    expect([r.status, err(r).params.field]).toEqual([400, "hours"]);
    r = await send("pm", "PATCH", `${BL}/${l.id}`, { hours: 12.25, taskId: "2", personId: "1" }, 2);
    expect(ProjectBudgetLine.parse(r.body)).toMatchObject({ taskId: "1", personId: null, hours: 12.25, amount: "0.50", version: 3 });
    expect((await send("pm", "PATCH", `${BL}/${l.id}`, { hours: 1 }, 1)).status).toBe(409);
  });
  describe("lecture", () => {
    it("filtres projet, tâche, personne ; page au contrat ; total", async () => {
      const r = await send("pm", "GET", `${BL}?projectId=2`);
      expect(ProjectBudgetLineList.safeParse(r.body).success).toBe(true);
      expect((r.body as Page<{ projectId: string }>).items.every((x) => x.projectId === "2")).toBe(true);
      const byTask = (await send("pm", "GET", `${BL}?taskId=2`)).body as Page<{ taskId: string }>;
      expect(byTask.items.map((x) => x.taskId)).toEqual(["2"]);
      expect(byTask.page.total).toBe(1);
      const byPerson = (await send("pm", "GET", `${BL}?personId=1`)).body as Page<{ personId: string }>;
      expect(byPerson.items.every((x) => x.personId === "1")).toBe(true);
      expect((await send("pm", "GET", `${BL}?personId=2`)).body).toMatchObject({ items: [], page: { total: 0 } }); // personne d'un autre compte : rien
      const bad = await send("pm", "GET", `${BL}?taskId=x`);
      expect([bad.status, err(bad).params.field]).toEqual([400, "taskId"]);
    });
    it("isolation : ligne étrangère invisible, 404 en lecture, modification et suppression", async () => {
      const foreign = String((await pg.query<{ id: string }>("SELECT id FROM project_budget_lines WHERE account_id = 2")).rows[0]!.id);
      expect(((await send("pm", "GET", BL)).body as Page<{ id: string }>).items.map((x) => x.id)).not.toContain(foreign);
      for (const [m, b] of [["GET"], ["PATCH", { hours: 1 }], ["DELETE"]] as const) {
        const r = await send("admin", m, `${BL}/${foreign}`, b, 1);
        expect(r.status, m).toBe(404);
        expect(err(r).params.entity).toBe("project_budget_line");
      }
    });
  });
  it("supprime : libre ; version périmée 409 ; la cible peut alors être recréée", async () => {
    const created = await send("pm", "POST", BL, { projectId: "2", taskId: "2", hours: 1 }); // déjà créée plus haut : 409
    expect(created.status).toBe(409);
    const line = ((await send("pm", "GET", `${BL}?projectId=2&taskId=2`)).body as Page<{ id: string }>).items[0]!;
    expect((await send("pm", "DELETE", `${BL}/${line.id}`, undefined, 9)).status).toBe(409);
    expect((await send("pm", "DELETE", `${BL}/${line.id}`, undefined, 1)).status).toBe(204);
    expect((await send("pm", "POST", BL, { projectId: "2", taskId: "2", hours: 2 })).status).toBe(201);
  });
  it("supprimer une tâche ou une personne avec une ligne de budget reste refusé (non-régression des dépendants)", async () => {
    const r = await send("pm", "DELETE", "/api/v1/project-tasks/1", undefined, 1);
    expect(r.status).toBe(409);
    expect(err(r).params.budget_lines).toBeGreaterThan(0);
  });
});

describe("hors temps réel", () => {
  it("aucune écriture ne produit de changement dans le journal du Schedule", async () => {
    const before = await n("SELECT count(*) AS n FROM change_log WHERE account_id = 1");
    const e = ProjectExpense.parse((await send("pm", "POST", EX, { projectId: "1", name: "Silence", amount: "1" })).body);
    await send("pm", "PATCH", `${EX}/${e.id}`, { amount: "2" }, 1);
    await send("pm", "DELETE", `${EX}/${e.id}`, undefined, 2);
    expect(await n("SELECT count(*) AS n FROM change_log WHERE account_id = 1")).toBe(before);
  });
});

describe("garde de rôle dans les fonctions elles-mêmes (en plus de la couche HTTP)", () => {
  const member = roles.member!;
  it.each([
    ["createExpense", () => createExpense(db, member, { projectId: "1", name: "x", amount: "1" })],
    ["updateExpense", () => updateExpense(db, member, "1", 1, { name: "x" })],
    ["deleteExpense", () => deleteExpense(db, member, "1", 1)],
    ["expenseReader.list", () => expenseReader.list(db, member, {})],
    ["expenseReader.get", () => expenseReader.get(db, member, "1")],
    ["createBudgetLine", () => createBudgetLine(db, member, { projectId: "1", taskId: "1", hours: 1 })],
    ["updateBudgetLine", () => updateBudgetLine(db, member, "1", 1, { hours: 1 })],
    ["deleteBudgetLine", () => deleteBudgetLine(db, member, "1", 1)],
    ["budgetLineReader.list", () => budgetLineReader.list(db, member, {})],
    ["budgetLineReader.get", () => budgetLineReader.get(db, member, "1")],
  ])("%s refuse un membre", async (_n, call) => {
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
