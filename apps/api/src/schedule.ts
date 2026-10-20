import { MAX_RANGE_DAYS } from "@wnext/engine";
import type { ScheduleQuery, ScheduleResponse } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { day, idParam } from "./write";

// GET /api/v1/schedule. Isolation entre comptes en deux couches : la RLS de schema.sql (rôle app_user, contexte posé par
// withContext) ET `account_id = $1` dans CHAQUE requête ci-dessous (testé sous app_user). Ne jamais renvoyer cost_rate, email, budget (contrat : zéro fuite).

const DEFAULT_LIMIT = 200;
const DAY_MS = 86_400_000;
const num = (v: unknown) => Number(v);
const idOf = (v: unknown) => String(v);
const orNullId = (v: unknown) => (v === null || v === undefined ? null : String(v));

export type ScheduleAllocation = ScheduleResponse["allocations"][number];
export type Row = Record<string, any>;

export const ALLOCATION_COLUMNS = `id, row_version, person_id, project_id, phase_id, project_task_id, group_id, name, notes,
  start_date, end_date, mode, hours_per_day, percent, status, billable, priority, repeat_state, repeat_end_date`;

export function toScheduleAllocation(r: Row): ScheduleAllocation {
  const base = {
    id: idOf(r.id), version: num(r.row_version), personId: idOf(r.person_id), projectId: idOf(r.project_id),
    phaseId: orNullId(r.phase_id), taskId: orNullId(r.project_task_id), groupId: orNullId(r.group_id),
    name: r.name ?? null, notes: r.notes ?? null, startDate: day(r.start_date), endDate: day(r.end_date),
    status: r.status, billable: Boolean(r.billable), priority: num(r.priority), repeatState: r.repeat_state,
    repeatEndDate: r.repeat_end_date === null ? null : day(r.repeat_end_date),
  };
  return r.mode === "hours"
    ? { ...base, mode: "hours" as const, hoursPerDay: num(r.hours_per_day), percent: null }
    : { ...base, mode: "percentage" as const, hoursPerDay: null, percent: num(r.percent) };
}

export type SchedulePerson = ScheduleResponse["people"][number];
export const PERSON_COLUMNS = `id, row_version, name, people_type, department_id, role_id, country, work_days_hours, tags, avatar_url, active`;

export function toSchedulePerson(r: Row): SchedulePerson {
  return {
    id: idOf(r.id), version: num(r.row_version), name: String(r.name), peopleType: r.people_type,
    departmentId: orNullId(r.department_id), roleId: orNullId(r.role_id),
    country: r.country === null ? null : String(r.country).trim(),
    workDaysHours: (r.work_days_hours as unknown[]).map(num), tags: r.tags as string[],
    avatarUrl: r.avatar_url ?? null, active: Boolean(r.active),
  };
}

export type ScheduleTimeoff = ScheduleResponse["timeoffs"][number];
export const TIMEOFF_COLUMNS = `id, row_version, person_id, timeoff_type_id, start_date, end_date, scope, start_half, end_half,
  hours_per_day, approval_status`;

export function toScheduleTimeoff(r: Row): ScheduleTimeoff {
  return {
    id: idOf(r.id), version: num(r.row_version), personId: idOf(r.person_id), typeId: idOf(r.timeoff_type_id),
    startDate: day(r.start_date), endDate: day(r.end_date), scope: r.scope, startHalf: r.start_half, endHalf: r.end_half,
    hoursPerDay: r.hours_per_day === null ? null : num(r.hours_per_day), approvalStatus: r.approval_status,
  };
}

export type ScheduleDepartment = ScheduleResponse["departments"][number];
export type ScheduleRole = ScheduleResponse["roles"][number];
export type ScheduleTimeoffType = ScheduleResponse["timeoffTypes"][number];
export type ScheduleHoliday = ScheduleResponse["holidays"][number];
export type ScheduleProject = ScheduleResponse["projects"][number];

