import type { Queryable, RequestContext } from "./db";
import { ApiFailure } from "./failure";
import type { Row } from "./schedule";

// Briques communes des écritures (allocations, congés) : rôle, identifiants, verrou optimiste.

const WRITERS = new Set<RequestContext["role"]>(["owner", "admin", "project_manager"]);
export const isWriter = (ctx: RequestContext) => WRITERS.has(ctx.role);
export const assertWriter = (ctx: RequestContext) => {
  if (!isWriter(ctx)) throw new ApiFailure("FORBIDDEN", { role: ctx.role });
};
const ADMINS = new Set<RequestContext["role"]>(["owner", "admin"]);
/** Configuration du compte (départements, rôles, types de congé, fériés) : owner et admin seulement. */
export const assertAdmin = (ctx: RequestContext) => {
  if (!ADMINS.has(ctx.role)) throw new ApiFailure("FORBIDDEN", { role: ctx.role });
};
/**
 * BR-33 : un project_manager n'écrit que sur les projets qu'il gère, c'est-à-dire ceux dont il est le chef de projet
 * (projects.project_manager_id = la personne liée à son compte, account_members.person_id) ou dont il est co-gestionnaire
 * (project_managers). owner et admin : tous les projets ; member et guest sont déjà refusés par assertWriter.
 * Appelé DANS la transaction, après la vérification d'existence (un projet inconnu reste un 404) : 403 FORBIDDEN avec
 * params.scope = "project" (code stable, distinct du refus par rôle seul). Plusieurs projets : tous doivent être gérés.
 */
export async function assertProjectScope(tx: Queryable, ctx: RequestContext, ...projectIds: Array<string | null | undefined>): Promise<void> {
  if (ctx.role !== "project_manager") return;
  const ids = [...new Set(projectIds.filter((v): v is string => typeof v === "string" && isId(v)))];
  if (!ids.length) return;
  if (!isId(ctx.userId)) throw new ApiFailure("FORBIDDEN", { role: ctx.role, scope: "project" });
  const { rows } = await tx.query<Row>(
    `SELECT count(*) AS n,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM project_managers m WHERE m.account_id = p.account_id AND m.project_id = p.id AND m.user_id = $3::bigint)
                                OR p.project_manager_id IN (SELECT person_id FROM account_members WHERE account_id = p.account_id AND user_id = $3::bigint)) AS managed
       FROM projects p WHERE p.account_id = $1::bigint AND p.id = ANY ($2::bigint[])`,
    [ctx.accountId, ids, ctx.userId],
  );
  if (Number(rows[0]!.n) !== ids.length) throw notFound("project"); // projet inconnu : 404 comme pour les autres rôles
  if (Number(rows[0]!.managed) !== ids.length) throw new ApiFailure("FORBIDDEN", { role: ctx.role, scope: "project" });
}

/** Jour calendaire courant (YYYY-MM-DD) dans le fuseau du compte (accounts.timezone), calculé par la base comme history_effective_from (0002). */
export async function accountToday(tx: Queryable, accountId: string): Promise<string> {
  const { rows } = await tx.query<Row>("SELECT (now() AT TIME ZONE COALESCE((SELECT timezone FROM accounts WHERE id = $1::bigint), 'UTC'))::date::text AS d", [accountId]);
  return String(rows[0]!.d);
}

export const invalid = (field: string) => new ApiFailure("VALIDATION_FAILED", { field });
export const notFound = (entity: string) => new ApiFailure("NOT_FOUND", { entity });

// Les identifiants sont des chaînes opaques ; un identifiant non numérique ne peut désigner aucune ligne.
export const isId = (v: string) => /^\d{1,18}$/.test(v);

/** Filtre par identifiant : une valeur non numérique est une requête invalide (400), pas une erreur de cast en base. */
export const idParam = (field: string, v: string) => { if (!isId(v)) throw invalid(field); return v; };

/**
 * Jour calendaire YYYY-MM-DD d'une colonne DATE. Via `pg` (pgTypes, pg-db.ts) c'est déjà une chaîne. La branche Date ne sert
 * qu'à PGlite, qui parse les DATE à minuit UTC : surtout pas pour un Date de `pg` par défaut (minuit local).
 */
export const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** Ligne verrouillée (FOR UPDATE) + contrôle de version dans la même transaction ; renvoie la ligne courante. `table` et `columns` sont des constantes du code. */
export async function lockAndCheck(tx: Queryable, table: "allocations" | "timeoffs" | "logged_time" | "people" | "departments" | "roles" | "timeoff_types" | "holidays" | "projects" | "clients" | "phases" | "project_tasks" | "milestones" | "project_expenses" | "project_budget_lines", columns: string, entity: string, accountId: string, id: string, expected: number): Promise<Row> {
  if (!isId(id)) throw notFound(entity);
  const { rows } = await tx.query<Row>(`SELECT ${columns} FROM ${table} WHERE id = $1::bigint AND account_id = $2::bigint FOR UPDATE`, [id, accountId]);
  const row = rows[0];
  if (!row) throw notFound(entity);
  if (Number(row.row_version) !== expected) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(row.row_version) });
  return row;
}
