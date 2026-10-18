import type { LoggedTime, LoggedTimeCreate, LoggedTimeList, LoggedTimeListQuery, LoggedTimePatch, LoggedTimePrefillResult, LoggedTimeSubmitResult, LoggedTimeWindow } from "@wnext/contracts";
import { planPrefill, type PrefillAllocation } from "@wnext/engine";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { assertWindow, type Row } from "./schedule";
import { assertAdmin, assertWriter, day, invalid, isId, lockAndCheck, notFound } from "./write";

// Temps saisis (logged_time) : pré-remplissage (BR-11), cycle de vie et verrouillage (BR-12, BR-28). Règles portées ici ; le reste
// l'est par le trigger guard_logged_time de schema.sql, qui reste le dernier rempart (immutabilité hors brouillon, 24 h, placeholder) :
//  * rôle : owner, admin, project_manager écrivent ; owner et admin déverrouillent ; la lecture est ouverte à tout membre authentifié ;
//  * seules les lignes en brouillon se modifient ou se suppriment, même pour un admin (il déverrouille d'abord, ce qui est tracé) ;
//  * la logique de pré-remplissage est pure et vit dans @wnext/engine (planPrefill) ; ici, uniquement la lecture des entrées et l'écriture ;
//  * isolation : RLS (app_user + contexte de withContext) ET account_id dans chaque requête.

export const LOGGED_TIME_COLUMNS = "id, row_version, person_id, project_id, phase_id, project_task_id, allocation_id, work_date, hours, billable, notes, status";

const idOf = (v: unknown) => String(v);
const orNullId = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function toLoggedTime(r: Row): LoggedTime {
  return {
    id: idOf(r.id), version: Number(r.row_version), personId: idOf(r.person_id), projectId: idOf(r.project_id),
    phaseId: orNullId(r.phase_id), taskId: orNullId(r.project_task_id), allocationId: orNullId(r.allocation_id),
    workDate: day(r.work_date), hours: Number(r.hours), billable: Boolean(r.billable), notes: r.notes ?? null, status: r.status,
  };
}

/** NUMERIC(4,2) : au-delà du centième la valeur serait arrondie (voire à 0, refusée par le CHECK) ; on la refuse franchement. */
const assertCents = (hours: number) => { if (Math.round(hours * 100) / 100 !== hours) throw invalid("hours"); };

const mustBeDraft = (row: Row) => { if (row.status !== "draft") throw new ApiFailure("LOGGED_TIME_LOCKED", { status: String(row.status) }); };

/** Traduit les refus du trigger en codes stables ; toute autre erreur remonte telle quelle. */
function translate(err: unknown): never {
  const code = (err as { code?: string })?.code;
  if (code === "23514") throw new ApiFailure("LOGGED_TIME_DAY_LIMIT"); // total > 24 h (BR-28) ; le placeholder et le format sont filtrés avant
  if (code === "42501") throw new ApiFailure("LOGGED_TIME_LOCKED"); // filet de sécurité : l'état est déjà contrôlé plus haut
  throw err;
}

async function requirePerson(tx: Queryable, accountId: string, personId: string): Promise<{ workDaysHours: number[]; placeholder: boolean }> {
  if (!isId(personId)) throw notFound("person");
  const { rows } = await tx.query<Row>("SELECT work_days_hours, people_type FROM people WHERE id = $1::bigint AND account_id = $2::bigint", [personId, accountId]);
  const p = rows[0];
  if (!p) throw notFound("person");
  return { workDaysHours: (p.work_days_hours as unknown[]).map(Number), placeholder: p.people_type === "placeholder" };
}

/** Un placeholder ne logue pas de temps (BR-27). */
const assertCanLog = (p: { placeholder: boolean }) => { if (p.placeholder) throw invalid("personId"); };

async function assertStructure(tx: Queryable, accountId: string, projectId: string, phaseId: string | null | undefined, taskId: string | null | undefined) {
  const exists = async (sql: string, args: unknown[], entity: string) => { if (!(await tx.query(sql, args)).rows.length) throw notFound(entity); };
  if (!isId(projectId)) throw notFound("project");
  await exists("SELECT 1 FROM projects WHERE id = $1::bigint AND account_id = $2::bigint", [projectId, accountId], "project");
  if (phaseId) {
    if (!isId(phaseId)) throw notFound("phase");
    await exists("SELECT 1 FROM phases WHERE id = $1::bigint AND project_id = $2::bigint AND account_id = $3::bigint", [phaseId, projectId, accountId], "phase");
  }
  if (taskId) {
    if (!isId(taskId)) throw notFound("task");
    await exists("SELECT 1 FROM project_tasks WHERE id = $1::bigint AND project_id = $2::bigint AND account_id = $3::bigint", [taskId, projectId, accountId], "task");
  }
}

