// Jeu d'essai de `npm run dev:stack` (scripts/dev-seed.mjs) : il s'applique sur le schéma, est idempotent, et l'API le lit
// sous RLS avec l'identité d'essai (VITE_DEV_* de apps/web/.env.development).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { DEV_IDS, seedDev } from "../../scripts/dev-seed.mjs";

let db: PGlite;
const client = () => ({
  query: async (sql: string) => {
    if (/;\s*\n/.test(sql)) {
      await db.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const r = await db.query<Record<string, unknown>>(sql);
    return { rows: r.rows, rowCount: r.rows.length };
  },
});

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist, citext } });
  await db.exec(readFileSync("schema.sql", "utf8"));
}, 120_000);
afterAll(async () => { await db?.close(); });

const count = async (t: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

describe("jeu d'essai de développement", () => {
  it("sème une fois (idempotent) : compte, admin, 50 personnes, 6 projets dont 1 tentatif", async () => {
    expect(await seedDev(client())).toBe(true);
    expect(await seedDev(client())).toBe(false);
    expect([await count("accounts"), await count("people"), await count("projects"), await count("departments")]).toEqual([1, 50, 6, 3]);
    const acc = (await db.query<{ week_start: number; timezone: string }>("SELECT week_start, timezone FROM accounts")).rows[0];
    expect(acc).toEqual({ week_start: 1, timezone: "Europe/Paris" });
    expect((await db.query("SELECT 1 FROM projects WHERE status = 'tentative'")).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM account_members WHERE user_id = 1 AND role = 'admin'")).rows).toHaveLength(1);
  });

  it("allocations : deux modes, série hebdomadaire, demi-journée de congé, férié, ±3 mois", async () => {
    expect(await count("allocations")).toBeGreaterThan(250);
    const modes = (await db.query<{ mode: string }>("SELECT DISTINCT mode FROM allocations ORDER BY mode")).rows.map((r) => r.mode);
    expect(modes).toEqual(["hours", "percentage"]);
    expect((await db.query("SELECT 1 FROM allocations WHERE repeat_state = 'weekly'")).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM timeoffs WHERE start_half = 'am' AND end_half = 'am' AND start_date = end_date")).rows).toHaveLength(1);
    expect(await count("holidays")).toBe(1);
    // La série démarre un lundi (ISO), le congé un jeudi, le férié un mercredi.
    expect((await db.query<{ d: number }>("SELECT extract(isodow FROM start_date)::int AS d FROM allocations WHERE repeat_state = 'weekly'")).rows[0].d).toBe(1);
    expect((await db.query<{ d: number }>("SELECT extract(isodow FROM start_date)::int AS d FROM timeoffs")).rows[0].d).toBe(4);
    expect((await db.query<{ d: number }>("SELECT extract(isodow FROM hdate)::int AS d FROM holidays")).rows[0].d).toBe(3);
    const span = (await db.query<{ lo: number; hi: number }>("SELECT min(start_date) - current_date AS lo, max(end_date) - current_date AS hi FROM allocations WHERE repeat_state = 'none'")).rows[0];
    expect(span.lo).toBeLessThan(-60);
    expect(span.hi).toBeGreaterThan(60);
  });

  it("les séquences passent les ids fixes : une insertion ordinaire ne collisionne pas", async () => {
    await db.exec("INSERT INTO people (account_id, name) VALUES (1, 'Nouvelle')");
    expect((await db.query<{ id: number }>("SELECT max(id)::int AS id FROM people")).rows[0].id).toBe(51);
  });

  it("l'identité d'essai (compte 1, utilisateur 1, admin) existe comme membre", () => {
    expect(DEV_IDS).toEqual({ accountId: "1", userId: "1", role: "admin" });
  });
});
