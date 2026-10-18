#!/usr/bin/env node
// Migrations PostgreSQL, sans dépendance hors `pg`.
//  * 0001_init = schema.sql (la baseline) ; les suivantes : migrations/NNNN_nom.sql, appliquées dans l'ordre.
//  * Chaque migration tourne dans sa propre transaction, enregistrée dans wnext_migrations.applied dans la même
//    transaction : une migration en échec ne laisse ni trace ni demi-schéma.
//  * Registre hors du schéma public : app_user n'y a aucun droit et l'inventaire RLS (T18) reste exact.
//  * Verrou consultatif de session : deux déploiements simultanés s'attendent, le second ne fait rien.
//  * Refus (sans rien appliquer) : somme de contrôle d'une migration appliquée modifiée, migration appliquée absente
//    du disque, nouvelle migration numérotée sous la dernière appliquée.
// Usage : DATABASE_URL=postgres://... node scripts/migrate.mjs [--status] [--root <dossier>]
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { isMain, parseArgs } from "./guardrails/lib.mjs";

const LOCK_KEY = 728_431_901; // arbitraire, propre à WNEXT
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {}

/** Migrations du disque, triées : la baseline puis migrations/. */
export function listMigrations(root = process.cwd()) {
  const read = (file) => {
    const sql = readFileSync(join(root, file), "utf8");
    return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
  };
  const out = [{ version: "0001", name: "init", file: "schema.sql", ...read("schema.sql") }];
  let files = [];
  try {
    files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // pas de dossier migrations/ : la baseline seule
  }
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) throw new MigrationError(`migrations/${f} : nom attendu NNNN_nom.sql (minuscules, chiffres, _)`);
    if (m[1] === "0001") throw new MigrationError(`migrations/${f} : 0001 est réservé à la baseline schema.sql`);
    if (out.some((x) => x.version === m[1])) throw new MigrationError(`migrations/${f} : version ${m[1]} en double`);
    out.push({ version: m[1], name: m[2], file: join("migrations", f), ...read(join("migrations", f)) });
  }
  return out;
}

async function ensureRegistry(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS wnext_migrations;
    CREATE TABLE IF NOT EXISTS wnext_migrations.applied (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
}

/** Compare le disque et la base ; lève MigrationError sur toute incohérence. Retourne les migrations à appliquer. */
export function plan(onDisk, applied) {
  const byVersion = new Map(onDisk.map((m) => [m.version, m]));
  for (const a of applied) {
    const m = byVersion.get(a.version);
    if (!m) throw new MigrationError(`migration ${a.version}_${a.name} appliquée mais absente du disque`);
    if (m.checksum !== a.checksum) {
      throw new MigrationError(`migration ${a.version}_${a.name} modifiée après application (somme de contrôle différente) : écrire une nouvelle migration`);
    }
  }
  const done = new Set(applied.map((a) => a.version));
  const last = applied.map((a) => a.version).sort().at(-1);
  const pending = onDisk.filter((m) => !done.has(m.version));
  const late = pending.find((m) => last !== undefined && m.version < last);
  if (late) throw new MigrationError(`migration ${late.version}_${late.name} numérotée sous la dernière appliquée (${last}) : la renuméroter`);
  return pending;
}

/** Applique les migrations en attente. Retourne les versions appliquées. */
export async function migrate(client, { root = process.cwd(), log = () => {} } = {}) {
  const onDisk = listMigrations(root);
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await ensureRegistry(client);
    const { rows } = await client.query("SELECT version, name, checksum FROM wnext_migrations.applied ORDER BY version");
    const pending = plan(onDisk, rows);
    for (const m of pending) {
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO wnext_migrations.applied(version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new MigrationError(`migration ${m.version}_${m.name} en échec, annulée : ${e.message}`);
      }
      log(`appliquée : ${m.version}_${m.name}`);
    }
    return pending.map((m) => m.version);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

/** État : appliquées et en attente, sans rien modifier (lève sur incohérence). */
export async function status(client, { root = process.cwd() } = {}) {
  const onDisk = listMigrations(root);
  const reg = await client.query("SELECT to_regclass('wnext_migrations.applied') IS NOT NULL AS ok");
  const applied = reg.rows[0].ok
    ? (await client.query("SELECT version, name, checksum FROM wnext_migrations.applied ORDER BY version")).rows
    : [];
  return { applied: applied.map((a) => a.version), pending: plan(onDisk, applied).map((m) => m.version) };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate : DATABASE_URL absent");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (args.status) {
      const s = await status(client, { root: args.root });
      console.log(`appliquées : ${s.applied.join(", ") || "aucune"} ; en attente : ${s.pending.join(", ") || "aucune"}`);
    } else {
      const done = await migrate(client, { root: args.root, log: (l) => console.log(l) });
      console.log(done.length ? `${done.length} migration(s) appliquée(s)` : "base à jour");
    }
  } catch (e) {
    console.error(`migrate : ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
