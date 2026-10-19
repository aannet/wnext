import { randomUUID } from "node:crypto";
import type { AllocationCreate, AllocationGroup, AllocationGroupCreate, AllocationGroupPatch, AllocationPatch, AllocationSplit, AllocationSplitResult, OccurrencePatch, PersonAllocationListQuery, ProjectAllocationListQuery } from "@wnext/contracts";
import { expandOccurrences, seriesEnd, splitSeries, type RepeatInput, type SeriesSplit } from "@wnext/engine";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { assertWriter, day, idParam, invalid, isId, lockAndCheck as lockRow, notFound } from "./write";
import { DEFAULT_PAGE, MAX_PAGE, decodeCursor, encodeCursor, reader } from "./reference";
import { ALLOCATION_COLUMNS, assertWindow, toScheduleAllocation, type Row, type ScheduleAllocation } from "./schedule";

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
  assertPatchIds(patch);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockRow(tx, "allocations", ALLOCATION_COLUMNS, "allocation", ctx.accountId, id, expectedVersion);
    return applyPatch(tx, ctx, cur, patch);
  });
}

function assertPatchIds(patch: AllocationPatch) {
  for (const [v, entity] of [[patch.personId, "person"], [patch.projectId, "project"], [patch.phaseId, "phase"], [patch.taskId, "task"]] as const) {
    if (v && !isId(v)) throw notFound(entity);
  }
}

/** Applique `patch` à la ligne verrouillée `cur` (valeurs absentes = valeurs actuelles de CETTE ligne) et réécrit la ligne. */
async function applyPatch(tx: Queryable, ctx: RequestContext, cur: Row, patch: AllocationPatch): Promise<ScheduleAllocation> {
  const values = await resolvePatch(tx, ctx, cur, patch);
  const { rows } = await tx.query<Row>(
    `UPDATE allocations SET person_id = $3::bigint, project_id = $4::bigint, phase_id = $5::bigint, project_task_id = $6::bigint,
            name = $7, notes = $8, start_date = $9::date, end_date = $10::date, mode = $11::allocation_mode,
            hours_per_day = $12::numeric, percent = $13::numeric, status = $14::allocation_status, billable = $15::boolean,
            priority = $16::smallint, repeat_state = $17::repeat_state_t, repeat_end_date = $18::date
      WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $19::int
      RETURNING ${ALLOCATION_COLUMNS}`,
    [String(cur.id), ctx.accountId, ...values, Number(cur.row_version)],
  );
  // Ceinture et bretelles : le verrou de ligne suffit, mais la condition de version garde l'écriture correcte même sans lui.
  if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
  return toScheduleAllocation(rows[0]!);
}

/** Insère une ligne nouvelle (version 1) avec les valeurs de `cur` modifiées par `patch` ; garde le `group_id` de `cur`. */
async function insertPatched(tx: Queryable, ctx: RequestContext, cur: Row, patch: AllocationPatch | OccurrencePatch): Promise<ScheduleAllocation> {
  const values = await resolvePatch(tx, ctx, cur, patch);
  const { rows } = await tx.query<Row>(
    `INSERT INTO allocations (account_id, group_id, person_id, project_id, phase_id, project_task_id, name, notes, start_date, end_date,
                              mode, hours_per_day, percent, status, billable, priority, repeat_state, repeat_end_date)
     VALUES ($1::bigint, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::bigint, $7, $8, $9::date, $10::date,
             $11::allocation_mode, $12::numeric, $13::numeric, $14::allocation_status, $15::boolean, $16::smallint, $17::repeat_state_t, $18::date)
     RETURNING ${ALLOCATION_COLUMNS}`,
    [ctx.accountId, cur.group_id ?? null, ...values],
  );
  return toScheduleAllocation(rows[0]!);
}

/**
 * Valeurs finales d'une ligne (`cur` + `patch`), contrôlées (dates, répétition, références du compte), dans l'ordre des colonnes :
 * person, project, phase, task, name, notes, start, end, mode, hours, percent, status, billable, priority, repeat_state, repeat_end.
 */
