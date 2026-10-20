import type { Client, ClientCreate, ClientPatch, Milestone, MilestoneCreate, MilestonePatch, Phase, PhaseCreate, PhasePatch, ProjectTask, ProjectTaskCreate, ProjectTaskPatch } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { count, reader, remove } from "./reference";
import type { Row } from "./schedule";
import { assertProjectScope, assertWriter, day, idParam, invalid, isId, lockAndCheck, notFound } from "./write";

// Clients, phases, tâches et jalons de projet (contrat : packages/contracts/src/project-structure.ts). Données de projet : owner, admin et
// project_manager écrivent, tout membre lit. Même mécanique que reference.ts (verrou optimiste, suppression sans cascade silencieuse,
// RLS + account_id). Aucune unicité en base : pas de ALREADY_EXISTS. Ces tables ne sont pas dans le journal temps réel.
//  * Le projet d'une phase ou d'une tâche est fixé à la création. La phase d'une tâche doit être du MÊME projet : la clé étrangère
//    composite (phase_id, project_id) le garantit en base, la vérification explicite donne un 404 net avant d'écrire.
//  * Suppression d'une phase ou d'une tâche : les clés étrangères mettraient à NULL (allocations, temps saisis) voire supprimeraient
//    (jalons, lignes de budget) sans rien dire ; on refuse donc tant que quelque chose y renvoie (REFERENCE_IN_USE).

const POSITION_MAX = 32767;

/** 23503 (clé étrangère : la référence a disparu entre la vérification et l'écriture) -> 404 ; 23514/22003 (CHECK, hors bornes) -> 400. */
function translate(reference: string): (err: unknown) => never {
  return (err) => {
    const code = (err as { code?: string })?.code;
    if (code === "23503") throw notFound(reference);
    if (code === "23514") throw invalid("body");
    if (code === "22003") throw invalid("position");
    throw err;
  };
}

const idOf = (v: unknown) => String(v);
const orNullId = (v: unknown) => (v === null || v === undefined ? null : String(v));
const orNullDay = (v: unknown) => (v === null || v === undefined ? null : day(v));

async function assertProject(tx: Queryable, accountId: string, id: string) {
  if (!isId(id) || !(await tx.query("SELECT 1 FROM projects WHERE id = $1::bigint AND account_id = $2::bigint", [id, accountId])).rows.length) throw notFound("project");
}

/** La phase doit exister dans le compte ET appartenir au projet. */
async function assertPhaseOf(tx: Queryable, accountId: string, projectId: string, phaseId: string | null | undefined) {
  if (!phaseId) return;
  if (!isId(phaseId) || !(await tx.query("SELECT 1 FROM phases WHERE id = $1::bigint AND project_id = $2::bigint AND account_id = $3::bigint", [phaseId, projectId, accountId])).rows.length) throw notFound("phase");
}

/** Dernière position du projet + 1 (0 pour la première). */
async function nextPosition(tx: Queryable, table: "phases" | "project_tasks", accountId: string, projectId: string): Promise<number> {
  const { rows } = await tx.query<Row>(`SELECT COALESCE(MAX(position) + 1, 0) AS n FROM ${table} WHERE project_id = $1::bigint AND account_id = $2::bigint`, [projectId, accountId]);
  const n = Number(rows[0]!.n);
  if (n > POSITION_MAX) throw invalid("position");
  return n;
}

// --- Clients ----------------------------------------------------------------------------------------------------------
export const CLIENT_COLUMNS = "id, row_version, name, short_name, tags";
const toClient = (r: Row): Client => ({ id: idOf(r.id), version: Number(r.row_version), name: String(r.name), shortName: r.short_name ?? null, tags: r.tags as string[] });

export async function createClient(db: Db, ctx: RequestContext, body: ClientCreate): Promise<Client> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const { rows } = await tx.query<Row>(
      `INSERT INTO clients (account_id, name, short_name, tags) VALUES ($1::bigint, $2, $3, $4::text[]) RETURNING ${CLIENT_COLUMNS}`,
      [ctx.accountId, body.name, body.shortName ?? null, body.tags ?? []],
    );
    return toClient(rows[0]!);
  });
}

export async function updateClient(db: Db, ctx: RequestContext, id: string, expected: number, patch: ClientPatch): Promise<Client> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "clients", CLIENT_COLUMNS, "client", ctx.accountId, id, expected);
    const { rows } = await tx.query<Row>(
      `UPDATE clients SET name = $3, short_name = $4, tags = $5::text[]
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $6::int RETURNING ${CLIENT_COLUMNS}`,
      [id, ctx.accountId, patch.name ?? cur.name, patch.shortName !== undefined ? patch.shortName : cur.short_name, patch.tags ?? cur.tags, expected],
    );
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toClient(rows[0]);
  });
}

export const deleteClient = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, { table: "clients", entity: "client", columns: CLIENT_COLUMNS, writers: true, dependents: { projects: count("projects", "client_id") } }, id, expected);

