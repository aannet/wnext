import type { SavedView, SavedViewCreate, SavedViewPatch } from "@wnext/contracts";
import { withContext, type Db, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { DEFAULT_PAGE, MAX_PAGE, decodeCursor, encodeCursor } from "./reference";
import type { Row } from "./schedule";
import { assertWriter, isId, notFound } from "./write";

// Vues sauvegardées (FR-10). Règles (contrat : packages/contracts/src/saved-views.ts) :
//  * visibles : les vues de l'appelant et les vues partagées du compte ; la vue privée d'un autre est NOT_FOUND ;
//  * création : privée pour tout membre, partagée pour owner/admin/project_manager ;
//  * modification et suppression : le propriétaire, ou owner/admin pour une vue PARTAGÉE d'un autre (qui ne peut alors pas changer `shared`) ;
//  * nom pris (propriétaire, genre, nom) : ALREADY_EXISTS ; verrou optimiste If-Match.
// L'autorisation vit ici ; la RLS (migration 0003) refuse en plus, en base, la lecture d'une vue privée d'autrui.

const COLUMNS = "id, row_version, kind, name, filters, shared, position, owner_user_id";
const VISIBLE = "(owner_user_id = $2::bigint OR shared)";
const ADMIN_ROLES = new Set<RequestContext["role"]>(["owner", "admin"]);

const canManage = (ctx: RequestContext, r: Row) => String(r.owner_user_id) === ctx.userId || (Boolean(r.shared) && ADMIN_ROLES.has(ctx.role));

function toView(ctx: RequestContext, r: Row): SavedView {
  return {
    id: String(r.id), version: Number(r.row_version), kind: r.kind as SavedView["kind"], name: String(r.name), filters: r.filters as SavedView["filters"],
    shared: Boolean(r.shared), position: Number(r.position), ownerId: String(r.owner_user_id), canManage: canManage(ctx, r),
  };
}

function translate(err: unknown): never {
  if ((err as { code?: string })?.code === "23505") throw new ApiFailure("ALREADY_EXISTS", { entity: "saved_view", field: "name" });
  // Clé étrangère vers account_members : l'utilisateur n'est pas membre de ce compte.
  if ((err as { code?: string })?.code === "23503") throw new ApiFailure("FORBIDDEN", {});
  throw err;
}

export async function listSavedViews(db: Db, ctx: RequestContext, q: { limit?: number; cursor?: string; kind?: string }) {
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  const n = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  return withContext(db, ctx, async (tx) => {
    const args: unknown[] = [ctx.accountId, ctx.userId];
    const bind = (v: unknown) => { args.push(v); return `$${args.length}`; };
    const where = ["account_id = $1::bigint", VISIBLE, ...(q.kind ? [`kind = ${bind(q.kind)}`] : [])];
    const total = Number((await tx.query<Row>(`SELECT count(*) AS n FROM saved_views WHERE ${where.join(" AND ")}`, [...args])).rows[0]!.n);
    if (after !== undefined) where.push(`id > ${bind(after)}::bigint`);
    const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM saved_views WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${bind(n + 1)}::int`, args);
    const page = rows.slice(0, n);
    return { items: page.map((r) => toView(ctx, r)), page: { nextCursor: rows.length > n ? encodeCursor(String(page[n - 1]!.id)) : null, total } };
  });
}

export async function getSavedView(db: Db, ctx: RequestContext, id: string): Promise<SavedView> {
  if (!isId(id)) throw notFound("saved_view");
  return withContext(db, ctx, async (tx) => {
    const r = (await tx.query<Row>(`SELECT ${COLUMNS} FROM saved_views WHERE id = $3::bigint AND account_id = $1::bigint AND ${VISIBLE}`, [ctx.accountId, ctx.userId, id])).rows[0];
    if (!r) throw notFound("saved_view");
    return toView(ctx, r);
  });
}

export async function createSavedView(db: Db, ctx: RequestContext, body: SavedViewCreate): Promise<SavedView> {
  if (body.shared) assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const { rows } = await tx.query<Row>(
      `INSERT INTO saved_views (account_id, owner_user_id, kind, name, filters, shared, position)
       VALUES ($1::bigint, $2::bigint, $3, $4, $5::jsonb, $6::boolean, $7::smallint) RETURNING ${COLUMNS}`,
      [ctx.accountId, ctx.userId, body.kind ?? "schedule", body.name, JSON.stringify(body.filters ?? {}), body.shared ?? false, body.position ?? 0],
    ).catch(translate);
    return toView(ctx, rows[0]!);
  });
}

/** Ligne verrouillée : visible (sinon 404), gérable (sinon 403), à la bonne version (sinon 409). */
async function lockManaged(tx: Parameters<Parameters<typeof withContext>[2]>[0], ctx: RequestContext, id: string, expected: number): Promise<Row> {
  if (!isId(id)) throw notFound("saved_view");
  const r = (await tx.query<Row>(`SELECT ${COLUMNS} FROM saved_views WHERE id = $3::bigint AND account_id = $1::bigint AND ${VISIBLE} FOR UPDATE`, [ctx.accountId, ctx.userId, id])).rows[0];
  if (!r) throw notFound("saved_view");
  if (!canManage(ctx, r)) throw new ApiFailure("FORBIDDEN", { role: ctx.role });
  if (Number(r.row_version) !== expected) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(r.row_version) });
  return r;
}

export async function updateSavedView(db: Db, ctx: RequestContext, id: string, expected: number, patch: SavedViewPatch): Promise<SavedView> {
  return withContext(db, ctx, async (tx) => {
    const cur = await lockManaged(tx, ctx, id, expected);
    const shared = patch.shared ?? Boolean(cur.shared);
    if (shared !== Boolean(cur.shared)) {
      if (String(cur.owner_user_id) !== ctx.userId) throw new ApiFailure("FORBIDDEN", { role: ctx.role }); // seul le propriétaire (re)privatise ou partage
      if (shared) assertWriter(ctx);
    }
    const { rows } = await tx.query<Row>(
      `UPDATE saved_views SET name = $3, filters = $4::jsonb, shared = $5::boolean, position = $6::smallint
        WHERE id = $2::bigint AND account_id = $1::bigint AND row_version = $7::int RETURNING ${COLUMNS}`,
      [ctx.accountId, id, patch.name ?? cur.name, JSON.stringify(patch.filters ?? cur.filters), shared, patch.position ?? cur.position, expected],
    ).catch(translate);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expected + 1 });
    return toView(ctx, rows[0]);
  });
}

export async function deleteSavedView(db: Db, ctx: RequestContext, id: string, expected: number): Promise<void> {
  await withContext(db, ctx, async (tx) => {
    await lockManaged(tx, ctx, id, expected);
    const r = await tx.query(`DELETE FROM saved_views WHERE id = $2::bigint AND account_id = $1::bigint AND row_version = $3::int RETURNING id`, [ctx.accountId, id, expected]);
    if (!r.rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expected + 1 });
  });
}

