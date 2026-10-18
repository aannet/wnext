import type { AllocationCreate, AllocationPatch } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { assertWriter, day, invalid, isId, lockAndCheck as lockRow, notFound } from "./write";
import { ALLOCATION_COLUMNS, toScheduleAllocation, type Row, type ScheduleAllocation } from "./schedule";

// Écriture des allocations. Règles portées ici (le reste l'est par schema.sql : CHECK, FK composites, triggers) :
//  * rôle : owner, admin, project_manager ; sinon FORBIDDEN, avant tout accès aux données ;
//  * verrou optimiste : la ligne est verrouillée (FOR UPDATE) puis sa version comparée à If-Match dans la MÊME transaction,
//    donc deux écritures concurrentes sur la même version ne peuvent pas réussir toutes les deux ;
//  * BR-01 / BR-04 : aucune vérification de capacité ni de congé, jamais de refus pour sur-allocation ;
//  * isolation : RLS (app_user + contexte de withContext) ET account_id dans chaque requête.

/** Les références doivent exister DANS le compte ; phase et tâche dans le projet final. */
async function assertReferences(tx: Queryable, accountId: string, ref: { personId?: string; projectId: string; phaseId?: string | null; taskId?: string | null }) {
  const exists = async (sql: string, args: unknown[], entity: string) => {
    if (!(await tx.query(sql, args)).rows.length) throw notFound(entity);
  };
  if (ref.personId) await exists("SELECT 1 FROM people WHERE id = $1::bigint AND account_id = $2::bigint", [ref.personId, accountId], "person");
  await exists("SELECT 1 FROM projects WHERE id = $1::bigint AND account_id = $2::bigint", [ref.projectId, accountId], "project");
  if (ref.phaseId) await exists("SELECT 1 FROM phases WHERE id = $1::bigint AND project_id = $2::bigint AND account_id = $3::bigint", [ref.phaseId, ref.projectId, accountId], "phase");
  if (ref.taskId) await exists("SELECT 1 FROM project_tasks WHERE id = $1::bigint AND project_id = $2::bigint AND account_id = $3::bigint", [ref.taskId, ref.projectId, accountId], "task");
}

export async function createAllocation(db: Db, ctx: RequestContext, body: AllocationCreate): Promise<ScheduleAllocation> {
  assertWriter(ctx);
  for (const [field, v] of [["personId", body.personId], ["projectId", body.projectId]] as const) if (!isId(v)) throw notFound(field === "personId" ? "person" : "project");
  if (body.phaseId && !isId(body.phaseId)) throw notFound("phase");
  if (body.taskId && !isId(body.taskId)) throw notFound("task");
  return withContext(db, ctx, async (tx) => {
    await assertReferences(tx, ctx.accountId, body);
    const load = body.load;
    const { rows } = await tx.query<Row>(
      `INSERT INTO allocations (account_id, person_id, project_id, phase_id, project_task_id, name, notes, start_date, end_date,
                                mode, hours_per_day, percent, status, billable, priority, repeat_state, repeat_end_date)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6, $7, $8::date, $9::date,
               $10::allocation_mode, $11::numeric, $12::numeric, $13::allocation_status, $14::boolean, $15::smallint, $16::repeat_state_t, $17::date)
       RETURNING ${ALLOCATION_COLUMNS}`,
      [
        ctx.accountId, body.personId, body.projectId, body.phaseId ?? null, body.taskId ?? null, body.name ?? null, body.notes ?? null,
        body.startDate, body.endDate, load.mode, load.mode === "hours" ? load.hoursPerDay : null, load.mode === "percentage" ? load.percent : null,
        body.status ?? "confirmed", body.billable ?? true, body.priority ?? 0, body.repeatState ?? "none", body.repeatEndDate ?? null,
      ],
    );
    return toScheduleAllocation(rows[0]!);
  });
}

