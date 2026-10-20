import type { DepartmentCreate, DepartmentPatch, HolidayCreate, HolidayPatch, ProjectCreate, ProjectDetail, ProjectPatch, RoleCreate, RolePatch, TimeoffTypeCreate, TimeoffTypePatch } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import {
  HOLIDAY_COLUMNS, NAMED_COLUMNS, PROJECT_COLUMNS, TIMEOFF_TYPE_COLUMNS, toScheduleDepartment, toScheduleHoliday, toScheduleProject, toScheduleRole, toScheduleTimeoffType,
  type Row, type ScheduleDepartment, type ScheduleHoliday, type ScheduleRole, type ScheduleTimeoffType,
} from "./schedule";
import { assertAdmin, assertProjectScope, assertWriter, day, invalid, isId, lockAndCheck, notFound } from "./write";

// Lecture et écriture des entités de référence : départements, rôles, types de congé, fériés (configuration : owner et admin), projets
// (owner, admin, project_manager). Même mécanique que les allocations : rôle contrôlé avant tout accès aux données, verrou
// optimiste (FOR UPDATE puis comparaison à If-Match dans la même transaction, plus `AND row_version = n` à l'écriture), RLS + account_id.
//  * Unicité : 23505 -> ALREADY_EXISTS (entity, et field pour le code projet).
//  * Suppression SANS cascade silencieuse : la ligne est verrouillée, les lignes liées sont comptées dans la même transaction
//    (une insertion concurrente d'une référence attend ce verrou, FK = KEY SHARE) ; s'il y en a, REFERENCE_IN_USE avec les comptes.
//  * Pas de DELETE pour les projets (archivage par le statut).
//  * Lecture : liste paginée (curseur sur `id`, tri par id, total) et lecture par id, ouvertes à tout membre ; la RLS et `account_id` isolent les comptes.

/** 23505 (unicité) -> ALREADY_EXISTS ; 23514 (CHECK) -> VALIDATION_FAILED (filet : l'état est déjà validé plus haut). */
function translate(entity: string, field?: string): (err: unknown) => never {
  return (err) => {
    const code = (err as { code?: string })?.code;
    if (code === "23505") throw new ApiFailure("ALREADY_EXISTS", field ? { entity, field } : { entity });
    if (code === "23514") throw invalid("body");
    throw err;
  };
}

/** `writers` : la suppression est ouverte à owner, admin et project_manager (données de projet) au lieu de owner et admin (configuration). */
export interface Removal { table: "departments" | "roles" | "timeoff_types" | "holidays" | "clients" | "phases" | "project_tasks" | "milestones" | "project_expenses" | "project_budget_lines"; entity: string; columns: string; dependents: Record<string, string>; writers?: boolean }

/** Suppression vérifiée : version, puis refus s'il reste des lignes liées (comptes en params), sinon DELETE exact. */
export async function remove(db: Db, ctx: RequestContext, def: Removal, id: string, expected: number): Promise<void> {
  if (def.writers) assertWriter(ctx); else assertAdmin(ctx);
  await withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, def.table, def.columns, def.entity, ctx.accountId, id, expected);
    if (cur.project_id !== undefined) await assertProjectScope(tx, ctx, String(cur.project_id)); // données de projet (BR-33)
    const counts: Record<string, number> = {};
    for (const [label, sql] of Object.entries(def.dependents)) counts[label] = Number((await tx.query<Row>(sql, [ctx.accountId, id])).rows[0]!.n);
    if (Object.values(counts).some((n) => n > 0)) throw new ApiFailure("REFERENCE_IN_USE", { entity: def.entity, ...counts });
    const r = await tx.query(`DELETE FROM ${def.table} WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $3::int RETURNING id`, [id, ctx.accountId, expected]);
    if (!r.rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expected + 1 });
  });
}

