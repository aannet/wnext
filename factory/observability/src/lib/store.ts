import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loadBudgets } from "./config";
import { PHASES, type BudgetConfig, type FactoryEvent, type StoredEvent } from "./types";
import { SCHEMA_VERSION, validateEvent } from "./validate";

/**
 * Total de tokens d'un événement : entrée + sortie + cache (strategy.md §1 : « cache compris »).
 * Même expression dans les vues SQL.
 */
const TOK = "(tokens_in + tokens_out + COALESCE(tokens_cache_read,0) + COALESCE(tokens_cache_write,0))";

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,   -- séquence d'arrivée (Last-Event-ID du SSE)
  schema_version     TEXT    NOT NULL,
  ts                 TEXT    NOT NULL,
  run_id             TEXT    NOT NULL,
  line               TEXT    NOT NULL,
  phase              TEXT    NOT NULL CHECK (phase IN ('P0','P1','P2','P3','P4','P5')),
  agent              TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  action             TEXT    NOT NULL,
  tokens_in          INTEGER NOT NULL CHECK (tokens_in >= 0),
  tokens_out         INTEGER NOT NULL CHECK (tokens_out >= 0),
  cost               REAL    NOT NULL CHECK (cost >= 0),
  duration_ms        INTEGER NOT NULL CHECK (duration_ms >= 0),
  status             TEXT    NOT NULL,
  attempt            INTEGER,
  parent_id          TEXT,
  tokens_cache_read  INTEGER,
  tokens_cache_write INTEGER,
  budget_remaining   INTEGER,
  detail             TEXT,                                 -- JSON court
  received_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, ts, action, agent)                       -- clé d'idempotence (strategy.md §5.3)
);
CREATE INDEX IF NOT EXISTS ix_events_line  ON events (line, ts);
CREATE INDEX IF NOT EXISTS ix_events_phase ON events (phase);
CREATE INDEX IF NOT EXISTS ix_events_ts    ON events (ts);

-- Append-only : aucune modification ni suppression.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events est append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events est append-only'); END;

-- Compteurs d'ingestion (events_invalid_total, ...) persistants.
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
-- Raisons de rejet (jamais le contenu rejeté).
CREATE TABLE IF NOT EXISTS invalid_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason TEXT NOT NULL
);
-- Budgets : recopiés de config/budgets.json à chaque démarrage.
CREATE TABLE IF NOT EXISTS phase_budgets (
  phase TEXT PRIMARY KEY, budget_tokens INTEGER NOT NULL,
  alert_ratio REAL NOT NULL, hard_ceiling_factor REAL NOT NULL
);

DROP VIEW IF EXISTS v_cost_by_agent;
CREATE VIEW v_cost_by_agent AS
  SELECT agent, COUNT(*) AS events, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(${TOK}) AS tokens_total, ROUND(SUM(cost), 6) AS cost
  FROM events GROUP BY agent;

DROP VIEW IF EXISTS v_cost_by_line;
CREATE VIEW v_cost_by_line AS
  SELECT line, MIN(phase) AS phase, COUNT(*) AS events, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(${TOK}) AS tokens_total, ROUND(SUM(cost), 6) AS cost
  FROM events GROUP BY line;

DROP VIEW IF EXISTS v_cost_by_phase;
CREATE VIEW v_cost_by_phase AS
  SELECT phase, COUNT(*) AS events, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(${TOK}) AS tokens_total, ROUND(SUM(cost), 6) AS cost
  FROM events GROUP BY phase;

DROP VIEW IF EXISTS v_cost_by_model;
CREATE VIEW v_cost_by_model AS
  SELECT model, COUNT(*) AS events, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(${TOK}) AS tokens_total, ROUND(SUM(cost), 6) AS cost
  FROM events GROUP BY model;

DROP VIEW IF EXISTS v_cost_by_phase_model;
CREATE VIEW v_cost_by_phase_model AS
  SELECT phase, model, SUM(${TOK}) AS tokens_total, ROUND(SUM(cost), 6) AS cost
  FROM events GROUP BY phase, model;

-- Matrice phase x agent : une entrée par (phase, agent, ligne, modèle).
DROP VIEW IF EXISTS v_phase_agent_line;
CREATE VIEW v_phase_agent_line AS
  SELECT phase, agent, line, model, COUNT(*) AS events, SUM(${TOK}) AS tokens_total,
         SUM(status IN ('error','blocked','looping','killed')) AS errors
  FROM events GROUP BY phase, agent, line, model;