const selectWindow = (tx: Queryable, accountId: string, personId: string, from: string, to: string, status?: string) =>
  tx.query<Row>(
    `SELECT ${LOGGED_TIME_COLUMNS} FROM logged_time
     WHERE account_id = $1::bigint AND person_id = $2::bigint AND work_date BETWEEN $3::date AND $4::date
       AND ($5::log_status IS NULL OR status = $5::log_status)
     ORDER BY work_date, id`,
    [accountId, personId, from, to, status ?? null],
  );

export async function listLoggedTime(db: Db, ctx: RequestContext, q: LoggedTimeListQuery): Promise<LoggedTimeList> {
  assertWindow(q.from, q.to);
  return withContext(db, ctx, async (tx) => {
    await requirePerson(tx, ctx.accountId, q.personId);
    const { rows } = await selectWindow(tx, ctx.accountId, q.personId, q.from, q.to, q.status);
    return { items: rows.map(toLoggedTime) };
  });
}

export async function createLoggedTime(db: Db, ctx: RequestContext, body: LoggedTimeCreate): Promise<LoggedTime> {
  assertWriter(ctx);
  assertCents(body.hours);
  return withContext(db, ctx, async (tx) => {
    assertCanLog(await requirePerson(tx, ctx.accountId, body.personId));
    await assertStructure(tx, ctx.accountId, body.projectId, body.phaseId, body.taskId);
    try {
      const { rows } = await tx.query<Row>(
        `INSERT INTO logged_time (account_id, person_id, project_id, phase_id, project_task_id, work_date, hours, billable, notes)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::date, $7::numeric, $8::boolean, $9)
         RETURNING ${LOGGED_TIME_COLUMNS}`,
        [ctx.accountId, body.personId, body.projectId, body.phaseId ?? null, body.taskId ?? null, body.workDate, body.hours, body.billable ?? true, body.notes ?? null],
      );
      return toLoggedTime(rows[0]!);
    } catch (err) { return translate(err); }
  });
}

export async function updateLoggedTime(db: Db, ctx: RequestContext, id: string, expected: number, patch: LoggedTimePatch): Promise<LoggedTime> {
  assertWriter(ctx);
  if (patch.hours !== undefined) assertCents(patch.hours);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "logged_time", LOGGED_TIME_COLUMNS, "loggedTime", ctx.accountId, id, expected);
    mustBeDraft(cur);
    const phaseId = patch.phaseId === undefined ? orNullId(cur.phase_id) : patch.phaseId;
    const taskId = patch.taskId === undefined ? orNullId(cur.project_task_id) : patch.taskId;
    await assertStructure(tx, ctx.accountId, idOf(cur.project_id), phaseId, taskId);
    try {
      const { rows } = await tx.query<Row>(
        `UPDATE logged_time SET hours = $3::numeric, billable = $4::boolean, notes = $5, phase_id = $6::bigint, project_task_id = $7::bigint
         WHERE id = $1::bigint AND account_id = $2::bigint RETURNING ${LOGGED_TIME_COLUMNS}`,
        [id, ctx.accountId, patch.hours ?? cur.hours, patch.billable ?? cur.billable, patch.notes === undefined ? cur.notes : patch.notes, phaseId, taskId],
      );
      return toLoggedTime(rows[0]!);
    } catch (err) { return translate(err); }
  });
}

export async function deleteLoggedTime(db: Db, ctx: RequestContext, id: string, expected: number): Promise<void> {
  assertWriter(ctx);
  await withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "logged_time", LOGGED_TIME_COLUMNS, "loggedTime", ctx.accountId, id, expected);
    mustBeDraft(cur);
    try {
      await tx.query("DELETE FROM logged_time WHERE id = $1::bigint AND account_id = $2::bigint", [id, ctx.accountId]);
    } catch (err) { translate(err); }
  });
}

