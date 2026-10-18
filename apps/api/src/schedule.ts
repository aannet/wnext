import { MAX_RANGE_DAYS } from "@wnext/engine";
import type { ScheduleQuery, ScheduleResponse } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";

// GET /api/v1/schedule. Pas de RLS dans schema.sql v1.1 : l'isolation entre comptes repose sur `account_id = $1`
// dans CHAQUE requête ci-dessous (testé). Ne jamais renvoyer cost_rate, email, budget (contrat : zéro fuite).

const DEFAULT_LIMIT = 200;
const DAY_MS = 86_400_000;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
const num = (v: unknown) => Number(v);
const idOf = (v: unknown) => String(v);
const orNullId = (v: unknown) => (v === null || v === undefined ? null : String(v));

type Row = Record<string, any>;

interface PageCursor { name: string; id: string }
const encodeCursor = (c: PageCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string): PageCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof c?.name === "string" && typeof c?.id === "string" && /^\d+$/.test(c.id)) return c;
  } catch { /* tombe sur l'erreur ci-dessous */ }
  throw new ApiFailure("SCHEDULE_CURSOR_INVALID");
}

function assertWindow(from: string, to: string): void {
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (!(span >= 0 && span <= MAX_RANGE_DAYS)) throw new ApiFailure("SCHEDULE_RANGE_INVALID", { from, to, maxDays: MAX_RANGE_DAYS });
}

/**
 * Curseur de changement PROVISOIRE : schema.sql v1.1 n'a pas de journal `change_log` (le contrat le suppose).
 * On compose le dernier id de delete_log et la dernière modification connue ; opaque pour le client.
 * À remplacer par la position du vrai journal quand le contrat WebSocket sera défini.
 */
async function changeCursor(tx: Queryable, accountId: string): Promise<string> {
  const { rows } = await tx.query<Row>(
    `SELECT
       COALESCE((SELECT max(id) FROM delete_log WHERE account_id = $1), 0) AS del,
       GREATEST(
         (SELECT max(modified_at) FROM allocations WHERE account_id = $1),
         (SELECT max(modified_at) FROM timeoffs    WHERE account_id = $1),
         (SELECT max(modified_at) FROM people      WHERE account_id = $1),
         (SELECT max(modified_at) FROM holidays    WHERE account_id = $1)) AS modified`,
    [accountId],
  );
  const r = rows[0]!;
  const modified = r.modified ? new Date(r.modified).getTime() : 0;
  return `c1.${r.del}.${modified}`;
}