async function resolvePatch(tx: Queryable, ctx: RequestContext, cur: Row, input: AllocationPatch | OccurrencePatch): Promise<unknown[]> {
  {
    const patch: AllocationPatch = input; // OccurrencePatch : mêmes champs, sans la répétition
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

    return [
      personId, projectId, phaseId, taskId,
      has("name") ? patch.name ?? null : cur.name, has("notes") ? patch.notes ?? null : cur.notes,
      startDate, endDate, mode, hours, percent,
      patch.status ?? cur.status, patch.billable ?? cur.billable, patch.priority ?? cur.priority, repeatState, repeatEnd,
    ];
  }
}

export async function deleteAllocation(db: Db, ctx: RequestContext, id: string, expectedVersion: number): Promise<void> {
  assertWriter(ctx);
  await withContext(db, ctx, async (tx) => {
    await lockRow(tx, "allocations", ALLOCATION_COLUMNS, "allocation", ctx.accountId, id, expectedVersion);
    const { rows } = await tx.query("DELETE FROM allocations WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $3::int RETURNING id", [id, ctx.accountId, expectedVersion]);
    if (!rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expectedVersion + 1 });
  });
}

// --- « Cette occurrence » (BR-25, décision 10 du registre) -------------------------------------------------------------
// Pas de table d'exceptions : la série est découpée par splitSeries de @wnext/engine (aucune règle de découpe dupliquée ici).
// « Avant » réécrit la ligne d'origine (ou la supprime pour l'occurrence 0) ; l'occurrence et « après » sont insérées.

/** Les refus du moteur portent leur code en préfixe du message ; on les traduit en codes stables du contrat. */
function splitFailure(e: unknown, occurrenceDate: string): unknown {
  const code = e instanceof Error ? e.message.split(":")[0] : "";
  if (code === "NOT_A_SERIES") return new ApiFailure("NOT_A_SERIES");
  if (code === "OCCURRENCE_NOT_FOUND") return new ApiFailure("OCCURRENCE_NOT_FOUND", { occurrenceDate });
  if (code === "SERIES_OVERLAPPING") return new ApiFailure("SERIES_SPLIT_UNSUPPORTED", { reason: "overlapping" });
  if (code === "SERIES_MONTHLY_CLAMPED") return new ApiFailure("SERIES_SPLIT_UNSUPPORTED", { reason: "monthly_clamped" });
  return e;
}

export async function splitAllocation(db: Db, ctx: RequestContext, id: string, expectedVersion: number, body: AllocationSplit): Promise<AllocationSplitResult> {
  assertWriter(ctx);
  if (body.patch) assertPatchIds(body.patch);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockRow(tx, "allocations", ALLOCATION_COLUMNS, "allocation", ctx.accountId, id, expectedVersion);
    const series: RepeatInput = {
      startDate: day(cur.start_date), endDate: day(cur.end_date), repeatState: cur.repeat_state,
      repeatEndDate: cur.repeat_end_date === null ? null : day(cur.repeat_end_date),
    };
    const d = body.occurrenceDate;
    let parts: SeriesSplit<RepeatInput>;
    try {
      if (series.repeatState === "none") throw new Error("NOT_A_SERIES");
      // Date -> rang : l'occurrence qui COMMENCE ce jour-là (fenêtre d'un jour, hors série = aucune).
      const hit = d >= series.startDate && d <= seriesEnd(series) ? expandOccurrences(series, d, d).find((o) => o.startDate === d) : undefined;
      if (!hit) throw new Error("OCCURRENCE_NOT_FOUND");
      parts = splitSeries(series, hit.index);
    } catch (e) {
      throw splitFailure(e, d);
    }

    const out: AllocationSplitResult = {};
    if (parts.before) {
      const { rows } = await tx.query<Row>(
        `UPDATE allocations SET repeat_end_date = $3::date WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $4::int RETURNING ${ALLOCATION_COLUMNS}`,
        [id, ctx.accountId, parts.before.repeatEndDate, expectedVersion],
      );
      if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expectedVersion + 1 }); // filet : la ligne est verrouillée
      out.before = toScheduleAllocation(rows[0]);
    } else {
      const { rows } = await tx.query("DELETE FROM allocations WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $3::int RETURNING id", [id, ctx.accountId, expectedVersion]);
      if (!rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expectedVersion + 1 });
    }
    const piece = (p: RepeatInput): Row => ({ ...cur, start_date: p.startDate, end_date: p.endDate, repeat_state: p.repeatState, repeat_end_date: p.repeatEndDate });
    if (!body.delete) out.occurrence = await insertPatched(tx, ctx, piece(parts.occurrence), body.patch ?? {});
    if (parts.after) out.after = await insertPatched(tx, ctx, piece(parts.after), {});
    return out;
  });
}