export const count = (table: string, column: string) => `SELECT count(*) AS n FROM ${table} WHERE account_id = $1::bigint AND ${column} = $2::bigint`;

// --- Départements et rôles --------------------------------------------------------------------------------------------
function named<T>(table: "departments" | "roles", entity: string, map: (r: Row) => T, dependents: Record<string, string>) {
  const fail = translate(entity);
  return {
    async create(db: Db, ctx: RequestContext, body: { name: string }): Promise<T> {
      assertAdmin(ctx);
      return withContext(db, ctx, async (tx) => {
        const { rows } = await tx.query<Row>(`INSERT INTO ${table} (account_id, name) VALUES ($1::bigint, $2) RETURNING ${NAMED_COLUMNS}`, [ctx.accountId, body.name]).catch(fail);
        return map(rows[0]!);
      });
    },
    async update(db: Db, ctx: RequestContext, id: string, expected: number, patch: { name?: string }): Promise<T> {
      assertAdmin(ctx);
      return withContext(db, ctx, async (tx) => {
        const cur = await lockAndCheck(tx, table, NAMED_COLUMNS, entity, ctx.accountId, id, expected);
        const { rows } = await tx.query<Row>(
          `UPDATE ${table} SET name = $3 WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $4::int RETURNING ${NAMED_COLUMNS}`,
          [id, ctx.accountId, patch.name ?? cur.name, expected],
        ).catch(fail);
        if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
        return map(rows[0]);
      });
    },
    remove: (db: Db, ctx: RequestContext, id: string, expected: number) => remove(db, ctx, { table, entity, columns: NAMED_COLUMNS, dependents }, id, expected),
  };
}

const departments = named<ScheduleDepartment>("departments", "department", toScheduleDepartment, {
  people: count("people", "department_id"), holidays: count("holidays", "department_id"),
});
const roles = named<ScheduleRole>("roles", "role", toScheduleRole, { people: count("people", "role_id"), rates: count("rates", "role_id") });

export const createDepartment = (db: Db, ctx: RequestContext, body: DepartmentCreate) => departments.create(db, ctx, body);
export const updateDepartment = (db: Db, ctx: RequestContext, id: string, v: number, patch: DepartmentPatch) => departments.update(db, ctx, id, v, patch);
export const deleteDepartment = departments.remove;
export const createRole = (db: Db, ctx: RequestContext, body: RoleCreate) => roles.create(db, ctx, body);
export const updateRole = (db: Db, ctx: RequestContext, id: string, v: number, patch: RolePatch) => roles.update(db, ctx, id, v, patch);
export const deleteRole = roles.remove;

// --- Types de congé ---------------------------------------------------------------------------------------------------
const failType = translate("timeoff_type");

export async function createTimeoffType(db: Db, ctx: RequestContext, body: TimeoffTypeCreate): Promise<ScheduleTimeoffType> {
  assertAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    const { rows } = await tx.query<Row>(
      `INSERT INTO timeoff_types (account_id, name, deducted) VALUES ($1::bigint, $2, $3::boolean) RETURNING ${TIMEOFF_TYPE_COLUMNS}`,
      [ctx.accountId, body.name, body.deducted ?? true],
    ).catch(failType);
    return toScheduleTimeoffType(rows[0]!);
  });
}

export async function updateTimeoffType(db: Db, ctx: RequestContext, id: string, expected: number, patch: TimeoffTypePatch): Promise<ScheduleTimeoffType> {
  assertAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "timeoff_types", TIMEOFF_TYPE_COLUMNS, "timeoff_type", ctx.accountId, id, expected);
    const { rows } = await tx.query<Row>(
      `UPDATE timeoff_types SET name = $3, deducted = $4::boolean WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $5::int RETURNING ${TIMEOFF_TYPE_COLUMNS}`,
      [id, ctx.accountId, patch.name ?? cur.name, patch.deducted ?? cur.deducted, expected],
    ).catch(failType);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toScheduleTimeoffType(rows[0]);
  });
}