export const clientReader = reader({ table: "clients", columns: CLIENT_COLUMNS, entity: "client", map: toClient });

// --- Phases -----------------------------------------------------------------------------------------------------------
export const PHASE_COLUMNS = "id, row_version, project_id, name, start_date, end_date, status, color, non_billable, notes, position";
const toPhase = (r: Row): Phase => ({
  id: idOf(r.id), version: Number(r.row_version), projectId: idOf(r.project_id), name: String(r.name), startDate: orNullDay(r.start_date), endDate: orNullDay(r.end_date),
  status: r.status, color: r.color === null ? null : String(r.color).trim(), nonBillable: Boolean(r.non_billable), notes: r.notes ?? null, position: Number(r.position),
});
const failPhase = translate("project");

export async function createPhase(db: Db, ctx: RequestContext, body: PhaseCreate): Promise<Phase> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertProject(tx, ctx.accountId, body.projectId);
    await assertProjectScope(tx, ctx, body.projectId);
    const position = body.position ?? (await nextPosition(tx, "phases", ctx.accountId, body.projectId));
    const { rows } = await tx.query<Row>(
      `INSERT INTO phases (account_id, project_id, name, start_date, end_date, status, color, non_billable, notes, position)
       VALUES ($1::bigint, $2::bigint, $3, $4::date, $5::date, $6::project_status, $7, $8::boolean, $9, $10::smallint) RETURNING ${PHASE_COLUMNS}`,
      [ctx.accountId, body.projectId, body.name, body.startDate ?? null, body.endDate ?? null, body.status ?? "planned", body.color ?? null, body.nonBillable ?? false, body.notes ?? null, position],
    ).catch(failPhase);
    return toPhase(rows[0]!);
  });
}

export async function updatePhase(db: Db, ctx: RequestContext, id: string, expected: number, patch: PhasePatch): Promise<Phase> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "phases", PHASE_COLUMNS, "phase", ctx.accountId, id, expected);
    await assertProjectScope(tx, ctx, String(cur.project_id));
    const has = <K extends keyof PhasePatch>(k: K) => patch[k] !== undefined;
    const startDate = has("startDate") ? patch.startDate! : orNullDay(cur.start_date);
    const endDate = has("endDate") ? patch.endDate! : orNullDay(cur.end_date);
    if (startDate && endDate && endDate < startDate) throw invalid("endDate"); // état résultant : le patch seul ne suffit pas à le voir
    const { rows } = await tx.query<Row>(
      `UPDATE phases SET name = $3, start_date = $4::date, end_date = $5::date, status = $6::project_status, color = $7, non_billable = $8::boolean, notes = $9, position = $10::smallint
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $11::int RETURNING ${PHASE_COLUMNS}`,
      [
        id, ctx.accountId, patch.name ?? cur.name, startDate, endDate, patch.status ?? cur.status, has("color") ? patch.color : cur.color === null ? null : String(cur.color).trim(),
        patch.nonBillable ?? cur.non_billable, has("notes") ? patch.notes : cur.notes, patch.position ?? cur.position, expected,
      ],
    ).catch(failPhase);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toPhase(rows[0]);
  });
}

export const deletePhase = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, {
    table: "phases", entity: "phase", columns: PHASE_COLUMNS, writers: true,
    dependents: { tasks: count("project_tasks", "phase_id"), allocations: count("allocations", "phase_id"), logged_time: count("logged_time", "phase_id"), milestones: count("milestones", "phase_id") },
  }, id, expected);

export const phaseReader = reader({
  table: "phases", columns: PHASE_COLUMNS, entity: "phase", map: toPhase,
  filters: (q, bind) => (q.projectId ? [`project_id = ${bind(idParam("projectId", q.projectId))}::bigint`] : []),
});

// --- Tâches de projet -------------------------------------------------------------------------------------------------
export const TASK_COLUMNS = "id, row_version, project_id, phase_id, name, billable, position";
const toTask = (r: Row): ProjectTask => ({
  id: idOf(r.id), version: Number(r.row_version), projectId: idOf(r.project_id), phaseId: orNullId(r.phase_id), name: String(r.name), billable: Boolean(r.billable), position: Number(r.position),
});
const failTask = translate("phase");

export async function createProjectTask(db: Db, ctx: RequestContext, body: ProjectTaskCreate): Promise<ProjectTask> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertProject(tx, ctx.accountId, body.projectId);
    await assertProjectScope(tx, ctx, body.projectId);
    await assertPhaseOf(tx, ctx.accountId, body.projectId, body.phaseId);
    const position = body.position ?? (await nextPosition(tx, "project_tasks", ctx.accountId, body.projectId));
    const { rows } = await tx.query<Row>(
      `INSERT INTO project_tasks (account_id, project_id, phase_id, name, billable, position)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::boolean, $6::smallint) RETURNING ${TASK_COLUMNS}`,
      [ctx.accountId, body.projectId, body.phaseId ?? null, body.name, body.billable ?? true, position],
    ).catch(failTask);
    return toTask(rows[0]!);
  });
}