-- Budget de phase vs consommé. alert_level : ok | warn (>= alert_ratio) | over (>= budget) | ceiling (>= plafond dur)
DROP VIEW IF EXISTS v_phase_budget;
CREATE VIEW v_phase_budget AS
  SELECT b.phase, b.budget_tokens, CAST(b.budget_tokens * b.hard_ceiling_factor AS INTEGER) AS ceiling_tokens,
         COALESCE(c.tokens_total, 0) AS consumed_tokens, COALESCE(c.cost, 0) AS cost,
         ROUND(1.0 * COALESCE(c.tokens_total, 0) / b.budget_tokens, 4) AS pct_budget,
         ROUND(1.0 * COALESCE(c.tokens_total, 0) / (b.budget_tokens * b.hard_ceiling_factor), 4) AS pct_ceiling,
         CASE WHEN COALESCE(c.tokens_total,0) >= b.budget_tokens * b.hard_ceiling_factor THEN 'ceiling'
              WHEN COALESCE(c.tokens_total,0) >= b.budget_tokens THEN 'over'
              WHEN COALESCE(c.tokens_total,0) >= b.budget_tokens * b.alert_ratio THEN 'warn'
              ELSE 'ok' END AS alert_level
  FROM phase_budgets b LEFT JOIN v_cost_by_phase c ON c.phase = b.phase;

-- Retries, escalades et boucles par ligne.
DROP VIEW IF EXISTS v_line_retries;
CREATE VIEW v_line_retries AS
  SELECT line, MIN(phase) AS phase,
         SUM(action LIKE 'retry.%')                         AS retries,
         SUM(action LIKE 'escalate.%')                      AS escalations,
         SUM(action = 'loop.detected' OR status = 'looping') AS loops,
         COALESCE(MAX(attempt), 1)                          AS max_attempt
  FROM events WHERE line NOT IN ('_phase','_global') GROUP BY line;

-- Dernier événement par ligne -> état. merged | blocked | killed | active
DROP VIEW IF EXISTS v_line_state;
CREATE VIEW v_line_state AS
  WITH last AS (
    SELECT e.* FROM events e
    WHERE e.id = (SELECT x.id FROM events x WHERE x.line = e.line ORDER BY x.ts DESC, x.id DESC LIMIT 1)
      AND e.line NOT IN ('_phase','_global')
  )
  SELECT l.line, l.phase, l.run_id, l.agent AS last_agent, l.action AS last_action, l.status AS last_status, l.ts AS last_ts,
         CASE WHEN l.action = 'merge.done' THEN 'merged'
              WHEN l.status = 'killed' OR l.action = 'kill.triggered' THEN 'killed'
              WHEN l.status IN ('blocked','looping') OR l.action = 'loop.detected' THEN 'blocked'
              ELSE 'active' END AS state,
         c.events, c.tokens_total, c.cost, r.retries, r.escalations, r.loops, r.max_attempt
  FROM last l JOIN v_cost_by_line c ON c.line = l.line JOIN v_line_retries r ON r.line = l.line;
