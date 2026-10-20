import { IMPORT_MAX_ERRORS, IMPORT_MAX_ROWS, type ImportKind, type ImportQuery, type ImportReport, type ImportRequest, type ImportRowErrorCode } from "@wnext/contracts";
import { analyzeImport, importReport, nameKey, planImport, type ImportErrorCode, type ImportPlan, type ImportSnapshot, type RefValue } from "@wnext/engine";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import type { Row } from "./schedule";
import { accountToday, assertAdmin, day } from "./write";

// Import CSV simple (US-1.2 ; contrat : packages/contracts/src/imports.ts). L'analyse et le plan sont ceux de @wnext/engine
// (purs, partagés avec l'écran) ; ici : verrou, lecture de l'état du compte, écritures.
//  * Owner et admin (assertAdmin) : l'import crée des départements et des rôles (configuration du compte).
//  * Une transaction, précédée d'un verrou consultatif par compte : deux imports du même compte s'exécutent l'un après l'autre (la
//    clé des clients, le nom, n'a pas de contrainte d'unicité en base). Le dryRun prend le même chemin et n'écrit rien.
//  * Écritures ordinaires : created_by / modified_by, version et change_log par les triggers ; historique daté des personnes
//    (0002) avec la date d'effet par défaut (aujourd'hui, fuseau du compte), la période verrouillée étant refusée par ligne par le plan.

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Les codes d'erreur du moteur sont exactement ceux du contrat (échec de compilation sinon). */
export const IMPORT_CODES_MATCH: Eq<ImportErrorCode, ImportRowErrorCode> = true;

const ids = (v: unknown) => (v === null || v === undefined ? null : String(v));

async function loadSnapshot(tx: Queryable, accountId: string, kind: ImportKind): Promise<ImportSnapshot> {
  const all = async (sql: string) => (await tx.query<Row>(sql, [accountId])).rows;
  const named = async (table: "departments" | "roles") =>
    (await all(`SELECT id, name FROM ${table} WHERE account_id = $1::bigint ORDER BY id`)).map((r) => ({ id: String(r.id), name: String(r.name) }));
  const snap: ImportSnapshot = { today: await accountToday(tx, accountId), departments: [], roles: [], clients: [], people: [], projects: [] };
  if (kind === "people") [snap.departments, snap.roles] = [await named("departments"), await named("roles")];
  if (kind !== "people") {
    snap.clients = (await all("SELECT id, name, short_name, tags FROM clients WHERE account_id = $1::bigint ORDER BY id"))
      .map((r) => ({ id: String(r.id), name: String(r.name), shortName: r.short_name ?? null, tags: r.tags as string[] }));
  }
  if (kind !== "clients") {
    snap.people = (await all(
      `SELECT p.id, p.name, p.email, p.people_type, p.department_id, p.role_id, p.country, p.work_days_hours, p.tags,
              (SELECT max(l.work_date) FROM logged_time l WHERE l.account_id = p.account_id AND l.person_id = p.id AND l.status <> 'draft')::text AS locked_through
         FROM people p WHERE p.account_id = $1::bigint ORDER BY p.id`,
    )).map((r) => ({
      id: String(r.id), name: String(r.name), email: r.email ?? null, peopleType: r.people_type, departmentId: ids(r.department_id), roleId: ids(r.role_id),
      country: r.country === null ? null : String(r.country).trim(), workDaysHours: (r.work_days_hours as unknown[]).map(Number), tags: r.tags as string[],
      lockedThrough: r.locked_through ?? null,
    }));
  }
  if (kind === "projects") {
    snap.projects = (await all(
      `SELECT id, name, project_code, client_id, color, start_date, end_date, status, project_manager_id, non_billable, tags, notes
         FROM projects WHERE account_id = $1::bigint ORDER BY id`,
    )).map((r) => ({
      id: String(r.id), name: String(r.name), projectCode: r.project_code ?? null, clientId: ids(r.client_id), color: String(r.color).trim(),
      startDate: r.start_date === null ? null : day(r.start_date), endDate: r.end_date === null ? null : day(r.end_date), status: r.status,
      projectManagerId: ids(r.project_manager_id), nonBillable: Boolean(r.non_billable), tags: r.tags as string[], notes: r.notes ?? null,
    }));
  }
  return snap;
}