/** BR-11 : matérialise le miroir des allocations confirmées de la fenêtre (le calcul est dans @wnext/engine). */
export async function prefillLoggedTime(db: Db, ctx: RequestContext, body: LoggedTimeWindow): Promise<LoggedTimePrefillResult> {
  assertWriter(ctx);
  assertWindow(body.from, body.to);
  return withContext(db, ctx, async (tx) => {
    const person = await requirePerson(tx, ctx.accountId, body.personId);
    assertCanLog(person);
    const { rows: allocs } = await tx.query<Row>(
      `SELECT a.id, a.project_id, a.phase_id, a.project_task_id, a.start_date, a.end_date, a.mode, a.hours_per_day, a.percent, a.status, a.billable,
              a.repeat_state, a.repeat_end_date, pr.status AS project_status, pr.non_billable AS project_non_billable,
              COALESCE(ph.non_billable, FALSE) AS phase_non_billable, t.billable AS task_billable
       FROM allocations a
       JOIN projects pr ON pr.id = a.project_id AND pr.account_id = a.account_id
       LEFT JOIN phases ph ON ph.id = a.phase_id
       LEFT JOIN project_tasks t ON t.id = a.project_task_id
       WHERE a.account_id = $1::bigint AND a.person_id = $2::bigint AND a.status = 'confirmed'
         AND a.start_date <= $4::date AND COALESCE(a.repeat_end_date, a.end_date) >= $3::date`,
      [ctx.accountId, body.personId, body.from, body.to],
    );
    const { rows: existing } = await selectWindow(tx, ctx.accountId, body.personId, body.from, body.to);
    const allocations: PrefillAllocation[] = allocs.map((a) => ({
      id: idOf(a.id), personId: body.personId, projectId: idOf(a.project_id), phaseId: orNullId(a.phase_id), taskId: orNullId(a.project_task_id),
      startDate: day(a.start_date), endDate: day(a.end_date), mode: a.mode, hoursPerDay: a.hours_per_day === null ? null : Number(a.hours_per_day),
      percent: a.percent === null ? null : Number(a.percent), status: a.status, billable: Boolean(a.billable), repeatState: a.repeat_state,
      repeatEndDate: a.repeat_end_date === null ? null : day(a.repeat_end_date),
      projectTentative: a.project_status === "tentative", projectNonBillable: Boolean(a.project_non_billable), phaseNonBillable: Boolean(a.phase_non_billable),
      taskBillable: a.task_billable === null ? null : Boolean(a.task_billable),
    }));
    const plan = planPrefill({
      workDaysHours: person.workDaysHours, allocations, from: body.from, to: body.to,
      existing: existing.map((r) => ({ allocationId: orNullId(r.allocation_id), workDate: day(r.work_date), hours: Number(r.hours) })),
    });
    let createdCount = 0;
    for (const row of plan) {
      try {
        const { rows } = await tx.query<Row>(
          // ON CONFLICT : deux pré-remplissages simultanés ne créent pas deux fois la même ligne (uq_log_prefill)
          `INSERT INTO logged_time (account_id, person_id, project_id, phase_id, project_task_id, allocation_id, work_date, hours, billable)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::bigint, $7::date, $8::numeric, $9::boolean)
           ON CONFLICT (allocation_id, work_date) WHERE allocation_id IS NOT NULL DO NOTHING RETURNING id`,
          [ctx.accountId, body.personId, row.projectId, row.phaseId, row.taskId, row.allocationId, row.workDate, row.hours, row.billable],
        );
        createdCount += rows.length;
      } catch (err) { translate(err); }
    }
    const { rows } = await selectWindow(tx, ctx.accountId, body.personId, body.from, body.to);
    return { items: rows.map(toLoggedTime), createdCount };
  });
}

/** BR-12 : soumission atomique de tous les brouillons de la personne dans la fenêtre ; elle les verrouille (trigger). */
export async function submitLoggedTime(db: Db, ctx: RequestContext, body: LoggedTimeWindow): Promise<LoggedTimeSubmitResult> {
  assertWriter(ctx);
  assertWindow(body.from, body.to);
  return withContext(db, ctx, async (tx) => {
    await requirePerson(tx, ctx.accountId, body.personId);
    const { rows: submitted } = await tx.query<Row>(
      `UPDATE logged_time SET status = 'submitted'
       WHERE account_id = $1::bigint AND person_id = $2::bigint AND work_date BETWEEN $3::date AND $4::date AND status = 'draft'
       RETURNING id`,
      [ctx.accountId, body.personId, body.from, body.to],
    );
    const { rows } = await selectWindow(tx, ctx.accountId, body.personId, body.from, body.to);
    return { items: rows.map(toLoggedTime), submittedCount: submitted.length };
  });
}

/** BR-12 : seuls owner et admin déverrouillent ; le trigger renseigne unlocked_by / unlocked_at. Une ligne déjà en brouillon est rendue telle quelle. */
export async function unlockLoggedTime(db: Db, ctx: RequestContext, id: string, expected: number): Promise<LoggedTime> {
  assertAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "logged_time", LOGGED_TIME_COLUMNS, "loggedTime", ctx.accountId, id, expected);
    if (cur.status === "draft") return toLoggedTime(cur);
    const { rows } = await tx.query<Row>(
      `UPDATE logged_time SET status = 'draft' WHERE id = $1::bigint AND account_id = $2::bigint RETURNING ${LOGGED_TIME_COLUMNS}`,
      [id, ctx.accountId],
    );
    return toLoggedTime(rows[0]!);
  });
}