// --- Groupes (BR-26) --------------------------------------------------------------------------------------------------
// Une allocation multi-personnes = N lignes (une par personne) liées par `group_id`. Création en une transaction (tout ou rien).
// Édition « tous » : toutes les lignes du groupe sont verrouillées dans l'ordre des id (pas d'interblocage entre deux éditions du
// même groupe), la version n'est comparée que sur la ligne désignée, et chaque ligne applique le patch à SA valeur actuelle.

export async function createAllocationGroup(db: Db, ctx: RequestContext, body: AllocationGroupCreate): Promise<AllocationGroup> {
  assertWriter(ctx);
  for (const m of body.members) if (!isId(m.personId)) throw notFound("person");
  if (!isId(body.projectId)) throw notFound("project");
  if (body.phaseId && !isId(body.phaseId)) throw notFound("phase");
  if (body.taskId && !isId(body.taskId)) throw notFound("task");
  const groupId = randomUUID();
  return withContext(db, ctx, async (tx) => {
    await assertReferences(tx, ctx.accountId, body);
    const items: ScheduleAllocation[] = [];
    for (const m of body.members) {
      await assertReferences(tx, ctx.accountId, { personId: m.personId, projectId: body.projectId }); // première personne inconnue, dans l'ordre du corps
      const load = (m.load ?? body.load)!; // le contrat garantit une charge pour chaque membre
      const { rows } = await tx.query<Row>(
        `INSERT INTO allocations (account_id, person_id, project_id, phase_id, project_task_id, group_id, name, notes, start_date, end_date,
                                  mode, hours_per_day, percent, status, billable, priority, repeat_state, repeat_end_date)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::uuid, $7, $8, $9::date, $10::date,
                 $11::allocation_mode, $12::numeric, $13::numeric, $14::allocation_status, $15::boolean, $16::smallint, $17::repeat_state_t, $18::date)
         RETURNING ${ALLOCATION_COLUMNS}`,
        [
          ctx.accountId, m.personId, body.projectId, body.phaseId ?? null, body.taskId ?? null, groupId, body.name ?? null, body.notes ?? null,
          body.startDate, body.endDate, load.mode, load.mode === "hours" ? load.hoursPerDay : null, load.mode === "percentage" ? load.percent : null,
          body.status ?? "confirmed", body.billable ?? true, body.priority ?? 0, body.repeatState ?? "none", body.repeatEndDate ?? null,
        ],
      );
      items.push(toScheduleAllocation(rows[0]!));
    }
    return { groupId, items };
  });
}

/** Verrouille toutes les lignes du groupe de l'allocation `id` (ordre des id) et contrôle la version de la ligne désignée seule. */
async function lockGroup(tx: Queryable, ctx: RequestContext, id: string, expectedVersion: number): Promise<{ groupId: string; rows: Row[] }> {
  if (!isId(id)) throw notFound("allocation");
  const head = (await tx.query<Row>("SELECT group_id FROM allocations WHERE id = $1::bigint AND account_id = $2::bigint", [id, ctx.accountId])).rows[0];
  if (!head) throw notFound("allocation");
  if (head.group_id === null || head.group_id === undefined) throw notFound("allocation_group");
  const groupId = String(head.group_id);
  const { rows } = await tx.query<Row>(
    `SELECT ${ALLOCATION_COLUMNS} FROM allocations WHERE group_id = $1::uuid AND account_id = $2::bigint ORDER BY id FOR UPDATE`,
    [groupId, ctx.accountId],
  );
  const target = rows.find((r) => String(r.id) === id);
  if (!target) throw notFound("allocation"); // supprimée entre la lecture et le verrou
  if (Number(target.row_version) !== expectedVersion) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(target.row_version) });
  return { groupId, rows };
}

export async function updateAllocationGroup(db: Db, ctx: RequestContext, id: string, expectedVersion: number, patch: AllocationGroupPatch): Promise<AllocationGroup> {
  assertWriter(ctx);
  assertPatchIds(patch);
  return withContext(db, ctx, async (tx) => {
    const { groupId, rows } = await lockGroup(tx, ctx, id, expectedVersion);
    const items: ScheduleAllocation[] = [];
    for (const cur of rows) items.push(await applyPatch(tx, ctx, cur, patch));
    return { groupId, items };
  });
}