export async function updateAllocation(db: Db, ctx: RequestContext, id: string, expectedVersion: number, patch: AllocationPatch): Promise<ScheduleAllocation> {
  assertWriter(ctx);
  for (const [v, entity] of [[patch.personId, "person"], [patch.projectId, "project"], [patch.phaseId, "phase"], [patch.taskId, "task"]] as const) {
    if (v && !isId(v)) throw notFound(entity);
  }
  return withContext(db, ctx, async (tx) => {
    const cur = await lockRow(tx, "allocations", ALLOCATION_COLUMNS, "allocation", ctx.accountId, id, expectedVersion);
    const has = <K extends keyof AllocationPatch>(k: K) => k in patch && patch[k] !== undefined;

    const projectId = has("projectId") ? patch.projectId! : String(cur.project_id);
    const projectChanged = projectId !== String(cur.project_id);
    // Phase et tâche appartiennent à un projet : changer de projet sans les préciser les remet à zéro.
    const phaseId = has("phaseId") ? patch.phaseId! : projectChanged ? null : cur.phase_id === null ? null : String(cur.phase_id);
    const taskId = has("taskId") ? patch.taskId! : projectChanged ? null : cur.project_task_id === null ? null : String(cur.project_task_id);
    const personId = has("personId") ? patch.personId! : String(cur.person_id);

    const startDate = patch.startDate ?? day(cur.start_date);
    const endDate = patch.endDate ?? day(cur.end_date);
    const repeatState = patch.repeatState ?? cur.repeat_state;
    // Une série qui devient « none » perd sa fin sans que le client ait à la nommer.
    const repeatEnd: string | null =
      repeatState === "none" ? (has("repeatEndDate") && patch.repeatEndDate !== null ? "invalid" : null)
      : has("repeatEndDate") ? patch.repeatEndDate ?? null
      : cur.repeat_end_date === null ? null : day(cur.repeat_end_date);
    if (endDate < startDate) throw invalid("endDate");
    if (repeatState === "none" ? repeatEnd !== null : repeatEnd === null || repeatEnd < endDate) throw invalid("repeatEndDate");

    await assertReferences(tx, ctx.accountId, { personId: has("personId") ? personId : undefined, projectId, phaseId, taskId });

    const mode = patch.load?.mode ?? cur.mode;
    const hours = patch.load ? (patch.load.mode === "hours" ? patch.load.hoursPerDay : null) : cur.hours_per_day === null ? null : Number(cur.hours_per_day);
    const percent = patch.load ? (patch.load.mode === "percentage" ? patch.load.percent : null) : cur.percent === null ? null : Number(cur.percent);

    const { rows } = await tx.query<Row>(
      `UPDATE allocations SET person_id = $3::bigint, project_id = $4::bigint, phase_id = $5::bigint, project_task_id = $6::bigint,
              name = $7, notes = $8, start_date = $9::date, end_date = $10::date, mode = $11::allocation_mode,
              hours_per_day = $12::numeric, percent = $13::numeric, status = $14::allocation_status, billable = $15::boolean,
              priority = $16::smallint, repeat_state = $17::repeat_state_t, repeat_end_date = $18::date
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $19::int
        RETURNING ${ALLOCATION_COLUMNS}`,
      [
        id, ctx.accountId, personId, projectId, phaseId, taskId,
        has("name") ? patch.name ?? null : cur.name, has("notes") ? patch.notes ?? null : cur.notes,
        startDate, endDate, mode, hours, percent,
        patch.status ?? cur.status, patch.billable ?? cur.billable, patch.priority ?? cur.priority, repeatState, repeatEnd, expectedVersion,
      ],
    );
    // Ceinture et bretelles : le verrou de ligne suffit, mais la condition de version garde l'écriture correcte même sans lui.
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toScheduleAllocation(rows[0]!);
  });
}

export async function deleteAllocation(db: Db, ctx: RequestContext, id: string, expectedVersion: number): Promise<void> {
  assertWriter(ctx);
  await withContext(db, ctx, async (tx) => {
    await lockRow(tx, "allocations", ALLOCATION_COLUMNS, "allocation", ctx.accountId, id, expectedVersion);
    const { rows } = await tx.query("DELETE FROM allocations WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $3::int RETURNING id", [id, ctx.accountId, expectedVersion]);
    if (!rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expectedVersion + 1 });
  });
}