export const NAMED_COLUMNS = `id, row_version, name`;
export const toScheduleDepartment = (r: Row): ScheduleDepartment => ({ id: idOf(r.id), version: num(r.row_version), name: String(r.name) });
export const toScheduleRole = (r: Row): ScheduleRole => ({ id: idOf(r.id), version: num(r.row_version), name: String(r.name) });

export const TIMEOFF_TYPE_COLUMNS = `id, row_version, name, deducted`;
export const toScheduleTimeoffType = (r: Row): ScheduleTimeoffType => ({ id: idOf(r.id), version: num(r.row_version), name: String(r.name), deducted: Boolean(r.deducted) });

export const HOLIDAY_COLUMNS = `id, row_version, name, hdate, country, department_id, hours_off`;
export const toScheduleHoliday = (r: Row): ScheduleHoliday => ({
  id: idOf(r.id), version: num(r.row_version), name: String(r.name), date: day(r.hdate), country: r.country === null ? null : String(r.country).trim(),
  departmentId: orNullId(r.department_id), hoursOff: r.hours_off === null ? null : num(r.hours_off),
});

export const PROJECT_COLUMNS = `id, row_version, name, project_code, color, status, non_billable, start_date, end_date`;
export const toScheduleProject = (r: Row): ScheduleProject => ({
  id: idOf(r.id), version: num(r.row_version), name: String(r.name), projectCode: r.project_code ?? null, color: String(r.color),
  status: r.status, nonBillable: Boolean(r.non_billable),
  startDate: r.start_date === null ? null : day(r.start_date), endDate: r.end_date === null ? null : day(r.end_date),
});

export type SchedulePhase = NonNullable<ScheduleResponse["phases"]>[number];
export const SCHEDULE_PHASE_COLUMNS = `id, row_version, project_id, name, start_date, end_date, color`;
export const toSchedulePhase = (r: Row): SchedulePhase => ({
  id: idOf(r.id), version: num(r.row_version), projectId: idOf(r.project_id), name: String(r.name),
  startDate: r.start_date === null ? null : day(r.start_date), endDate: r.end_date === null ? null : day(r.end_date),
  color: r.color === null ? null : String(r.color).trim(),
});

// Horaire daté (BR-19) : people_history vient de la migration 0002. Une base au seul schema.sql (tests de l'étage rapide)
// ne l'a pas : la réponse n'a alors pas d'horaire daté (même repli que person_work_days_hours_on). Seule la présence est
// mise en cache (une migration appliquée plus tard est vue au prochain appel).
const historyReady = new WeakSet<Db>();
async function hasPeopleHistory(db: Db, tx: Queryable): Promise<boolean> {
  if (historyReady.has(db)) return true;
  const ok = Boolean((await tx.query<Row>("SELECT to_regclass('people_history') IS NOT NULL AS ok")).rows[0]?.ok);
  if (ok) historyReady.add(db);
  return ok;
}

type WorkPeriod = NonNullable<SchedulePerson["workSchedule"]>[number];

/**
 * Historique COMPLET de l'horaire des personnes (pas seulement la fenêtre) : à version égale, une personne est la même
 * d'une fenêtre à l'autre (le client fusionne les fenêtres par version). Une personne à période unique n'en reçoit pas.
 */
export async function workSchedules(db: Db, tx: Queryable, accountId: string, personIds: string[]): Promise<Map<string, WorkPeriod[]>> {
  const out = new Map<string, WorkPeriod[]>();
  if (!personIds.length || !(await hasPeopleHistory(db, tx))) return out;
  const { rows } = await tx.query<Row>(
    `SELECT person_id, valid_from, valid_to, work_days_hours FROM people_history
      WHERE account_id = $1 AND attribute = 'work_days_hours' AND person_id = ANY ($2::bigint[])
      ORDER BY person_id, valid_from NULLS FIRST, id`,
    [accountId, personIds],
  );
  for (const r of rows) {
    const id = idOf(r.person_id);
    const list = out.get(id) ?? out.set(id, []).get(id)!;
    list.push({
      validFrom: r.valid_from === null ? null : day(r.valid_from), validTo: r.valid_to === null ? null : day(r.valid_to),
      workDaysHours: (r.work_days_hours as unknown[]).map(num),
    });
  }
  for (const [id, list] of out) if (list.length === 1 && list[0]!.validFrom === null && list[0]!.validTo === null) out.delete(id);
  return out;
}