export const deleteTimeoffType = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, { table: "timeoff_types", entity: "timeoff_type", columns: TIMEOFF_TYPE_COLUMNS, dependents: { timeoffs: count("timeoffs", "timeoff_type_id") } }, id, expected);

// --- Jours fériés -----------------------------------------------------------------------------------------------------
const failHoliday = translate("holiday");

async function assertDepartment(tx: Queryable, accountId: string, id: string | null | undefined) {
  if (!id) return;
  if (!isId(id) || !(await tx.query("SELECT 1 FROM departments WHERE id = $1::bigint AND account_id = $2::bigint", [id, accountId])).rows.length) throw notFound("department");
}

export async function createHoliday(db: Db, ctx: RequestContext, body: HolidayCreate): Promise<ScheduleHoliday> {
  assertAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertDepartment(tx, ctx.accountId, body.departmentId);
    const { rows } = await tx.query<Row>(
      `INSERT INTO holidays (account_id, name, hdate, country, department_id, hours_off)
       VALUES ($1::bigint, $2, $3::date, $4, $5::bigint, $6::numeric) RETURNING ${HOLIDAY_COLUMNS}`,
      [ctx.accountId, body.name, body.date, body.country ?? null, body.departmentId ?? null, body.hoursOff ?? null],
    ).catch(failHoliday);
    return toScheduleHoliday(rows[0]!);
  });
}

export async function updateHoliday(db: Db, ctx: RequestContext, id: string, expected: number, patch: HolidayPatch): Promise<ScheduleHoliday> {
  assertAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "holidays", HOLIDAY_COLUMNS, "holiday", ctx.accountId, id, expected);
    const has = <K extends keyof HolidayPatch>(k: K) => patch[k] !== undefined;
    const departmentId = has("departmentId") ? patch.departmentId! : cur.department_id === null ? null : String(cur.department_id);
    if (has("departmentId")) await assertDepartment(tx, ctx.accountId, departmentId);
    const { rows } = await tx.query<Row>(
      `UPDATE holidays SET name = $3, hdate = $4::date, country = $5, department_id = $6::bigint, hours_off = $7::numeric
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $8::int RETURNING ${HOLIDAY_COLUMNS}`,
      [
        id, ctx.accountId, patch.name ?? cur.name, patch.date ?? day(cur.hdate),
        has("country") ? patch.country : cur.country === null ? null : String(cur.country).trim(),
        departmentId, has("hoursOff") ? patch.hoursOff : cur.hours_off === null ? null : Number(cur.hours_off), expected,
      ],
    ).catch(failHoliday);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toScheduleHoliday(rows[0]);
  });
}

export const deleteHoliday = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, { table: "holidays", entity: "holiday", columns: HOLIDAY_COLUMNS, dependents: {} }, id, expected);

// --- Projets ----------------------------------------------------------------------------------------------------------
const DETAIL_COLUMNS = `${PROJECT_COLUMNS}, project_manager_id, client_id, tags, notes`;
const failProject = translate("project", "projectCode");

function toDetail(r: Row): ProjectDetail {
  return {
    ...toScheduleProject(r),
    projectManagerId: r.project_manager_id === null ? null : String(r.project_manager_id),
    clientId: r.client_id === null ? null : String(r.client_id), tags: r.tags as string[], notes: r.notes ?? null,
  };
}

async function assertManager(tx: Queryable, accountId: string, id: string | null | undefined) {
  if (!id) return;
  if (!isId(id) || !(await tx.query("SELECT 1 FROM people WHERE id = $1::bigint AND account_id = $2::bigint", [id, accountId])).rows.length) throw notFound("person");
}

async function assertClient(tx: Queryable, accountId: string, id: string | null | undefined) {
  if (!id) return;
  if (!isId(id) || !(await tx.query("SELECT 1 FROM clients WHERE id = $1::bigint AND account_id = $2::bigint", [id, accountId])).rows.length) throw notFound("client");
}

