// RT-048 : migration 0006_change_log_person sur un vrai PostgreSQL (embedded-postgres). Métadonnées `person_ids` du journal de
// changements, entité par entité : INSERT / UPDATE / DELETE des allocations, congés, temps saisi, équipe et personnes ; changement
// de personne (ancienne ET nouvelle) ; référentiels sans personne (NULL) ; cascades. Puis l'amorçage depuis 0005 : les lignes
// antérieures restent à NULL (l'API force alors un resync du member, apps/api/test/realtime-upgrade-0006.test.ts), et la suite de
// non-régression v1.1 passe toujours sur les triggers remplacés.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "wnext-clp-"));
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
  const name = `clp${++n}`;
  await server.createDatabase(name);
  const c = new pg.Client({ connectionString: `${base}/${name}` });
  await c.connect();
  clients.push(c);
  return c;
}

type Entry = { entity: string; id: string; op: string; people: string | null };
/** Lignes du journal écrites par `fn` (dans l'ordre), avec person_ids en texte ('{1,2}') ou null. */
async function logged(c: pg.Client, fn: () => Promise<unknown>): Promise<Entry[]> {
  const before = (await c.query("SELECT COALESCE(max(seq), 0) AS s FROM change_log WHERE account_id = 1")).rows[0].s;
  await fn();
  const { rows } = await c.query(
    "SELECT entity, entity_id::text AS id, op, person_ids::text AS people FROM change_log WHERE account_id = 1 AND seq > $1 ORDER BY seq", [before]);
  return rows;
}
const one = async (c: pg.Client, sql: string) => String((await c.query(sql)).rows[0].id);

describe("0006_change_log_person (RT-048)", () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await freshDb();
    expect(await migrate(c)).toContain("0006");
    await c.query(`
      INSERT INTO accounts (name) VALUES ('A');
      INSERT INTO people (account_id, name) VALUES (1, 'Mia'), (1, 'Bob'), (1, 'Carl');
      INSERT INTO projects (account_id, name) VALUES (1, 'P');
      INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');`);
  }, 120_000);

  it("allocations : insert, update, delete portent la personne ; un changement de personne porte l'ancienne puis la nouvelle", async () => {
    let id = "";
    expect(await logged(c, async () => { id = await one(c, "INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES (1, 1, 1, '2026-03-02', '2026-03-02', 4) RETURNING id"); }))
      .toEqual([{ entity: "allocations", id, op: "insert", people: "{1}" }]);
    expect(await logged(c, () => c.query(`UPDATE allocations SET hours_per_day = 5 WHERE id = ${id}`))).toEqual([{ entity: "allocations", id, op: "update", people: "{1}" }]);
    expect(await logged(c, () => c.query(`UPDATE allocations SET person_id = 2 WHERE id = ${id}`))).toEqual([{ entity: "allocations", id, op: "update", people: "{1,2}" }]);
    expect(await logged(c, () => c.query(`DELETE FROM allocations WHERE id = ${id}`))).toEqual([{ entity: "allocations", id, op: "delete", people: "{2}" }]);
  });

  it("congés : insert, update, changement de personne, delete", async () => {
    let id = "";
    expect(await logged(c, async () => { id = await one(c, "INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (1, 1, 1, '2026-04-01', '2026-04-01') RETURNING id"); }))
      .toEqual([{ entity: "timeoffs", id, op: "insert", people: "{1}" }]);
    expect(await logged(c, () => c.query(`UPDATE timeoffs SET end_date = '2026-04-02' WHERE id = ${id}`))).toEqual([{ entity: "timeoffs", id, op: "update", people: "{1}" }]);
    expect(await logged(c, () => c.query(`UPDATE timeoffs SET person_id = 3 WHERE id = ${id}`))).toEqual([{ entity: "timeoffs", id, op: "update", people: "{1,3}" }]);
    expect(await logged(c, () => c.query(`DELETE FROM timeoffs WHERE id = ${id}`))).toEqual([{ entity: "timeoffs", id, op: "delete", people: "{3}" }]);
  });

  it("temps saisi : insert, update, changement de personne, delete", async () => {
    let id = "";
    expect(await logged(c, async () => { id = await one(c, "INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1, 2, 1, '2026-03-03', 2) RETURNING id"); }))
      .toEqual([{ entity: "logged_time", id, op: "insert", people: "{2}" }]);
    expect(await logged(c, () => c.query(`UPDATE logged_time SET hours = 3 WHERE id = ${id}`))).toEqual([{ entity: "logged_time", id, op: "update", people: "{2}" }]);
    expect(await logged(c, () => c.query(`UPDATE logged_time SET person_id = 1 WHERE id = ${id}`))).toEqual([{ entity: "logged_time", id, op: "update", people: "{2,1}" }]);
    expect(await logged(c, () => c.query(`DELETE FROM logged_time WHERE id = ${id}`))).toEqual([{ entity: "logged_time", id, op: "delete", people: "{1}" }]);
  });

  it("équipe : ajout et retrait portent la personne (id du journal = le projet)", async () => {
    expect(await logged(c, () => c.query("INSERT INTO project_team (account_id, project_id, person_id) VALUES (1, 1, 2)"))).toEqual([{ entity: "project_team", id: "1", op: "update", people: "{2}" }]);
    expect(await logged(c, () => c.query("DELETE FROM project_team WHERE project_id = 1 AND person_id = 2"))).toEqual([{ entity: "project_team", id: "1", op: "update", people: "{2}" }]);
  });

  it("personnes : insert, update, delete portent la personne elle-même", async () => {
    let id = "";
    expect(await logged(c, async () => { id = await one(c, "INSERT INTO people (account_id, name) VALUES (1, 'Dan') RETURNING id"); }))
      .toEqual([{ entity: "people", id, op: "insert", people: `{${id}}` }]);
    expect(await logged(c, () => c.query(`UPDATE people SET tags = '{x}' WHERE id = ${id}`))).toEqual([{ entity: "people", id, op: "update", people: `{${id}}` }]);
    expect(await logged(c, () => c.query(`DELETE FROM people WHERE id = ${id}`))).toEqual([{ entity: "people", id, op: "delete", people: `{${id}}` }]);
  });

  it("référentiels : person_ids NULL (diffusés à tous les rôles)", async () => {
    const rows = await logged(c, () => c.query(`
      INSERT INTO holidays (account_id, name, hdate) VALUES (1, 'Férié', '2026-05-01');
      INSERT INTO departments (account_id, name) VALUES (1, 'Design');
      INSERT INTO roles (account_id, name) VALUES (1, 'Dev');
      INSERT INTO clients (account_id, name) VALUES (1, 'Client');
      UPDATE projects SET name = 'P bis' WHERE id = 1;
      INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Formation');`));
    expect(rows.map((r) => [r.entity, r.people])).toEqual([
      ["holidays", null], ["departments", null], ["roles", null], ["clients", null], ["projects", null], ["timeoff_types", null],
    ]);
  });

  it("cascades : supprimer une personne journalise ses allocations, congés et équipes avec sa personne ; supprimer un projet, ses allocations", async () => {
    const p = await one(c, "INSERT INTO people (account_id, name) VALUES (1, 'Eve') RETURNING id");
    const a = await one(c, `INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES (1, ${p}, 1, '2026-03-02', '2026-03-02', 4) RETURNING id`);
    const t = await one(c, `INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (1, ${p}, 1, '2026-04-01', '2026-04-01') RETURNING id`);
    await c.query(`INSERT INTO project_team (account_id, project_id, person_id) VALUES (1, 1, ${p})`);
    const rows = await logged(c, () => c.query(`DELETE FROM people WHERE id = ${p}`));
    expect(rows).toEqual(expect.arrayContaining([
      { entity: "allocations", id: a, op: "delete", people: `{${p}}` },
      { entity: "timeoffs", id: t, op: "delete", people: `{${p}}` },
      { entity: "project_team", id: "1", op: "update", people: `{${p}}` },
      { entity: "people", id: p, op: "delete", people: `{${p}}` },
    ]));
    expect(rows).toHaveLength(4);

    const q = await one(c, "INSERT INTO projects (account_id, name) VALUES (1, 'Q') RETURNING id");
    const b = await one(c, `INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES (1, 3, ${q}, '2026-03-02', '2026-03-02', 4) RETURNING id`);
    await c.query(`INSERT INTO project_team (account_id, project_id, person_id) VALUES (1, ${q}, 3)`);
    const gone = await logged(c, () => c.query(`DELETE FROM projects WHERE id = ${q}`));
    expect(gone).toEqual(expect.arrayContaining([
      { entity: "allocations", id: b, op: "delete", people: "{3}" },
      { entity: "projects", id: q, op: "delete", people: null },
    ]));
    // Équipe d'un projet supprimé : rien de plus (la suppression du projet la porte déjà), comme avant 0006.
    expect(gone.filter((r) => r.entity === "project_team")).toEqual([]);
  });

  it("aucune ligne écrite après 0006 n'a person_ids NULL pour une entité par personne", async () => {
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM change_log WHERE entity IN ('people','allocations','timeoffs','logged_time','project_team') AND person_ids IS NULL");
    expect(rows[0].n).toBe(0);
  });

  it("non-régression : la suite SQL v1.1 passe sur les triggers remplacés", async () => {
    await c.query(readFileSync("tests/sql/schema_tests.sql", "utf8")); // lève 'FAIL: <libellé>' au premier échec
  }, 120_000);
});