interface PageCursor { name: string; id: string }
const encodeCursor = (c: PageCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string): PageCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof c?.name === "string" && typeof c?.id === "string" && /^\d+$/.test(c.id)) return c;
  } catch { /* tombe sur l'erreur ci-dessous */ }
  throw new ApiFailure("SCHEDULE_CURSOR_INVALID");
}

export function assertWindow(from: string, to: string): void {
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (!(span >= 0 && span <= MAX_RANGE_DAYS)) throw new ApiFailure("SCHEDULE_RANGE_INVALID", { from, to, maxDays: MAX_RANGE_DAYS });
}

/**
 * Position du journal change_log (schema.sql) pour ce compte. Lue AVANT les données : la lecture suivante est au moins aussi
 * récente que le curseur, donc rejouer les changements > curseur ne peut pas en perdre (au pire, un changement déjà vu est rejoué,
 * ce que la `version` des entités rend idempotent). Le seq est contigu et commite dans l'ordre : voir schema.sql.
 */
export async function readChangeHead(tx: Queryable, accountId: string): Promise<string> {
  const { rows } = await tx.query<Row>("SELECT seq FROM account_change_seq WHERE account_id = $1::bigint", [accountId]);
  return String(rows[0]?.seq ?? 0);
}

export async function getSchedule(db: Db, ctx: RequestContext, q: ScheduleQuery): Promise<ScheduleResponse> {
  assertWindow(q.from, q.to);
  const limit = q.limit ?? DEFAULT_LIMIT;
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;

  return withContext(db, ctx, async (tx) => {
    const a = ctx.accountId;
    const changeCursor = await readChangeHead(tx, a);

    // Filtres communs au total et à la page.
    const where: string[] = ["p.account_id = $1"];
    const args: unknown[] = [a];
    const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
    if (!q.includeInactive) where.push("p.active");
    if (q.departmentId) where.push(`p.department_id = ${bind(idParam("departmentId", q.departmentId))}::bigint`);
    if (q.roleId) where.push(`p.role_id = ${bind(idParam("roleId", q.roleId))}::bigint`);
    if (q.tag) where.push(`${bind(q.tag)} = ANY (p.tags)`);
    if (q.projectId) {
      where.push(`EXISTS (SELECT 1 FROM allocations al WHERE al.account_id = p.account_id AND al.person_id = p.id
        AND al.project_id = ${bind(idParam("projectId", q.projectId))}::bigint
        AND al.start_date <= ${bind(q.to)}::date AND COALESCE(al.repeat_end_date, al.end_date) >= ${bind(q.from)}::date)`);
    }
    const filter = where.join(" AND ");

    const total = num((await tx.query<Row>(`SELECT count(*) AS n FROM people p WHERE ${filter}`, args)).rows[0]!.n);

    const pageArgs = [...args];
    let keyset = "";
    if (cursor) {
      pageArgs.push(cursor.name, cursor.id);
      keyset = ` AND (p.name, p.id) > ($${pageArgs.length - 1}::text, $${pageArgs.length}::bigint)`;
    }
    pageArgs.push(limit + 1);
    const peopleRows = (await tx.query<Row>(
      `SELECT ${PERSON_COLUMNS}
         FROM people p WHERE ${filter}${keyset} ORDER BY p.name, p.id LIMIT $${pageArgs.length}`,
      pageArgs,
    )).rows;
    const hasMore = peopleRows.length > limit;
    const pageRows = hasMore ? peopleRows.slice(0, limit) : peopleRows;
    const last = pageRows[pageRows.length - 1];
    const personIds = pageRows.map((r) => idOf(r.id));

    const schedules = await workSchedules(db, tx, a, personIds);
    const people = pageRows.map((r) => {
      const p = toSchedulePerson(r);
      const ws = schedules.get(p.id);
      return ws ? { ...p, workSchedule: ws } : p;
    });

    const range = [a, q.from, q.to, personIds] as const;
    const allocRows = personIds.length ? (await tx.query<Row>(
      `SELECT id, row_version, person_id, project_id, phase_id, project_task_id, group_id, name, notes,
              start_date, end_date, mode, hours_per_day, percent, status, billable, priority, repeat_state, repeat_end_date
         FROM allocations
        WHERE account_id = $1 AND start_date <= $3::date AND COALESCE(repeat_end_date, end_date) >= $2::date
          AND person_id = ANY ($4::bigint[])
        ORDER BY person_id, start_date, id`,
      [...range],
    )).rows : [];

    const timeoffRows = personIds.length ? (await tx.query<Row>(
      `SELECT ${TIMEOFF_COLUMNS}
         FROM timeoffs
        WHERE account_id = $1 AND start_date <= $3::date AND end_date >= $2::date AND person_id = ANY ($4::bigint[])
        ORDER BY person_id, start_date, id`,
      [...range],
    )).rows : [];

    const projectIds = [...new Set(allocRows.map((r) => idOf(r.project_id)))];
    const projectRows = projectIds.length ? (await tx.query<Row>(
      `SELECT ${PROJECT_COLUMNS} FROM projects
        WHERE account_id = $1 AND id = ANY ($2::bigint[]) ORDER BY id`,
      [a, projectIds],
    )).rows : [];

    const phaseRows = projectIds.length ? (await tx.query<Row>(
      `SELECT ${SCHEDULE_PHASE_COLUMNS} FROM phases
        WHERE account_id = $1 AND project_id = ANY ($2::bigint[]) ORDER BY project_id, position, id`,
      [a, projectIds],
    )).rows : [];

    const [holidayRows, typeRows, deptRows, roleRows, accountRows] = await Promise.all([
      tx.query<Row>(
        `SELECT ${HOLIDAY_COLUMNS} FROM holidays
          WHERE account_id = $1 AND hdate BETWEEN $2::date AND $3::date ORDER BY hdate, id`, [a, q.from, q.to]),
      tx.query<Row>(`SELECT ${TIMEOFF_TYPE_COLUMNS} FROM timeoff_types WHERE account_id = $1 ORDER BY id`, [a]),
      tx.query<Row>(`SELECT ${NAMED_COLUMNS} FROM departments WHERE account_id = $1 ORDER BY name, id`, [a]),
      tx.query<Row>(`SELECT ${NAMED_COLUMNS} FROM roles WHERE account_id = $1 ORDER BY name, id`, [a]),
      tx.query<Row>(`SELECT week_start, capacity_thresholds, timezone FROM accounts WHERE id = $1`, [a]),
    ]);
    const account = accountRows.rows[0]!;

    const allocations = allocRows.map(toScheduleAllocation);

    return {
      window: { from: q.from, to: q.to },
      changeCursor,
      page: { nextCursor: hasMore && last ? encodeCursor({ name: String(last.name), id: idOf(last.id) }) : null, total },
      account: {
        weekStart: num(account.week_start),
        capacityThresholds: { underPercent: num((account.capacity_thresholds as { under_percent: unknown }).under_percent) },
        timezone: String(account.timezone),
      },
      people,
      allocations,
      timeoffs: timeoffRows.map(toScheduleTimeoff),
      holidays: holidayRows.rows.map(toScheduleHoliday),
      projects: projectRows.map(toScheduleProject),
      phases: phaseRows.map(toSchedulePhase),
      timeoffTypes: typeRows.rows.map(toScheduleTimeoffType),
      departments: deptRows.rows.map(toScheduleDepartment),
      roles: roleRows.rows.map(toScheduleRole),
    };
  });
}
