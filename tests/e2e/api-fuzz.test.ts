// Robustesse de l'API sur TOUTES les opérations du contrat (packages/contracts/openapi.json), substitut local à Schemathesis :
// corps générés depuis les schémas puis mutés (champ manquant, mauvais type, null, champ inconnu, chaîne géante, JSON
// invalide), paramètres de chemin et de requête hostiles, If-Match variés, plusieurs rôles. Invariant : jamais de 5xx, et
// toute erreur au format ApiError (code stable, requestId), sauf le 431 du parseur HTTP de Node (URL > 16 Ko). Graine fixe ; élargir : FUZZ_CASES=300 FUZZ_SEED=7 npm run test:e2e.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApiError } from "@wnext/contracts";
import { devAuthenticate, startServer, type Db, type RunningServer } from "../../apps/api/src/index";

const CASES = Number(process.env.FUZZ_CASES ?? 12);
const SEED = Number(process.env.FUZZ_SEED ?? 1000);
const spec = JSON.parse(readFileSync("packages/contracts/openapi.json", "utf8"));

let pg: PGlite;
let srv: RunningServer;
let internal = 0;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync("schema.sql", "utf8"));
  // Un peu de données réelles pour que des ids existent (1, 2) et que les chemins heureux soient aussi parcourus.
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u1@x.test'), ('u2@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'admin'), (2, 2, 'admin');
    INSERT INTO departments (account_id, name) VALUES (1, 'D');
    INSERT INTO roles (account_id, name) VALUES (1, 'R');
    INSERT INTO people (account_id, name) VALUES (1, 'P1'), (1, 'P2');
    INSERT INTO clients (account_id, name) VALUES (1, 'C');
    INSERT INTO projects (account_id, name, client_id) VALUES (1, 'Pr', 1);
    INSERT INTO phases (account_id, project_id, name) VALUES (1, 1, 'Ph');
    INSERT INTO project_tasks (account_id, project_id, name) VALUES (1, 1, 'T');
    INSERT INTO milestones (account_id, project_id, name, due_date) VALUES (1, 1, 'M', '2026-04-01');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vac');
    INSERT INTO holidays (account_id, name, hdate) VALUES (1, 'H', '2026-05-01');
    INSERT INTO project_team (account_id, project_id, person_id) VALUES (1, 1, 1);
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES (1, 1, 1, '2026-03-02', '2026-03-06', 4);
    INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (1, 2, 1, '2026-03-09', '2026-03-10');
    INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1, 1, 1, '2026-03-02', 2);
  `);
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  srv = await startServer({
    db, authenticate: devAuthenticate, pollIntervalMs: 60_000,
    rateLimits: { windowSeconds: 60, ticketsPerUser: 1e6, ticketsPerAccount: 1e6, upgradesPerAccount: 1e6 },
    onError: () => { internal++; },
  });
}, 120_000);
afterAll(async () => { await srv?.close(); await pg?.close(); }, 60_000);

// ---------- génération ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const pick = <T,>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

type Schema = Record<string, any>;
const deref = (s: Schema): Schema => (s?.$ref ? deref(spec.components.schemas[s.$ref.split("/").pop()]) : s);

const DATES = ["2026-03-02", "2026-03-06", "2026-02-29", "2026-13-01", "0000-00-00", "2026-03-02T00:00:00Z", "9999-12-31"];
const IDS = ["1", "2", "0", "-1", "abc", "1.5", "99999999999999999999", "1e3", " 1", "%00", "1;DROP TABLE people"];
const JUNK: unknown[] = [null, "", "x".repeat(10_000), -1, 0, 1e308, -1e308, true, [], {}, "<script>", "\u0000", "NaN", 3.14159];

/** Valeur plausible pour un schéma (respecte souvent les contraintes, pas toujours : c'est voulu). */
function gen(r: R, s0: Schema, depth = 0): unknown {
  const s = deref(s0);
  if (!s || depth > 6) return null;
  if (s.const !== undefined) return s.const;
  if (s.enum) return pick(r, s.enum);
  const alt = s.oneOf ?? s.anyOf;
  if (alt) return gen(r, pick(r, alt), depth + 1);
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: Schema) => gen(r, x, depth + 1)));
  const type = Array.isArray(s.type) ? pick(r, s.type) : s.type;
  switch (type) {
    case "string":
      if (s.format === "date") return pick(r, DATES);
      if (s.pattern?.includes("\\d")) return pick(r, IDS);
      return pick(r, ["a", "Nom", "é€😀", "x".repeat(300), ""]);
    case "integer": return pick(r, [0, 1, 2, -1, 7, 1000, s.minimum ?? 0, s.maximum ?? 10]);
    case "number": return pick(r, [0, 0.5, 4, 8, 24, 25, 100, 500, 501, -3]);
    case "boolean": return r() < 0.5;
    case "null": return null;
    case "array": return Array.from({ length: Math.floor(r() * 4) }, () => gen(r, s.items ?? {}, depth + 1));
    case "object":
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries<Schema>(s.properties ?? {})) {
        if ((s.required ?? []).includes(k) || r() < 0.5) out[k] = gen(r, v, depth + 1);
      }
      return out;
    }
  }
}

/** Corps de requête : généré, puis muté une fois sur deux. Renvoie le texte envoyé. */
function body(r: R, schema: Schema | undefined): string {
  const roll = r();
  if (roll < 0.06) return pick(r, ["", "{", "nul", "[1,2", "\"texte\"", "1", "true"]);
  if (roll < 0.1) return JSON.stringify(pick(r, [[], [{}], null, 42]));
  const v = schema ? gen(r, schema) : {};
  if (r() < 0.5 && v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    const m = r();
    if (m < 0.3 && keys.length) delete o[pick(r, keys)];
    else if (m < 0.7 && keys.length) o[pick(r, keys)] = pick(r, JUNK);
    else o[pick(r, ["inconnu", "__proto__", "accountId", "id", "version"])] = pick(r, JUNK);
  }
  return JSON.stringify(v);
}

interface Operation { method: string; path: string; op: Schema }
const operations: Operation[] = Object.entries<Schema>(spec.paths).flatMap(([path, item]) =>
  ["get", "post", "put", "patch", "delete"].filter((m) => item[m]).map((m) => ({ method: m.toUpperCase(), path, op: item[m] })));

const ROLES = ["admin", "admin", "admin", "owner", "project_manager", "member", "guest", "none"] as const;

async function call(r: R, o: Operation) {
  const params: Schema[] = o.op.parameters ?? [];
  let url = o.path.replace(/\{(\w+)\}/g, () => encodeURIComponent(pick(r, IDS)));
  const q = new URLSearchParams();
  for (const p of params.filter((x) => x.in === "query")) {
    if (p.required || r() < 0.4) q.set(p.name, String(r() < 0.8 ? gen(r, p.schema) : pick(r, JUNK)));
  }
  if (r() < 0.2) q.set(pick(r, ["inconnu", "from", "limit", "cursor", "sort"]), String(pick(r, JUNK)));
  if ([...q].length) url += `?${q}`;

  const role = pick(r, ROLES);
  const headers: Record<string, string> = role === "none" ? {} : { "x-dev-account-id": pick(r, ["1", "1", "1", "2"]), "x-dev-user-id": "1", "x-dev-role": role };
  if (params.some((p) => p.in === "header" && p.name === "If-Match") || r() < 0.1) {
    const v = pick(r, ['"1"', '"2"', '"0"', "1", "abc", 'W/"1"', '"99999999999999999999"', ""]);
    if (r() < 0.85) headers["if-match"] = v;
  }
  const schema = o.op.requestBody?.content?.["application/json"]?.schema;
  let payload: string | undefined;
  if (o.method !== "GET" && o.method !== "DELETE") {
    payload = body(r, schema);
    headers["content-type"] = r() < 0.9 ? "application/json" : pick(r, ["text/plain", "application/x-www-form-urlencoded", "application/json; charset=latin1"]);
  } else if (r() < 0.05) {
    payload = body(r, undefined); // corps inattendu sur GET/DELETE
  }
  const res = await fetch(`http://127.0.0.1:${srv.port}${url}`, { method: o.method, headers, body: o.method === "GET" ? undefined : payload });
  const text = await res.text();
  return { status: res.status, text, desc: `${o.method} ${url} role=${role} body=${(payload ?? "").slice(0, 200)}` };
}

it(`${operations.length} opérations x ${CASES} cas : jamais de 5xx, erreurs au format ApiError`, async () => {
  expect(operations.length).toBeGreaterThan(80);
  const failures: string[] = [];
  const statuses = new Map<number, number>();
  for (const [i, o] of operations.entries()) {
    const r = rng(SEED + i);
    for (let k = 0; k < CASES; k++) {
      const { status, text, desc } = await call(r, o);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (status >= 500) failures.push(`${status} ${desc} -> ${text.slice(0, 200)}`);
      // 431 : en-têtes / URL trop longs (> 16 Ko), refusés par le parseur HTTP de Node avant l'application, sans corps.
      else if (status === 431) continue;
      else if (status >= 400) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        if (!ApiError.safeParse(parsed).success) failures.push(`${status} non ApiError : ${desc} -> ${text.slice(0, 200)}`);
      }
    }
  }
  if (failures.length) console.log(failures.slice(0, 30).join("\n"));
  expect(failures).toEqual([]);
  expect(internal).toBe(0);
  // le fuzz doit aussi atteindre des chemins heureux, pas seulement des refus
  expect([...statuses.keys()].some((s) => s >= 200 && s < 300)).toBe(true);
}, 300_000);