export async function deleteAllocationGroup(db: Db, ctx: RequestContext, id: string, expectedVersion: number): Promise<void> {
  assertWriter(ctx);
  await withContext(db, ctx, async (tx) => {
    const { groupId, rows } = await lockGroup(tx, ctx, id, expectedVersion);
    const del = await tx.query("DELETE FROM allocations WHERE group_id = $1::uuid AND account_id = $2::bigint RETURNING id", [groupId, ctx.accountId]);
    if (del.rows.length !== rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expectedVersion + 1 }); // filet : les lignes sont verrouillées
  });
}

// --- Lecture ----------------------------------------------------------------------------------------------------------
// Tout membre authentifié lit (mêmes champs que GET /schedule). La RLS et `account_id` isolent les comptes.

/** Lecture d'une allocation par id (avec sa version). Pas de liste globale : une liste se lit par fenêtre. */
export const allocationReader = reader({ table: "allocations", columns: ALLOCATION_COLUMNS, entity: "allocation", map: toScheduleAllocation });

type AllocationPage = { items: ScheduleAllocation[]; page: { nextCursor: string | null; total: number } };
type WindowQuery = { from: string; to: string; status?: string; limit?: number; cursor?: string };

/**
 * Allocations d'un parent (projet ou personne) qui chevauchent [from, to] (même règle que le Schedule : une série compte jusqu'à
 * `repeat_end_date`, renvoyée une fois, non développée). Page par curseur sur `id`. `other` = filtre sur l'autre côté.
 */
async function listWindow(db: Db, ctx: RequestContext, parent: { table: "projects" | "people"; column: "project_id" | "person_id"; entity: string; id: string }, other: { column: "project_id" | "person_id"; name: string; value?: string }, q: WindowQuery): Promise<AllocationPage> {
  assertWindow(q.from, q.to);
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor); // avant d'ouvrir une transaction
  const n = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  if (!isId(parent.id)) throw notFound(parent.entity);
  const otherId = other.value === undefined ? undefined : idParam(other.name, other.value);
  return withContext(db, ctx, async (tx) => {
    if (!(await tx.query(`SELECT 1 FROM ${parent.table} WHERE id = $1::bigint AND account_id = $2::bigint`, [parent.id, ctx.accountId])).rows.length) throw notFound(parent.entity);
    const args: unknown[] = [ctx.accountId, parent.id];
    const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
    const where = [
      "account_id = $1::bigint", `${parent.column} = $2::bigint`,
      `start_date <= ${bind(q.to)}::date`, `COALESCE(repeat_end_date, end_date) >= ${bind(q.from)}::date`,
      ...(otherId ? [`${other.column} = ${bind(otherId)}::bigint`] : []),
      ...(q.status ? [`status = ${bind(q.status)}::allocation_status`] : []),
    ];
    const total = Number((await tx.query<Row>(`SELECT count(*) AS n FROM allocations WHERE ${where.join(" AND ")}`, [...args])).rows[0]!.n);
    if (after !== undefined) where.push(`id > ${bind(after)}::bigint`);
    const { rows } = await tx.query<Row>(`SELECT ${ALLOCATION_COLUMNS} FROM allocations WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${bind(n + 1)}::int`, args);
    const page = rows.slice(0, n);
    return { items: page.map(toScheduleAllocation), page: { nextCursor: rows.length > n ? encodeCursor(String(page[n - 1]!.id)) : null, total } };
  });
}

/** Allocations d'un projet sur une fenêtre ; filtres `personId` et `status`. */
export function listProjectAllocations(db: Db, ctx: RequestContext, projectId: string, q: ProjectAllocationListQuery): Promise<AllocationPage> {
  return listWindow(db, ctx, { table: "projects", column: "project_id", entity: "project", id: projectId }, { column: "person_id", name: "personId", value: q.personId }, q);
}

/** Allocations d'une personne (désactivée comprise) sur une fenêtre ; filtres `projectId` et `status`. */
export function listPersonAllocations(db: Db, ctx: RequestContext, personId: string, q: PersonAllocationListQuery): Promise<AllocationPage> {
  return listWindow(db, ctx, { table: "people", column: "person_id", entity: "person", id: personId }, { column: "project_id", name: "projectId", value: q.projectId }, q);
}
