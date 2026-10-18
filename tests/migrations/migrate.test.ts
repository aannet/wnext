// « Migrations depuis zéro » (strategy.md §1, P1) sur un vrai PostgreSQL (embedded-postgres) : la baseline schema.sql puis
// migrations/, une base vierge par test. La suite SQL de non-régression est rejouée sur la base migrée.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { MigrationError, listMigrations, migrate, status } from "../../scripts/migrate.mjs";

let server: EmbeddedPostgres;
let base: string;
let dir: string;
let n = 0;
const clients: pg.Client[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wnext-mig-"));
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

/** Base vierge et client connecté dessus. */
async function freshDb(): Promise<pg.Client> {
  const name = `m${++n}`;
  await server.createDatabase(name);
  const c = new pg.Client({ connectionString: `${base}/${name}` });
  await c.connect();
  clients.push(c);
  return c;
}

/** Racine factice : petite baseline + migrations données. */
function fakeRoot(files: Record<string, string>) {
  const root = mkdtempSync(join(dir, "root-"));
  mkdirSync(join(root, "migrations"));
  for (const [p, sql] of Object.entries({ "schema.sql": "CREATE TABLE t_base (id int);", ...files })) writeFileSync(join(root, p), sql);
  return root;
}

describe("depuis zéro, avec le vrai schema.sql", () => {
  it("applique la baseline, puis la suite SQL de non-régression passe sur la base migrée", async () => {
    const c = await freshDb();
    expect(await migrate(c)).toEqual(listMigrations().map((m: { version: string }) => m.version));
    const { rows } = await c.query("SELECT version, name FROM wnext_migrations.applied ORDER BY version");
    expect(rows[0]).toEqual({ version: "0001", name: "init" });
    await c.query(readFileSync("tests/sql/schema_tests.sql", "utf8")); // lève 'FAIL: <libellé>' à la première assertion en échec
  }, 120_000);

  it("relancer ne fait rien, status ne signale rien en attente", async () => {
    const c = await freshDb();
    await migrate(c);
    expect(await migrate(c)).toEqual([]);
    expect((await status(c)).pending).toEqual([]);
  }, 120_000);

  it("le registre est hors du schéma public et app_user n'y a aucun droit", async () => {
    const c = await freshDb();
    await migrate(c);
    const r = await c.query("SELECT has_schema_privilege('app_user', 'wnext_migrations', 'USAGE') AS u");
    expect(r.rows[0].u).toBe(false);
  }, 120_000);
});

describe("règles du registre", () => {
  it("applique les migrations dans l'ordre numérique, chacune une fois", async () => {
    const root = fakeRoot({ "migrations/0003_c.sql": "ALTER TABLE t_base ADD COLUMN c int;", "migrations/0002_b.sql": "ALTER TABLE t_base ADD COLUMN b int;" });
    const c = await freshDb();
    expect(await migrate(c, { root })).toEqual(["0001", "0002", "0003"]);
    const cols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name = 't_base' ORDER BY ordinal_position");
    expect(cols.rows.map((r) => r.column_name)).toEqual(["id", "b", "c"]);
  });

  it("une migration en échec est annulée entière ; les précédentes restent", async () => {
    const root = fakeRoot({ "migrations/0002_ok.sql": "CREATE TABLE t_ok (id int);", "migrations/0003_ko.sql": "CREATE TABLE t_ko (id int); SELECT 1/0;" });
    const c = await freshDb();
    await expect(migrate(c, { root })).rejects.toThrow(/0003_ko en échec/);
    expect((await c.query("SELECT version FROM wnext_migrations.applied ORDER BY version")).rows.map((r) => r.version)).toEqual(["0001", "0002"]);
    expect((await c.query("SELECT to_regclass('t_ko') AS t")).rows[0].t).toBeNull();
    expect((await c.query("SELECT to_regclass('t_ok') AS t")).rows[0].t).toBe("t_ok");
  });

  it("refuse une migration appliquée puis modifiée", async () => {
    const root = fakeRoot({ "migrations/0002_b.sql": "ALTER TABLE t_base ADD COLUMN b int;" });
    const c = await freshDb();
    await migrate(c, { root });
    writeFileSync(join(root, "migrations/0002_b.sql"), "ALTER TABLE t_base ADD COLUMN b bigint;");
    await expect(migrate(c, { root })).rejects.toThrow(/0002_b modifiée après application/);
    await expect(status(c, { root })).rejects.toBeInstanceOf(MigrationError);
  });

  it("refuse une migration appliquée absente du disque", async () => {
    const root = fakeRoot({ "migrations/0002_b.sql": "SELECT 1;" });
    const c = await freshDb();
    await migrate(c, { root });
    rmSync(join(root, "migrations/0002_b.sql"));
    await expect(migrate(c, { root })).rejects.toThrow(/0002_b appliquée mais absente du disque/);
  });

  it("refuse une nouvelle migration numérotée sous la dernière appliquée, sans rien appliquer", async () => {
    const root = fakeRoot({ "migrations/0003_c.sql": "SELECT 1;" });
    const c = await freshDb();
    await migrate(c, { root });
    writeFileSync(join(root, "migrations/0002_tard.sql"), "CREATE TABLE t_tard (id int);");
    await expect(migrate(c, { root })).rejects.toThrow(/0002_tard numérotée sous la dernière appliquée \(0003\)/);
    expect((await c.query("SELECT to_regclass('t_tard') AS t")).rows[0].t).toBeNull();
  });

  it("refuse un nom de fichier invalide, 0001 dans migrations/ et une version en double", () => {
    expect(() => listMigrations(fakeRoot({ "migrations/2_x.sql": "" }))).toThrow(/nom attendu/);
    expect(() => listMigrations(fakeRoot({ "migrations/0001_x.sql": "" }))).toThrow(/réservé à la baseline/);
    expect(() => listMigrations(fakeRoot({ "migrations/0002_a.sql": "", "migrations/0002_b.sql": "" }))).toThrow(/en double/);
  });

  it("deux exécutions simultanées : une seule applique, l'autre attend puis ne fait rien", async () => {
    const root = fakeRoot({ "migrations/0002_lent.sql": "SELECT pg_sleep(0.3); CREATE TABLE t_lent (id int);" });
    const a = await freshDb();
    const b = new pg.Client({ connectionString: `${base}/m${n}` });
    await b.connect();
    clients.push(b);
    const [ra, rb] = await Promise.all([migrate(a, { root }), migrate(b, { root })]);
    expect([...ra, ...rb].sort()).toEqual(["0001", "0002"]);
    expect((await a.query("SELECT count(*)::int AS n FROM wnext_migrations.applied")).rows[0].n).toBe(2);
  });
});

it("la racine du dépôt n'a que la baseline ou des migrations bien nommées", () => {
  const all = listMigrations();
  expect(all[0]).toMatchObject({ version: "0001", file: "schema.sql" });
  // copie de contrôle : la somme de contrôle ne dépend que du contenu
  const root = mkdtempSync(join(tmpdir(), "wnext-mig-copy-"));
  cpSync("schema.sql", join(root, "schema.sql"));
  expect(listMigrations(root)[0].checksum).toBe(all[0].checksum);
  rmSync(root, { recursive: true, force: true });
});
