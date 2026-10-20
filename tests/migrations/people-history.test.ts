// BR-19 (@BR-19) : migration 0002_people_history sur un vrai PostgreSQL (embedded-postgres), depuis zéro, puis la suite
// tests/sql/people_history_tests.sql. Amorçage : une base au seul 0001 avec des personnes, migrée ensuite vers 0002.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { migrate } from "../../scripts/migrate.mjs";

let server: EmbeddedPostgres;
let base: string;
let dir: string;
let n = 0;
const clients: pg.Client[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wnext-hist-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  base = `postgres://postgres:postgres@127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await server?.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<pg.Client> {
  const name = `h${++n}`;
  await server.createDatabase(name);
  const c = new pg.Client({ connectionString: `${base}/${name}` });
  await c.connect();
  clients.push(c);
  return c;
}

describe("0002_people_history (@BR-19)", () => {
  it("depuis zéro : la suite SQL BR-19 passe, puis la suite de non-régression v1.1 aussi", async () => {
    const c = await freshDb();
    expect(await migrate(c)).toContain("0002");
    await c.query(readFileSync("tests/sql/people_history_tests.sql", "utf8")); // lève 'FAIL: <libellé>' au premier échec
    await c.query(readFileSync("tests/sql/schema_tests.sql", "utf8"));
  }, 120_000);

  it("amorçage : les personnes existantes reçoivent une période ouverte par attribut, à leurs valeurs actuelles", async () => {
    const c = await freshDb();
    // Racine au seul 0001 (même schema.sql) : la base est d'abord à la baseline, avec des données.
    const root = mkdtempSync(join(dir, "root-"));
    mkdirSync(join(root, "migrations"));
    cpSync("schema.sql", join(root, "schema.sql"));
    expect(await migrate(c, { root })).toEqual(["0001"]);
    await c.query(`
      INSERT INTO accounts (name) VALUES ('A');
      INSERT INTO departments (account_id, name) VALUES (1, 'D');
      INSERT INTO people (account_id, name, work_days_hours, department_id, cost_rate) VALUES (1, 'p', '{6,6,6,6,6,0,0}', 1, 42), (1, 'q', DEFAULT, NULL, NULL);`);
    expect(await migrate(c)).toEqual(["0002", "0003"]);
    const { rows } = await c.query(
      `SELECT pe.name, h.attribute, h.valid_from, h.valid_to, h.work_days_hours::text AS wdh, h.department_id, h.cost_rate::text AS cost
         FROM people_history h JOIN people pe ON pe.id = h.person_id ORDER BY pe.name, h.attribute`);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.valid_from === null && r.valid_to === null)).toBe(true);
    const p = Object.fromEntries(rows.filter((r) => r.name === "p").map((r) => [r.attribute, r]));
    expect(p.work_days_hours.wdh).toBe("{6.00,6.00,6.00,6.00,6.00,0.00,0.00}");
    expect(p.department_id.department_id).toBe("1");
    expect(p.cost_rate.cost).toBe("42.00");
    // La capacité est inchangée par la migration.
    const cap = await c.query("SELECT sum(base_hours)::int AS h FROM daily_capacity(1, '2026-03-02', '2026-03-08')");
    expect(cap.rows[0].h).toBe(30 + 40);
  }, 120_000);
});
