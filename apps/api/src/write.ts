import type { Queryable, RequestContext } from "./db";
import { ApiFailure } from "./failure";
import type { Row } from "./schedule";

// Briques communes des écritures (allocations, congés) : rôle, identifiants, verrou optimiste.

const WRITERS = new Set<RequestContext["role"]>(["owner", "admin", "project_manager"]);
export const assertWriter = (ctx: RequestContext) => {
  if (!WRITERS.has(ctx.role)) throw new ApiFailure("FORBIDDEN", { role: ctx.role });
};
const ADMINS = new Set<RequestContext["role"]>(["owner", "admin"]);
/** Configuration du compte (départements, rôles, types de congé, fériés) : owner et admin seulement. */
export const assertAdmin = (ctx: RequestContext) => {
  if (!ADMINS.has(ctx.role)) throw new ApiFailure("FORBIDDEN", { role: ctx.role });
};
export const invalid = (field: string) => new ApiFailure("VALIDATION_FAILED", { field });
export const notFound = (entity: string) => new ApiFailure("NOT_FOUND", { entity });

// Les identifiants sont des chaînes opaques ; un identifiant non numérique ne peut désigner aucune ligne.
export const isId = (v: string) => /^\d{1,18}$/.test(v);

export const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** Ligne verrouillée (FOR UPDATE) + contrôle de version dans la même transaction ; renvoie la ligne courante. `table` et `columns` sont des constantes du code. */
export async function lockAndCheck(tx: Queryable, table: "allocations" | "timeoffs" | "people" | "departments" | "roles" | "timeoff_types" | "holidays" | "projects", columns: string, entity: string, accountId: string, id: string, expected: number): Promise<Row> {
  if (!isId(id)) throw notFound(entity);
  const { rows } = await tx.query<Row>(`SELECT ${columns} FROM ${table} WHERE id = $1::bigint AND account_id = $2::bigint FOR UPDATE`, [id, accountId]);
  const row = rows[0];
  if (!row) throw notFound(entity);
  if (Number(row.row_version) !== expected) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(row.row_version) });
  return row;
}