export async function createProject(db: Db, ctx: RequestContext, body: ProjectCreate): Promise<ProjectDetail> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertManager(tx, ctx.accountId, body.projectManagerId);
    await assertClient(tx, ctx.accountId, body.clientId);
    const { rows } = await tx.query<Row>(
      `INSERT INTO projects (account_id, name, project_code, color, start_date, end_date, status, project_manager_id, non_billable, tags, notes, client_id)
       VALUES ($1::bigint, $2, $3, COALESCE($4, '#3B82F6'), $5::date, $6::date, $7::project_status, $8::bigint, $9::boolean, $10::text[], $11, $12::bigint)
       RETURNING ${DETAIL_COLUMNS}`,
      [
        ctx.accountId, body.name, body.projectCode ?? null, body.color ?? null, body.startDate ?? null, body.endDate ?? null,
        body.status ?? "planned", body.projectManagerId ?? null, body.nonBillable ?? false, body.tags ?? [], body.notes ?? null, body.clientId ?? null,
      ],
    ).catch(failProject);
    // BR-33 : le project_manager qui crée un projet en devient co-gestionnaire (sinon il ne pourrait plus l'écrire).
    if (ctx.role === "project_manager") {
      await tx.query(
        `INSERT INTO project_managers (project_id, account_id, user_id)
         SELECT $1::bigint, account_id, user_id FROM account_members WHERE account_id = $2::bigint AND user_id = $3::bigint ON CONFLICT DO NOTHING`,
        [rows[0]!.id, ctx.accountId, ctx.userId],
      );
    }
    return toDetail(rows[0]!);
  });
}

export async function updateProject(db: Db, ctx: RequestContext, id: string, expected: number, patch: ProjectPatch): Promise<ProjectDetail> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "projects", DETAIL_COLUMNS, "project", ctx.accountId, id, expected);
    await assertProjectScope(tx, ctx, id);
    const has = <K extends keyof ProjectPatch>(k: K) => patch[k] !== undefined;
    const startDate = has("startDate") ? patch.startDate! : cur.start_date === null ? null : day(cur.start_date);
    const endDate = has("endDate") ? patch.endDate! : cur.end_date === null ? null : day(cur.end_date);
    if (startDate && endDate && endDate < startDate) throw invalid("endDate"); // état résultant (le patch seul ne suffit pas à le voir)
    const manager = has("projectManagerId") ? patch.projectManagerId! : cur.project_manager_id === null ? null : String(cur.project_manager_id);
    if (has("projectManagerId")) await assertManager(tx, ctx.accountId, manager);
    const clientId = has("clientId") ? patch.clientId! : cur.client_id === null ? null : String(cur.client_id);
    if (has("clientId")) await assertClient(tx, ctx.accountId, clientId);
    const { rows } = await tx.query<Row>(
      `UPDATE projects SET name = $3, project_code = $4, color = $5, start_date = $6::date, end_date = $7::date, status = $8::project_status,
              project_manager_id = $9::bigint, non_billable = $10::boolean, tags = $11::text[], notes = $12, client_id = $14::bigint
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $13::int RETURNING ${DETAIL_COLUMNS}`,
      [
        id, ctx.accountId, patch.name ?? cur.name, has("projectCode") ? patch.projectCode : cur.project_code, patch.color ?? String(cur.color).trim(),
        startDate, endDate, patch.status ?? cur.status, manager, patch.nonBillable ?? cur.non_billable, patch.tags ?? cur.tags,
        has("notes") ? patch.notes : cur.notes, expected, clientId,
      ],
    ).catch(failProject);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toDetail(rows[0]);
  });
}

// --- Lecture ----------------------------------------------------------------------------------------------------------
export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 500;

