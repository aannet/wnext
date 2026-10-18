// Vrai PostgreSQL (binaires npm `embedded-postgres`, sans root ni Docker) pour les tests de concurrence que PGlite ne peut pas
// porter : PGlite n'a qu'UNE connexion, donc aucun verrou de ligne n'y attend jamais. Ici, deux connexions réelles.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import type { RequestContext } from "../../apps/api/src/index";
import { pgDb } from "../../apps/api/src/pg-db";

export interface Cluster {
  /** Connexion superutilisateur, pour amorcer et observer (pg_stat_activity). */
  admin: pg.Client;
  /** Pool applicatif : transactions en SET LOCAL ROLE app_user, comme en production (pgDb). */
  pool: pg.Pool;
  db: ReturnType<typeof pgDb>;
  /** Transaction ouverte à la main sous app_user + contexte, pour tenir un verrou pendant qu'une opération de l'API s'y heurte. */
  hold(ctx: RequestContext): Promise<Held>;
  /** Attend que `n` requêtes soient bloquées sur un verrou (pg_stat_activity). */
  waitBlocked(n?: number): Promise<void>;
  stop(): Promise<void>;
}
export interface Held { query: pg.Client["query"]; commit(): Promise<void>; rollback(): Promise<void> }

export async function startCluster(): Promise<Cluster> {
  const dir = mkdtempSync(join(tmpdir(), "wnext-pg-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase("wnext");
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/wnext`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS citext;");
  await admin.query(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  const open: pg.Client[] = [];
  return {
    admin, pool, db: pgDb(pool, { role: "app_user" }),
    async hold(ctx) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      open.push(c);
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE app_user");
      await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)", [ctx.accountId, ctx.userId, ctx.role]);
      return { query: c.query.bind(c) as pg.Client["query"], commit: async () => { await c.query("COMMIT"); }, rollback: async () => { await c.query("ROLLBACK"); } };
    },
    async waitBlocked(n = 1) {
      for (let i = 0; i < 200; i++) {
        const r = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'");
        if (r.rows[0].n >= n) return;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error("aucune requête bloquée sur un verrou");
    },
    async stop() {
      for (const c of open) await c.end().catch(() => {});
      await pool.end().catch(() => {});
      await admin.end().catch(() => {});
      await server.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