export async function updateProjectTask(db: Db, ctx: RequestContext, id: string, expected: number, patch: ProjectTaskPatch): Promise<ProjectTask> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "project_tasks", TASK_COLUMNS, "project_task", ctx.accountId, id, expected);
    await assertProjectScope(tx, ctx, String(cur.project_id));
    const phaseId = patch.phaseId !== undefined ? patch.phaseId : orNullId(cur.phase_id);
    if (patch.phaseId !== undefined) await assertPhaseOf(tx, ctx.accountId, idOf(cur.project_id), phaseId);
    const { rows } = await tx.query<Row>(
      `UPDATE project_tasks SET name = $3, phase_id = $4::bigint, billable = $5::boolean, position = $6::smallint
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $7::int RETURNING ${TASK_COLUMNS}`,
      [id, ctx.accountId, patch.name ?? cur.name, phaseId, patch.billable ?? cur.billable, patch.position ?? cur.position, expected],
    ).catch(failTask);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toTask(rows[0]);
  });
}

export const deleteProjectTask = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, {
    table: "project_tasks", entity: "project_task", columns: TASK_COLUMNS, writers: true,
    dependents: { allocations: count("allocations", "project_task_id"), logged_time: count("logged_time", "project_task_id"), budget_lines: count("project_budget_lines", "project_task_id") },
  }, id, expected);

export const projectTaskReader = reader({
  table: "project_tasks", columns: TASK_COLUMNS, entity: "project_task", map: toTask,
  filters: (q, bind) => [
    ...(q.projectId ? [`project_id = ${bind(idParam("projectId", q.projectId))}::bigint`] : []),
    ...(q.phaseId ? [`phase_id = ${bind(idParam("phaseId", q.phaseId))}::bigint`] : []),
  ],
});

// --- Jalons -----------------------------------------------------------------------------------------------------------
// Un jalon porte un projet (fixé à la création) et, en option, une phase DU MÊME projet. Rien ne renvoie vers un jalon : suppression libre.
export const MILESTONE_COLUMNS = "id, row_version, project_id, phase_id, name, due_date";
const toMilestone = (r: Row): Milestone => ({
  id: idOf(r.id), version: Number(r.row_version), projectId: idOf(r.project_id), phaseId: orNullId(r.phase_id), name: String(r.name), dueDate: day(r.due_date),
});
const failMilestone = translate("phase");

export async function createMilestone(db: Db, ctx: RequestContext, body: MilestoneCreate): Promise<Milestone> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertProject(tx, ctx.accountId, body.projectId);
    await assertProjectScope(tx, ctx, body.projectId);
    await assertPhaseOf(tx, ctx.accountId, body.projectId, body.phaseId);
    const { rows } = await tx.query<Row>(
      `INSERT INTO milestones (account_id, project_id, phase_id, name, due_date) VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::date) RETURNING ${MILESTONE_COLUMNS}`,
      [ctx.accountId, body.projectId, body.phaseId ?? null, body.name, body.dueDate],
    ).catch(failMilestone);
    return toMilestone(rows[0]!);
  });
}

export async function updateMilestone(db: Db, ctx: RequestContext, id: string, expected: number, patch: MilestonePatch): Promise<Milestone> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "milestones", MILESTONE_COLUMNS, "milestone", ctx.accountId, id, expected);
    await assertProjectScope(tx, ctx, String(cur.project_id));
    const phaseId = patch.phaseId !== undefined ? patch.phaseId : orNullId(cur.phase_id);
    if (patch.phaseId !== undefined) await assertPhaseOf(tx, ctx.accountId, idOf(cur.project_id), phaseId);
    const { rows } = await tx.query<Row>(
      `UPDATE milestones SET name = $3, phase_id = $4::bigint, due_date = $5::date
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $6::int RETURNING ${MILESTONE_COLUMNS}`,
      [id, ctx.accountId, patch.name ?? cur.name, phaseId, patch.dueDate ?? day(cur.due_date), expected],
    ).catch(failMilestone);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toMilestone(rows[0]);
  });
}

export const deleteMilestone = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, { table: "milestones", entity: "milestone", columns: MILESTONE_COLUMNS, writers: true, dependents: {} }, id, expected);

export const milestoneReader = reader({
  table: "milestones", columns: MILESTONE_COLUMNS, entity: "milestone", map: toMilestone,
  filters: (q, bind) => [
    ...(q.projectId ? [`project_id = ${bind(idParam("projectId", q.projectId))}::bigint`] : []),
    ...(q.phaseId ? [`phase_id = ${bind(idParam("phaseId", q.phaseId))}::bigint`] : []),
    ...(q.dueFrom ? [`due_date >= ${bind(q.dueFrom)}::date`] : []),
    ...(q.dueTo ? [`due_date <= ${bind(q.dueTo)}::date`] : []),
  ],
});
