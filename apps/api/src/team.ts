import { planTeamRemoval, summarizeTeamRemoval, type TeamAllocation, type TeamLog, type TeamRemovalSummary as EngineSummary } from "@wnext/engine";
import type { TeamMemberList, TeamMembership, TeamRemovalRequest, TeamRemovalResult, TeamRemovalSummary } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { DEFAULT_PAGE, MAX_PAGE, decodeCursor, encodeCursor } from "./reference";
import type { Row } from "./schedule";
import { assertWriter, day, isId, notFound } from "./write";

// Retrait d'une personne d'un projet (BR-10). La décision (récapitulatif, garde de confirmation, refus si temps verrouillés)
// vient du moteur (planTeamRemoval, parité testée avec team_removal_summary() de schema.sql) ; ce module charge l'état,
// exécute les suppressions listées par le plan, et traduit les refus en codes stables.
//  * Atomicité : tout dans une transaction. La ligne de la personne est verrouillée (FOR UPDATE) : l'insertion concurrente d'une
//    allocation ou d'un temps pour elle (clé étrangère = verrou KEY SHARE sur cette ligne) attend la fin du retrait, donc rien
//    n'apparaît entre la vérification de la confirmation et la suppression. Les suppressions visent EXACTEMENT les identifiants du plan.
//  * Les suppressions sont journalisées par les triggers de la base (delete_log, BR-14 ; change_log pour les allocations).
//  * La base autorise un admin à supprimer un temps verrouillé (BR-12) ; ici le retrait est refusé quand même (BR-31).

async function assertExist(tx: Queryable, accountId: string, projectId: string, personId: string, lock: boolean) {
  if (!isId(projectId)) throw notFound("project");
  if (!isId(personId)) throw notFound("person");
  if (!(await tx.query("SELECT 1 FROM projects WHERE id = $1::bigint AND account_id = $2::bigint", [projectId, accountId])).rows.length) throw notFound("project");
  const person = `SELECT 1 FROM people WHERE id = $1::bigint AND account_id = $2::bigint${lock ? " FOR UPDATE" : ""}`;
  if (!(await tx.query(person, [personId, accountId])).rows.length) throw notFound("person");
}

async function load(tx: Queryable, accountId: string, projectId: string, personId: string) {
  const allocations: TeamAllocation[] = (await tx.query<Row>(
    `SELECT id, start_date, end_date, repeat_end_date FROM allocations
      WHERE account_id = $1::bigint AND project_id = $2::bigint AND person_id = $3::bigint ORDER BY id`,
    [accountId, projectId, personId],
  )).rows.map((r) => ({ id: String(r.id), projectId, personId, startDate: day(r.start_date), endDate: day(r.end_date), repeatEndDate: r.repeat_end_date === null ? null : day(r.repeat_end_date) }));
  const logged: TeamLog[] = (await tx.query<Row>(
    `SELECT id, hours, status FROM logged_time
      WHERE account_id = $1::bigint AND project_id = $2::bigint AND person_id = $3::bigint ORDER BY id`,
    [accountId, projectId, personId],
  )).rows.map((r) => ({ id: String(r.id), projectId, personId, hours: Number(r.hours), status: r.status }));
  const inTeam = (await tx.query("SELECT 1 FROM project_team WHERE account_id = $1::bigint AND project_id = $2::bigint AND person_id = $3::bigint", [accountId, projectId, personId])).rows.length > 0;
  return { allocations, logged, inTeam };
}

const toContract = (s: EngineSummary, inTeam: boolean): TeamRemovalSummary => ({ inTeam, ...s });

/** Les params d'erreur sont des scalaires : les dates absentes sont omises. */
const summaryParams = (s: EngineSummary, inTeam: boolean) => {
  const { firstAllocation, lastAllocation, ...rest } = s;
  return { inTeam, ...rest, ...(firstAllocation && { firstAllocation }), ...(lastAllocation && { lastAllocation }) };
};

export async function getTeamRemovalSummary(db: Db, ctx: RequestContext, projectId: string, personId: string): Promise<TeamRemovalSummary> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertExist(tx, ctx.accountId, projectId, personId, false);
    const { allocations, logged, inTeam } = await load(tx, ctx.accountId, projectId, personId);
    return toContract(summarizeTeamRemoval({ projectId, personId, allocations, logged }), inTeam);
  });
}