/** Colonnes à écrire : [colonne, valeur, type SQL]. Les valeurs absentes sont omises par l'appelant. */
type Cols = Array<[string, unknown, string]>;
async function insert(tx: Queryable, table: "people" | "projects" | "clients", accountId: string, cols: Cols) {
  const names = ["account_id", ...cols.map((c) => c[0])];
  const values = ["$1::bigint", ...cols.map((c, i) => `$${i + 2}::${c[2]}`)];
  await tx.query(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${values.join(", ")})`, [accountId, ...cols.map((c) => c[1])]);
}
async function update(tx: Queryable, table: "people" | "projects" | "clients", accountId: string, id: string, cols: Cols) {
  const set = cols.map((c, i) => `${c[0]} = $${i + 3}::${c[2]}`).join(", ");
  await tx.query(`UPDATE ${table} SET ${set} WHERE id = $1::bigint AND account_id = $2::bigint`, [id, accountId, ...cols.map((c) => c[1])]);
}
const col = (name: string, value: unknown, type: string): Cols => (value === undefined ? [] : [[name, value, type]]);

/** Crée les références manquantes ; renvoie clé de nom -> identifiant. Une création concurrente du même nom est reprise. */
async function createNamed(tx: Queryable, table: "departments" | "roles", accountId: string, names: string[]) {
  const out = new Map<string, string>();
  for (const name of names) {
    const { rows } = await tx.query<Row>(
      `WITH ins AS (INSERT INTO ${table} (account_id, name) VALUES ($1::bigint, $2) ON CONFLICT (account_id, name) DO NOTHING RETURNING id)
       SELECT id FROM ins UNION ALL SELECT id FROM ${table} WHERE account_id = $1::bigint AND name = $2 LIMIT 1`,
      [accountId, name],
    );
    out.set(nameKey(name), String(rows[0]!.id));
  }
  return out;
}

async function apply(tx: Queryable, accountId: string, plan: ImportPlan) {
  const departments = await createNamed(tx, "departments", accountId, plan.references.departments);
  const roles = await createNamed(tx, "roles", accountId, plan.references.roles);
  const clients = new Map<string, string>();
  for (const name of plan.references.clients) {
    const { rows } = await tx.query<Row>("INSERT INTO clients (account_id, name) VALUES ($1::bigint, $2) RETURNING id", [accountId, name]);
    clients.set(nameKey(name), String(rows[0]!.id));
  }
  const ref = (r: RefValue | undefined, created: Map<string, string>) => (r === undefined ? undefined : "id" in r ? r.id : created.get(nameKey(r.create))!);

  if (plan.kind === "people") {
    const p = plan as ImportPlan<"people">;
    const cols = (w: (typeof p.creates)[number]["values"]): Cols => [
      ...col("name", w.name, "text"), ...col("email", w.email, "text"), ...col("people_type", w.peopleType, "people_type"),
      ...col("department_id", ref(w.department, departments), "bigint"), ...col("role_id", ref(w.role, roles), "bigint"),
      ...col("country", w.country, "text"), ...col("work_days_hours", w.workDaysHours, "numeric[]"), ...col("tags", w.tags, "text[]"),
    ];
    for (const c of p.creates) await insert(tx, "people", accountId, cols(c.values));
    for (const u of p.updates) await update(tx, "people", accountId, u.id, cols(u.changes));
  } else if (plan.kind === "projects") {
    const p = plan as ImportPlan<"projects">;
    const cols = (w: (typeof p.creates)[number]["values"]): Cols => [
      ...col("name", w.name, "text"), ...col("project_code", w.projectCode, "text"), ...col("client_id", ref(w.client, clients), "bigint"),
      ...col("color", w.color, "text"), ...col("start_date", w.startDate, "date"), ...col("end_date", w.endDate, "date"),
      ...col("status", w.status, "project_status"), ...col("project_manager_id", w.projectManagerId, "bigint"),
      ...col("non_billable", w.nonBillable, "boolean"), ...col("tags", w.tags, "text[]"), ...col("notes", w.notes, "text"),
    ];
    for (const c of p.creates) await insert(tx, "projects", accountId, cols(c.values));
    for (const u of p.updates) await update(tx, "projects", accountId, u.id, cols(u.changes));
  } else {
    const p = plan as ImportPlan<"clients">;
    const cols = (w: (typeof p.creates)[number]["values"]): Cols => [...col("name", w.name, "text"), ...col("short_name", w.shortName, "text"), ...col("tags", w.tags, "text[]")];
    for (const c of p.creates) await insert(tx, "clients", accountId, cols(c.values));
    for (const u of p.updates) await update(tx, "clients", accountId, u.id, cols(u.changes));
  }
}

export async function runImport(db: Db, ctx: RequestContext, kind: ImportKind, query: ImportQuery, body: ImportRequest): Promise<ImportReport> {
  assertAdmin(ctx);
  const analysis = analyzeImport(kind, body.csv); // pur : avant d'ouvrir une transaction
  if (analysis.rows > IMPORT_MAX_ROWS) throw new ApiFailure("IMPORT_TOO_LARGE", { maxRows: IMPORT_MAX_ROWS, rows: analysis.rows });
  const dryRun = query.dryRun === true;
  return withContext(db, ctx, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('wnext.import:' || $1::text, 0))", [ctx.accountId]);
    const plan = planImport(analysis, await loadSnapshot(tx, ctx.accountId, kind));
    if (!dryRun && plan.errors.length > 0 && body.skipInvalid !== true) throw new ApiFailure("IMPORT_HAS_ERRORS", { invalid: plan.invalid, rows: plan.rows });
    if (!dryRun) await apply(tx, ctx.accountId, plan);
    return importReport(plan, { dryRun, applied: !dryRun, maxErrors: IMPORT_MAX_ERRORS });
  });
}