export interface ListQuery { limit?: number; cursor?: string; from?: string; to?: string; status?: string; projectId?: string; phaseId?: string; dueFrom?: string; dueTo?: string; spentFrom?: string; spentTo?: string; taskId?: string; personId?: string; departmentId?: string; roleId?: string; tag?: string; search?: string; includeInactive?: boolean }
export interface Reader<T> {
  list(db: Db, ctx: RequestContext, q: ListQuery): Promise<{ items: T[]; page: { nextCursor: string | null; total: number } }>;
  get(db: Db, ctx: RequestContext, id: string): Promise<T>;
}

export const encodeCursor = (id: string) => Buffer.from(JSON.stringify({ id })).toString("base64url");
export function decodeCursor(raw: string): string {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof c?.id === "string" && isId(c.id)) return c.id;
  } catch { /* tombe sur l'erreur ci-dessous */ }
  throw new ApiFailure("SCHEDULE_CURSOR_INVALID");
}

/** Lecteur d'une table. `filters` traduit les filtres de la requête en conditions SQL paramétrées (table et colonnes sont des constantes du code). */
export function reader<T>(def: { /** Données financières : lecture réservée aux rôles d'écriture (en plus de la couche HTTP). */ restricted?: boolean; table: string; columns: string; entity: string; map: (r: Row) => T; filters?: (q: ListQuery, bind: (v: unknown) => string) => string[] }): Reader<T> {
  return {
    async list(db, ctx, q) {
      if (def.restricted) assertWriter(ctx);
      const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor); // avant d'ouvrir une transaction
      const n = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
      return withContext(db, ctx, async (tx) => {
        const args: unknown[] = [ctx.accountId];
        const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
        const where = ["account_id = $1::bigint", ...(def.filters?.(q, bind) ?? [])];
        const total = Number((await tx.query<Row>(`SELECT count(*) AS n FROM ${def.table} WHERE ${where.join(" AND ")}`, [...args])).rows[0]!.n);
        if (after !== undefined) where.push(`id > ${bind(after)}::bigint`);
        const { rows } = await tx.query<Row>(`SELECT ${def.columns} FROM ${def.table} WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${bind(n + 1)}::int`, args);
        const page = rows.slice(0, n);
        return { items: page.map(def.map), page: { nextCursor: rows.length > n ? encodeCursor(String(page[n - 1]!.id)) : null, total } };
      });
    },
    async get(db, ctx, id) {
      if (def.restricted) assertWriter(ctx);
      if (!isId(id)) throw notFound(def.entity);
      return withContext(db, ctx, async (tx) => {
        const r = (await tx.query<Row>(`SELECT ${def.columns} FROM ${def.table} WHERE id = $1::bigint AND account_id = $2::bigint`, [id, ctx.accountId])).rows[0];
        if (!r) throw notFound(def.entity);
        return def.map(r);
      });
    },
  };
}

export const departmentReader = reader({ table: "departments", columns: NAMED_COLUMNS, entity: "department", map: toScheduleDepartment });
export const roleReader = reader({ table: "roles", columns: NAMED_COLUMNS, entity: "role", map: toScheduleRole });
export const timeoffTypeReader = reader({ table: "timeoff_types", columns: TIMEOFF_TYPE_COLUMNS, entity: "timeoff_type", map: toScheduleTimeoffType });
export const holidayReader = reader({
  table: "holidays", columns: HOLIDAY_COLUMNS, entity: "holiday", map: toScheduleHoliday,
  filters: (q, bind) => [...(q.from ? [`hdate >= ${bind(q.from)}::date`] : []), ...(q.to ? [`hdate <= ${bind(q.to)}::date`] : [])],
});
export const projectReader = reader({
  table: "projects", columns: DETAIL_COLUMNS, entity: "project", map: toDetail,
  filters: (q, bind) => [q.status ? `status = ${bind(q.status)}::project_status` : "status <> 'archived'"], // archivés : sur demande (status=archived)
});