`;

export interface IngestOutcome {
  accepted: number;
  duplicates: number;
  invalid: number;
  errors: { index: number; reason: string }[];
}

export class Store {
  readonly db: Database.Database;
  readonly bus = new EventEmitter();
  readonly budgets: BudgetConfig;

  constructor(dbPath: string, budgets: BudgetConfig = loadBudgets()) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
    this.budgets = budgets;
    const up = this.db.prepare(
      `INSERT INTO phase_budgets (phase, budget_tokens, alert_ratio, hard_ceiling_factor) VALUES (?,?,?,?)
       ON CONFLICT(phase) DO UPDATE SET budget_tokens=excluded.budget_tokens, alert_ratio=excluded.alert_ratio, hard_ceiling_factor=excluded.hard_ceiling_factor`,
    );
    for (const p of PHASES) up.run(p, budgets.phases[p], budgets.alert_ratio, budgets.hard_ceiling_factor);
    this.bus.setMaxListeners(0);
  }

  private bump(name: string, by: number) {
    if (!by) return;
    this.db
      .prepare("INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value")
      .run(name, by);
  }

  counters(): Record<string, number> {
    const out: Record<string, number> = { events_received_total: 0, events_invalid_total: 0, events_duplicate_total: 0 };
    for (const r of this.db.prepare("SELECT name, value FROM counters").all() as { name: string; value: number }[]) out[r.name] = r.value;
    return out;
  }

  recentInvalid(limit = 5): { received_at: string; reason: string }[] {
    return this.db.prepare("SELECT received_at, reason FROM invalid_log ORDER BY id DESC LIMIT ?").all(limit) as never;
  }

  /**
   * Ingère des objets déjà parsés (ou des erreurs de parsing représentées par `undefined`).
   * Idempotent (INSERT OR IGNORE sur la clé d'unicité). Émet sur le bus uniquement les nouveaux événements.
   */
  ingest(items: unknown[]): IngestOutcome {
    const out: IngestOutcome = { accepted: 0, duplicates: 0, invalid: 0, errors: [] };
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO events
       (schema_version, ts, run_id, line, phase, agent, model, action, tokens_in, tokens_out, cost, duration_ms, status,
        attempt, parent_id, tokens_cache_read, tokens_cache_write, budget_remaining, detail)
       VALUES (@schema_version,@ts,@run_id,@line,@phase,@agent,@model,@action,@tokens_in,@tokens_out,@cost,@duration_ms,@status,
        @attempt,@parent_id,@tokens_cache_read,@tokens_cache_write,@budget_remaining,@detail)`,
    );
    const getById = this.db.prepare("SELECT * FROM events WHERE id = ?");
    const fresh: StoredEvent[] = [];
    const reasons: string[] = [];

    this.db.transaction(() => {
      items.forEach((item, index) => {
        const v = validateEvent(item);
        if (!v.ok) {
          out.invalid++;
          reasons.push(v.reason);
          if (out.errors.length < 20) out.errors.push({ index, reason: v.reason });
          return;
        }
        const e = v.event;
        const r = insert.run({
          schema_version: e.schema_version ?? SCHEMA_VERSION,
          ts: e.ts, run_id: e.run_id, line: e.line, phase: e.phase, agent: e.agent, model: e.model, action: e.action,
          tokens_in: e.tokens_in, tokens_out: e.tokens_out, cost: Math.round(e.cost * 1e6) / 1e6,
          duration_ms: e.duration_ms, status: e.status,
          attempt: e.attempt ?? null, parent_id: e.parent_id ?? null,
          tokens_cache_read: e.tokens_cache_read ?? null, tokens_cache_write: e.tokens_cache_write ?? null,
          budget_remaining: e.budget_remaining ?? null, detail: e.detail ? JSON.stringify(e.detail) : null,
        });
        if (r.changes === 0) out.duplicates++;
        else {
          out.accepted++;
          fresh.push(rowToEvent(getById.get(r.lastInsertRowid) as Row));
        }
      });
      this.bump("events_received_total", items.length);
      this.bump("events_invalid_total", out.invalid);
      this.bump("events_duplicate_total", out.duplicates);
      const il = this.db.prepare("INSERT INTO invalid_log (reason) VALUES (?)");
      for (const r of reasons.slice(0, 50)) il.run(r);
    })();

    for (const ev of fresh) this.bus.emit("event", ev);
    return out;
  }

  /** Compte un rejet hors validation (ligne JSON illisible, etc.). */
  countUnparseable(n: number, reason: string) {
    if (n <= 0) return;
    this.db.transaction(() => {
      this.bump("events_received_total", n);
      this.bump("events_invalid_total", n);
      this.db.prepare("INSERT INTO invalid_log (reason) VALUES (?)").run(reason);
    })();
  }

  eventsAfter(afterId: number, limit = 5000): StoredEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, limit) as Row[]).map(rowToEvent);
  }

  recent(limit = 100): StoredEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map(rowToEvent);
  }

  lastId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM events").get() as { m: number }).m;
  }

  close() {
    this.db.close();
  }
}

type Row = Omit<StoredEvent, "detail"> & { detail: string | null };

export function rowToEvent(r: Row): StoredEvent {
  const e: Record<string, unknown> = { ...r, detail: r.detail ? JSON.parse(r.detail) : undefined };
  for (const k of Object.keys(e)) if (e[k] === null || e[k] === undefined) delete e[k];
  delete e.received_at;
  return e as unknown as StoredEvent;
}

// Singleton partagé entre les route handlers (et résistant au HMR de next dev).
const g = globalThis as unknown as { __obsStore?: Store };

export function getStore(): Store {
  if (!g.__obsStore) g.__obsStore = new Store(process.env.OBS_DB_PATH ?? "data/events.db");
  return g.__obsStore;
}

export function resetStoreForTests() {
  g.__obsStore?.close();
  g.__obsStore = undefined;
}
