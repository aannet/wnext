// Notifications in-app (FR-10, US-7.3, BR-36) : migration 0004_notifications sur un vrai PostgreSQL (embedded-postgres), depuis zéro.
// Ce qu'une seule transaction ne peut pas montrer : le regroupement
// par VRAIE transaction, la visibilité après COMMIT et le réveil LISTEN/NOTIFY ciblé (canal wnext_notifications).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
let c: pg.Client;
const clients: pg.Client[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wnext-notif-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  base = `postgres://postgres:postgres@127.0.0.1:${port}`;
  await server.createDatabase("n");
  c = await connect();
  expect(await migrate(c)).toContain("0004");
}, 120_000);

afterAll(async () => {
  for (const x of clients) await x.end().catch(() => {});
  await server?.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function connect(): Promise<pg.Client> {
  const x = new pg.Client({ connectionString: `${base}/n` });
  await x.connect();
  clients.push(x);
  return x;
}

/** Une transaction de l'API : rôle app_user, contexte compte + utilisateur posé en SET LOCAL. */
async function asUser(account: number, user: number, fn: (q: (sql: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<void>) {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL ROLE app_user");
    await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [String(account), String(user)]);
    await fn((sql, p) => c.query(sql, p));
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  }
}

describe("0004_notifications", () => {
  it("depuis zéro : les suites v1.1 et BR-19 passent sur la base migrée", async () => {
    await c.query(readFileSync("tests/sql/schema_tests.sql", "utf8")); // lève 'FAIL: <libellé>' au premier échec
    await c.query(readFileSync("tests/sql/people_history_tests.sql", "utf8"));
  }, 120_000);

  it("regroupement par vraie transaction, visibilité réservée au destinataire après COMMIT, réveil ciblé", async () => {
    // Compte A : ua (member, personne pa), ub (admin, personne pb), uc (member sans personne).
    // (les séquences ne reculent pas au ROLLBACK de la suite SQL : identifiants relus, jamais supposés)
    const one = async (sql: string, p: unknown[] = []) => Number((await c.query(sql, p)).rows[0].id);
    const acc = await one("INSERT INTO accounts (name) VALUES ('A') RETURNING id");
    const [ua, ub, uc] = [await one("INSERT INTO users (email) VALUES ('a@x.test') RETURNING id"), await one("INSERT INTO users (email) VALUES ('b@x.test') RETURNING id"), await one("INSERT INTO users (email) VALUES ('c@x.test') RETURNING id")];
    const [pa, pb] = [await one("INSERT INTO people (account_id, name) VALUES ($1, 'pa') RETURNING id", [acc]), await one("INSERT INTO people (account_id, name) VALUES ($1, 'pb') RETURNING id", [acc])];
    await c.query("INSERT INTO projects (account_id, name) VALUES ($1, 'pr')", [acc]);
    await c.query("INSERT INTO account_members (account_id, user_id, role, person_id) VALUES ($1, $2, 'member', $5), ($1, $3, 'admin', $6), ($1, $4, 'member', NULL)", [acc, ua, ub, uc, pa, pb]);

    const listener = await connect();
    const wakes: string[] = [];
    listener.on("notification", (m) => { if (m.channel === "wnext_notifications") wakes.push(String(m.payload)); });
    await listener.query("LISTEN wnext_notifications");

    const insert = "INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) SELECT $1, pe.id, pr.id, $2::date, $2::date, 1 FROM people pe, projects pr WHERE pe.name = 'pa' AND pe.account_id = $1 AND pr.account_id = $1";
    await asUser(acc, ub, async (q) => {
      for (const d of ["2026-03-03", "2026-03-02", "2026-03-04"]) await q(insert, [acc, d]);
    });
    await asUser(acc, ub, async (q) => { await q("UPDATE allocations SET hours_per_day = 2 WHERE start_date = '2026-03-02'"); });

    const own = await c.query("SELECT type, payload, actor_user_id FROM notifications WHERE user_id = $1 ORDER BY id", [ua]);
    expect(own.rows).toEqual([
      { type: "allocation_changed", payload: { created: 3, startDate: "2026-03-02" }, actor_user_id: String(ub) },
      { type: "allocation_changed", payload: { updated: 1, startDate: "2026-03-02" }, actor_user_id: String(ub) },
    ]);

    // Après COMMIT, l'auteur (admin du compte) ne voit plus rien ; le destinataire voit les deux.
    const seen: Record<string, number> = {};
    for (const [who, user] of [["ua", ua], ["ub", ub], ["uc", uc]] as const) {
      await asUser(acc, user, async (q) => { seen[who] = Number((await q("SELECT count(*) AS n FROM notifications")).rows[0].n); });
    }
    expect(seen).toEqual({ ua: 2, ub: 0, uc: 0 });

    // Réveil : un message par transaction, adressé au seul destinataire ; marquer lu réveille aussi (compteur des autres onglets).
    await asUser(acc, ua, async (q) => { await q("UPDATE notifications SET read_at = now() WHERE read_at IS NULL"); });
    await expect.poll(() => wakes.length).toBe(3);
    expect(wakes).toEqual([`${acc}:${ua}`, `${acc}:${ua}`, `${acc}:${ua}`]);
  }, 60_000);
});