export async function removeFromTeam(db: Db, ctx: RequestContext, projectId: string, personId: string, request: TeamRemovalRequest): Promise<TeamRemovalResult> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertExist(tx, ctx.accountId, projectId, personId, true);
    const { allocations, logged, inTeam } = await load(tx, ctx.accountId, projectId, personId);
    const plan = planTeamRemoval({ projectId, personId, allocations, logged, confirmation: request.confirmation });
    if (!plan.ok) {
      const code = { LOCKED_LOGS: "TEAM_REMOVAL_LOCKED_LOGS", CONFIRMATION_REQUIRED: "TEAM_REMOVAL_CONFIRMATION_REQUIRED", STALE_CONFIRMATION: "TEAM_REMOVAL_STALE_CONFIRMATION" } as const;
      throw new ApiFailure(code[plan.reason], summaryParams(plan.summary, inTeam));
    }
    // Temps d'abord : allocation_id des temps pointe vers les allocations (SET NULL), autant ne rien laisser derrière.
    if (plan.deleteLogIds.length) await tx.query("DELETE FROM logged_time WHERE account_id = $1::bigint AND id = ANY ($2::bigint[])", [ctx.accountId, plan.deleteLogIds]);
    if (plan.deleteAllocationIds.length) await tx.query("DELETE FROM allocations WHERE account_id = $1::bigint AND id = ANY ($2::bigint[])", [ctx.accountId, plan.deleteAllocationIds]);
    await tx.query("DELETE FROM project_team WHERE account_id = $1::bigint AND project_id = $2::bigint AND person_id = $3::bigint", [ctx.accountId, projectId, personId]);
    return { removedAllocations: plan.deleteAllocationIds.length, removedLogs: plan.deleteLogIds.length, removedLogHours: plan.summary.logHours, wasInTeam: inTeam };
  });
}

/** Ajout à l'équipe (PUT idempotent). N'écrit que project_team ; la personne est verrouillée comme pour le retrait, donc un retrait concurrent est sérialisé. */
export async function addToTeam(db: Db, ctx: RequestContext, projectId: string, personId: string): Promise<TeamMembership> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertExist(tx, ctx.accountId, projectId, personId, true);
    const r = await tx.query(
      `INSERT INTO project_team (project_id, person_id, account_id) VALUES ($1::bigint, $2::bigint, $3::bigint) ON CONFLICT DO NOTHING RETURNING 1`,
      [projectId, personId, ctx.accountId],
    );
    return { added: r.rows.length > 0 };
  });
}

/** Équipe d'un projet, page par curseur sur l'identifiant de la personne. Lecture ouverte à tout membre ; la RLS et `account_id` isolent les comptes. */
export async function listTeam(db: Db, ctx: RequestContext, projectId: string, q: { limit?: number; cursor?: string }): Promise<TeamMemberList> {
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor); // avant d'ouvrir une transaction
  const n = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  if (!isId(projectId)) throw notFound("project");
  return withContext(db, ctx, async (tx) => {
    if (!(await tx.query("SELECT 1 FROM projects WHERE id = $1::bigint AND account_id = $2::bigint", [projectId, ctx.accountId])).rows.length) throw notFound("project");
    const total = Number((await tx.query<Row>("SELECT count(*) AS n FROM project_team WHERE account_id = $1::bigint AND project_id = $2::bigint", [ctx.accountId, projectId])).rows[0]!.n);
    const { rows } = await tx.query<Row>(
      `SELECT t.person_id, p.name FROM project_team t
         JOIN people p ON p.id = t.person_id AND p.account_id = t.account_id
        WHERE t.account_id = $1::bigint AND t.project_id = $2::bigint AND ($3::bigint IS NULL OR t.person_id > $3::bigint)
        ORDER BY t.person_id LIMIT $4::int`,
      [ctx.accountId, projectId, after ?? null, n + 1],
    );
    const page = rows.slice(0, n);
    return {
      items: page.map((r) => ({ personId: String(r.person_id), name: String(r.name) })),
      page: { nextCursor: rows.length > n ? encodeCursor(String(page[n - 1]!.person_id)) : null, total },
    };
  });
}