export async function getSchedule(db: Db, ctx: RequestContext, q: ScheduleQuery): Promise<ScheduleResponse> {
  assertWindow(q.from, q.to);
  const limit = q.limit ?? DEFAULT_LIMIT;
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;

  return withContext(db, ctx, async (tx) => {
    const a = ctx.accountId;

    // Filtres communs au total et à la page.
    const where: string[] = ["p.account_id = $1"];
    const args: unknown[] = [a];
    const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
    if (!q.includeInactive) where.push("p.active");
    if (q.departmentId) where.push(`p.department_id = ${bind(q.departmentId)}::bigint`);
    if (q.roleId) where.push(`p.role_id = ${bind(q.roleId)}::bigint`);
    if (q.tag) where.push(`${bind(q.tag)} = ANY (p.tags)`);
    if (q.projectId) {
      where.push(`EXISTS (SELECT 1 FROM allocations al WHERE al.account_id = p.account_id AND al.person_id = p.id
        AND al.project_id = ${bind(q.projectId)}::bigint
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
      `SELECT p.id, p.row_version, p.name, p.people_type, p.department_id, p.role_id, p.country,
              p.work_days_hours, p.tags, p.avatar_url, p.active
         FROM people p WHERE ${filter}${keyset} ORDER BY p.name, p.id LIMIT $${pageArgs.length}`,
      pageArgs,
    )).rows;
    const hasMore = peopleRows.length > limit;
    const pageRows = hasMore ? peopleRows.slice(0, limit) : peopleRows;
    const last = pageRows[pageRows.length - 1];
    const personIds = pageRows.map((r) => idOf(r.id));

    const people = pageRows.map((r) => ({
      id: idOf(r.id),
      version: num(r.row_version),
      name: String(r.name),
      peopleType: r.people_type,
      departmentId: orNullId(r.department_id),
      roleId: orNullId(r.role_id),
      country: r.country === null ? null : String(r.country).trim(),
      workDaysHours: (r.work_days_hours as unknown[]).map(num),
      tags: r.tags as string[],
      avatarUrl: r.avatar_url ?? null,
      active: Boolean(r.active),
    }));

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
      `SELECT id, row_version, person_id, timeoff_type_id, start_date, end_date, scope, start_half, end_half,
              hours_per_day, approval_status
         FROM timeoffs
        WHERE account_id = $1 AND start_date <= $3::date AND end_date >= $2::date AND person_id = ANY ($4::bigint[])
        ORDER BY person_id, start_date, id`,
      [...range],
    )).rows : [];

    const projectIds = [...new Set(allocRows.map((r) => idOf(r.project_id)))];
    const projectRows = projectIds.length ? (await tx.query<Row>(
      `SELECT id, name, project_code, color, status, non_billable FROM projects
        WHERE account_id = $1 AND id = ANY ($2::bigint[]) ORDER BY id`,
      [a, projectIds],
    )).rows : [];

    const [holidayRows, typeRows, deptRows, roleRows, accountRows] = await Promise.all([
      tx.query<Row>(
        `SELECT id, name, hdate, country, department_id, hours_off FROM holidays
          WHERE account_id = $1 AND hdate BETWEEN $2::date AND $3::date ORDER BY hdate, id`, [a, q.from, q.to]),
      tx.query<Row>(`SELECT id, name, deducted FROM timeoff_types WHERE account_id = $1 ORDER BY id`, [a]),
      tx.query<Row>(`SELECT id, name FROM departments WHERE account_id = $1 ORDER BY name, id`, [a]),
      tx.query<Row>(`SELECT id, name FROM roles WHERE account_id = $1 ORDER BY name, id`, [a]),
      tx.query<Row>(`SELECT week_start, capacity_thresholds FROM accounts WHERE id = $1`, [a]),
    ]);
    const account = accountRows.rows[0]!;

    const allocations = allocRows.map((r) => {
      const base = {
        id: idOf(r.id), version: num(r.row_version), personId: idOf(r.person_id), projectId: idOf(r.project_id),
        phaseId: orNullId(r.phase_id), taskId: orNullId(r.project_task_id), groupId: orNullId(r.group_id),
        name: r.name ?? null, notes: r.notes ?? null, startDate: iso(r.start_date), endDate: iso(r.end_date),
        status: r.status, billable: Boolean(r.billable), priority: num(r.priority), repeatState: r.repeat_state,
        repeatEndDate: r.repeat_end_date === null ? null : iso(r.repeat_end_date),
      };
      return r.mode === "hours"
        ? { ...base, mode: "hours" as const, hoursPerDay: num(r.hours_per_day), percent: null }
        : { ...base, mode: "percentage" as const, hoursPerDay: null, percent: num(r.percent) };
    });

    return {
      window: { from: q.from, to: q.to },
      changeCursor: await changeCursor(tx, a),
      page: { nextCursor: hasMore && last ? encodeCursor({ name: String(last.name), id: idOf(last.id) }) : null, total },
      account: {
        weekStart: num(account.week_start),
        capacityThresholds: { underPercent: num((account.capacity_thresholds as { under_percent: unknown }).under_percent) },
      },
      people,
      allocations,
      timeoffs: timeoffRows.map((r) => ({
        id: idOf(r.id), version: num(r.row_version), personId: idOf(r.person_id), typeId: idOf(r.timeoff_type_id),
        startDate: iso(r.start_date), endDate: iso(r.end_date), scope: r.scope, startHalf: r.start_half, endHalf: r.end_half,
        hoursPerDay: r.hours_per_day === null ? null : num(r.hours_per_day), approvalStatus: r.approval_status,
      })),
      holidays: holidayRows.rows.map((r) => ({
        id: idOf(r.id), name: String(r.name), date: iso(r.hdate), country: r.country === null ? null : String(r.country).trim(),
        departmentId: orNullId(r.department_id), hoursOff: r.hours_off === null ? null : num(r.hours_off),
      })),
      projects: projectRows.map((r) => ({
        id: idOf(r.id), name: String(r.name), projectCode: r.project_code ?? null, color: String(r.color),
        status: r.status, nonBillable: Boolean(r.non_billable),
      })),
      timeoffTypes: typeRows.rows.map((r) => ({ id: idOf(r.id), name: String(r.name), deducted: Boolean(r.deducted) })),
      departments: deptRows.rows.map((r) => ({ id: idOf(r.id), name: String(r.name) })),
      roles: roleRows.rows.map((r) => ({ id: idOf(r.id), name: String(r.name) })),
    };
  });
}