describe("amorçage depuis 0005", () => {
  it("les lignes du journal antérieures restent à NULL ; les suivantes portent leur personne", async () => {
    const c = await freshDb();
    // Racine sans 0006 : la base est d'abord migrée jusqu'à 0005, avec des données.
    const root = mkdtempSync(join(dir, "root-"));
    mkdirSync(join(root, "migrations"));
    cpSync("schema.sql", join(root, "schema.sql"));
    for (const f of readdirSync("migrations").filter((x) => /^\d{4}_.*\.sql$/.test(x) && x < "0006")) cpSync(join("migrations", f), join(root, "migrations", f));
    expect(await migrate(c, { root })).toEqual(["0001", "0002", "0003", "0004", "0005"]);
    await c.query(`
      INSERT INTO accounts (name) VALUES ('A');
      INSERT INTO people (account_id, name) VALUES (1, 'Mia');
      INSERT INTO projects (account_id, name) VALUES (1, 'P');
      INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES (1, 1, 1, '2026-03-02', '2026-03-02', 4);`);
    const before = (await c.query("SELECT count(*)::int AS n FROM change_log")).rows[0].n;
    expect(await migrate(c)).toEqual(["0006"]);
    const old = await c.query("SELECT person_ids FROM change_log ORDER BY seq");
    expect(old.rows).toHaveLength(before);
    expect(old.rows.every((r) => r.person_ids === null)).toBe(true);
    const rows = await logged(c, () => c.query("UPDATE allocations SET hours_per_day = 2"));
    expect(rows).toEqual([{ entity: "allocations", id: "1", op: "update", people: "{1}" }]);
  }, 120_000);
});
