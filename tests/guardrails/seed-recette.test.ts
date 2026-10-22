// RT-044 (L-R1) : le seed de recette (scripts/seed-recette.mjs) rend jouables les scénarios R-01..R-25. Appliqué sur une base
// migrée (schema.sql puis migrations/, PGlite) : idempotent, invariants de données, identités OIDC alignées sur l'IdP local.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { RECETTE_USERS, seedRecette } from "../../scripts/seed-recette.mjs";
// @ts-expect-error module JS sans types
import { recettePlan } from "../../scripts/dev-recette.mjs";
// @ts-expect-error module JS sans types
import { VIDE_USERS, seedVide } from "../../scripts/seed-vide.mjs";

let pg: PGlite;
// Adaptateur de la forme `pg.Client` utilisée par le seed (requêtes multi-instructions sans paramètres).
const client = {
  query: async (sql: string) => {
    const res = await pg.exec(sql);
    const rows = (res.at(-1)?.rows ?? []) as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  },
};
const one = async <T = number>(sql: string): Promise<T> => (await pg.query<{ v: T }>(sql)).rows[0]!.v;
/** Instantané de toute la base publique : comptage et empreinte des lignes de chaque table, plus les séquences. */
const dump = async (db: PGlite) => {
  const out: Record<string, string> = {};
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows;
  for (const { tablename: t } of tables) {
    const r = await db.query<{ n: number; h: string }>(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(x::text, E'\n' ORDER BY x::text), '')) AS h FROM ${t} x`);
    out[t] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
  }
  const seqs = await db.query<{ sequencename: string; last_value: string | null }>("SELECT sequencename, last_value::text FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1");
  for (const q of seqs.rows) out[`seq:${q.sequencename}`] = String(q.last_value);
  return out;
};
const adapt = (db: PGlite) => ({
  query: async (sql: string) => { const r = await db.exec(sql); const rows = (r.at(-1)?.rows ?? []) as Record<string, unknown>[]; return { rows, rowCount: rows.length }; },
});
const migrated = async () => {
  const db = new PGlite({ extensions: { btree_gist, citext } });
  await db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"));
  return db;
};
const MONDAY = "(current_date - (extract(isodow FROM current_date)::int - 1))";

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("seed de recette (RT-044)", () => {
  it("sème une fois, puis ne change RIEN au second passage (instantané de toutes les tables et séquences)", async () => {
    expect(await seedRecette(client)).toBe(true);
    const before = await dump(pg);
    expect(Object.keys(before).length).toBeGreaterThan(25);
    expect(before.allocations).not.toMatch(/^0:/);
    expect(await seedRecette(client)).toBe(false);
    expect(await dump(pg)).toEqual(before);
  });

  it("refuse toute base qui n'est pas celle de la recette, sans rien écrire (autre compte, nom de compte imité, identité étrangère)", async () => {
    const cases: [string, string][] = [
      ["autre compte", "INSERT INTO accounts (name) VALUES ('Données d''Alec')"],
      ["nom du compte 1 imité", "INSERT INTO accounts (id, name) OVERRIDING SYSTEM VALUE VALUES (1, 'WNEXT Recette')"],
      ["identité étrangère", "INSERT INTO users (id, email, name, idp_subject) OVERRIDING SYSTEM VALUE VALUES (1, 'alec@vrai.test', 'Alec', 'sujet-d-alec')"],
      ["compte 1 imité et identité étrangère", `INSERT INTO accounts (id, name) OVERRIDING SYSTEM VALUE VALUES (1, 'WNEXT Recette');
        INSERT INTO accounts (id, name) OVERRIDING SYSTEM VALUE VALUES (2, 'Autre Société');
        INSERT INTO users (id, email, name, idp_subject) OVERRIDING SYSTEM VALUE VALUES (9, 'intrus@x.test', 'Intrus', NULL)`],
      ["sujet d'une identité attendue détourné", `INSERT INTO users (id, email, name, idp_subject) OVERRIDING SYSTEM VALUE VALUES (3, 'camille.roy@wnext.test', 'Camille', 'autre-sujet')`],
    ];
    for (const [label, sql] of cases) {
      const other = await migrated();
      try {
        await other.exec(sql);
        const before = await dump(other);
        await expect(seedRecette(adapt(other)), label).rejects.toThrow(/appartient pas|autres? comptes?|identité/);
        await expect(seedVide(adapt(other)), label).rejects.toThrow(/appartient pas|autres? comptes?|identité/);
        expect(await dump(other), label).toEqual(before);
      } finally {
        await other.close();
      }
    }
  }, 120_000);

  it("complète les identités attendues sur une base de recette déjà semée (sujet manquant), rien d'autre", async () => {
    const db = await migrated();
    try {
      await seedRecette(adapt(db));
      await db.exec("UPDATE users SET idp_subject = NULL WHERE id = 3");
      expect(await seedRecette(adapt(db))).toBe(false);
      expect(await one<string>("SELECT idp_subject AS v FROM users WHERE id = 3")).toBe("recette-camille");
    } finally {
      await db.close();
    }
  }, 60_000);

  it("compte vide : un compte, Alec owner sans personne, aucune autre donnée ; idempotent ; refus sur la recette", async () => {
    const db = await migrated();
    try {
      expect(await seedVide(adapt(db))).toBe(true);
      const before = await dump(db);
      expect(await seedVide(adapt(db))).toBe(false);
      expect(await dump(db)).toEqual(before);
      const n = async (t: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
      expect(await n("accounts")).toBe(1);
      expect(await n("users")).toBe(VIDE_USERS.length);
      expect(VIDE_USERS).toHaveLength(1);
      expect((await db.query("SELECT u.idp_subject, u.name, m.role, m.person_id FROM users u JOIN account_members m ON m.user_id = u.id")).rows)
        .toEqual([{ idp_subject: "dev-alec", name: "Alec", role: "owner", person_id: null }]);
      for (const t of ["people", "projects", "allocations", "clients", "departments", "timeoffs", "holidays", "notifications", "saved_views"]) expect(await n(t), t).toBe(0);
      await expect(seedRecette(adapt(db))).rejects.toThrow(/appartient pas|autres? comptes?/);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("personnes : ≥ 14 actives sur ≥ 3 équipes, samedi, temps partiel, désactivée, placeholder, horaire daté BR-19", async () => {
    expect(await one("SELECT count(*)::int AS v FROM people WHERE account_id = 1 AND active")).toBeGreaterThanOrEqual(14);
    expect(await one("SELECT count(DISTINCT department_id)::int AS v FROM people WHERE account_id = 1 AND active")).toBeGreaterThanOrEqual(3);
    expect(await one("SELECT count(*)::int AS v FROM people WHERE work_days_hours[6] > 0")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM people WHERE account_id = 1 AND work_days_hours[3] = 0 AND work_days_hours[1] > 0")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM people WHERE account_id = 1 AND NOT active")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM people WHERE account_id = 1 AND people_type = 'placeholder' AND email IS NULL")).toBe(1);
    // Thomas : deux périodes d'horaire, la seconde ouverte et datée.
    expect(await one("SELECT count(*)::int AS v FROM people_history h JOIN people p ON p.id = h.person_id WHERE p.name = 'Thomas Girard' AND h.attribute = 'work_days_hours'")).toBe(2);
    expect(await one(`SELECT count(*)::int AS v FROM people_history WHERE attribute = 'work_days_hours' AND valid_to IS NULL AND valid_from = ${MONDAY} + 21`)).toBe(1);
  });

  it("projets : confirmés et un tentatif, clients, tâches, couleurs variées, codes uniques", async () => {
    expect(await one("SELECT count(*)::int AS v FROM projects WHERE account_id = 1 AND status = 'tentative'")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM projects WHERE account_id = 1 AND status <> 'tentative'")).toBeGreaterThanOrEqual(5);
    expect(await one("SELECT count(DISTINCT color)::int AS v FROM projects WHERE account_id = 1")).toBeGreaterThanOrEqual(6);
    expect(await one("SELECT count(*)::int AS v FROM clients WHERE account_id = 1")).toBeGreaterThanOrEqual(3);
    expect(await one("SELECT count(*)::int AS v FROM project_tasks WHERE account_id = 1")).toBeGreaterThanOrEqual(10);
    for (const code of ["REF-01", "SITE-01"]) expect(await one(`SELECT count(*)::int AS v FROM projects WHERE project_code = '${code}'`)).toBe(1);
  });

  it("allocations : heures et pourcentage, une série, un groupe BR-26, une tentative, une sur- et une sous-allocation", async () => {
    expect(await one("SELECT count(*)::int AS v FROM allocations WHERE account_id = 1")).toBeGreaterThanOrEqual(60);
    expect(await one("SELECT count(DISTINCT mode)::int AS v FROM allocations WHERE account_id = 1")).toBe(2);
    expect(await one("SELECT count(*)::int AS v FROM allocations WHERE repeat_state <> 'none'")).toBe(1);
    expect(await one("SELECT count(DISTINCT group_id)::int AS v FROM allocations WHERE group_id IS NOT NULL")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM allocations WHERE group_id IS NOT NULL")).toBeGreaterThanOrEqual(2);
    expect(await one("SELECT count(*)::int AS v FROM allocations WHERE status = 'tentative'")).toBeGreaterThanOrEqual(1);
    const util = (name: string, from: number, to = from) => pg.query<{ utilization: string; overtime_hours: string; capacity_hours: string }>(
      `SELECT u.utilization, u.overtime_hours, u.capacity_hours FROM utilization(1, ${MONDAY} + ${from}, ${MONDAY} + ${to}) u JOIN people p ON p.id = u.person_id WHERE p.name = '${name}' ORDER BY u.day`);
    // R-15 : Camille +5 h le mardi S+2 ; R-04 : Julie 75 % puis 125 % ; sous-allocation : Hugo à 50 %.
    expect(Number((await util("Camille Roy", 15)).rows[0]!.overtime_hours)).toBe(5);
    expect(Number((await util("Julie Lambert", 7)).rows[0]!.utilization)).toBeCloseTo(0.75);
    expect(Number((await util("Julie Lambert", 14)).rows[0]!.utilization)).toBeCloseTo(1.25);
    expect(Number((await util("Hugo Petit", 0)).rows[0]!.utilization)).toBeCloseTo(0.5);
    // R-13 / R-10 : Camille libre lun-mar S+3, Lucas libre toute la semaine S+2.
    expect((await util("Camille Roy", 21, 22)).rows.map((r) => Number(r.utilization))).toEqual([0, 0]);
    expect((await util("Lucas Morel", 14, 18)).rows.map((r) => Number(r.utilization))).toEqual([0, 0, 0, 0, 0]);
    // R-20 : Léo, 12 allocations et 34 h loggées sur REF-01.
    expect(await one("SELECT count(*)::int AS v FROM allocations a JOIN people p ON p.id = a.person_id JOIN projects j ON j.id = a.project_id WHERE p.name = 'Léo Martin' AND j.project_code = 'REF-01'")).toBe(12);
    expect(Number(await one("SELECT sum(hours)::numeric AS v FROM logged_time l JOIN people p ON p.id = l.person_id WHERE p.name = 'Léo Martin'"))).toBe(34);
  });

  it("congés (journée, demi-journée, en attente) et férié France : Camille 0 h, Sam (US) 8 h ce jour-là (R-19)", async () => {
    expect(await one("SELECT count(*)::int AS v FROM timeoffs WHERE start_date = end_date AND start_half = end_half")).toBeGreaterThanOrEqual(1);
    expect(await one("SELECT count(*)::int AS v FROM timeoffs WHERE start_date < end_date AND approval_status = 'approved'")).toBeGreaterThanOrEqual(1);
    expect(await one("SELECT count(*)::int AS v FROM timeoffs WHERE approval_status = 'pending'")).toBeGreaterThanOrEqual(1);
    const cap = async (name: string) => Number(await one(`SELECT c.capacity_hours AS v FROM daily_capacity(1, ${MONDAY} + 23, ${MONDAY} + 23) c JOIN people p ON p.id = c.person_id WHERE p.name = '${name}'`));
    expect(await cap("Camille Roy")).toBe(0);
    expect(await cap("Sam Carter")).toBe(8);
  });

  it("accès : chef de projet qui gère REF-01 et co-gère SITE-01, membre lié à une personne, personnes sans accès, second compte", async () => {
    expect(await one("SELECT count(*)::int AS v FROM project_managers pm JOIN account_members m ON m.user_id = pm.user_id AND m.account_id = pm.account_id WHERE m.role = 'project_manager'")).toBe(2);
    expect(await one("SELECT count(*)::int AS v FROM projects j JOIN account_members m ON m.person_id = j.project_manager_id WHERE m.role = 'project_manager' AND j.project_code = 'REF-01'")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM account_members WHERE role = 'member' AND person_id IS NOT NULL")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM people p WHERE p.account_id = 1 AND p.active AND NOT EXISTS (SELECT 1 FROM account_members m WHERE m.person_id = p.id)")).toBeGreaterThanOrEqual(10);
    for (const role of ["owner", "admin", "project_manager", "member", "guest"]) expect(await one(`SELECT count(*)::int AS v FROM account_members WHERE account_id = 1 AND role = '${role}'`)).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM accounts")).toBe(2);
    expect(await one("SELECT count(*)::int AS v FROM people WHERE account_id = 2")).toBeGreaterThanOrEqual(1);
  });

  it("identités OIDC : chaque compte de connexion a un sujet unique, Alec est owner « Alec » sans personne liée, cloche vide", async () => {
    const rows = (await pg.query<{ idp_subject: string; email: string; name: string; role: string }>(
      "SELECT u.idp_subject, u.email, u.name, m.role FROM users u JOIN account_members m ON m.user_id = u.id ORDER BY u.id")).rows;
    expect(rows.map((r) => r.idp_subject)).toEqual(RECETTE_USERS.map((u: { subject: string }) => u.subject));
    expect(rows[0]).toMatchObject({ idp_subject: "dev-alec", name: "Alec", role: "owner" });
    expect(await one("SELECT count(*)::int AS v FROM account_members WHERE user_id = 1 AND person_id IS NULL")).toBe(1);
    expect(await one("SELECT count(*)::int AS v FROM notifications")).toBe(0);
  });

  it("dev:recette transmet --seed=recette à la pile", () => {
    expect(recettePlan({}, ["--seed=recette"]).stack.args).toEqual(["scripts/dev-stack.mjs", "--oidc", "--seed=recette"]);
    expect(recettePlan({}, ["--reset", "--seed=recette"]).stack.args).toEqual(["scripts/dev-stack.mjs", "--oidc", "--reset", "--seed=recette"]);
    expect(recettePlan({}, ["--seed=vide"]).stack.args).toEqual(["scripts/dev-stack.mjs", "--oidc", "--seed=vide"]);
    expect(recettePlan({}, []).stack.args).toEqual(["scripts/dev-stack.mjs", "--oidc"]);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["dev:recette:seed"]).toBe("node scripts/dev-recette.mjs --seed=recette");
    expect(pkg.scripts["dev:recette:vide"]).toBe("node scripts/dev-recette.mjs --seed=vide");
  });
});
