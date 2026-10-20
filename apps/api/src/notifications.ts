import { NotificationType, type Notification, type NotificationEntity, type NotificationPreferencesUpdate } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { DEFAULT_PAGE, MAX_PAGE, decodeCursor, encodeCursor } from "./reference";
import type { Row } from "./schedule";
import { isId, notFound } from "./write";

// Notifications in-app (FR-10, US-7.3, BR-36 ; contrat : packages/contracts/src/notifications.ts ; base : migrations/0004_notifications.sql).
//  * Destinataire seul : chaque requête filtre account_id ET user_id de l'appelant, et la RLS RESTRICTIVE de 0004 refuse de toute façon
//    les lignes d'autrui. Une notification d'un autre est NOT_FOUND.
//  * Émission : allocations et congés par trigger (0004) ; le conflit d'édition ici (recordConflict), après le 409, dans sa propre
//    transaction (celle de l'écriture refusée est annulée).

const COLUMNS = `n.id, n.type, n.entity, n.entity_id, n.actor_user_id, u.name AS actor_name, n.payload,
  to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(n.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read_at`;
const FROM = "notifications n LEFT JOIN users u ON u.id = n.actor_user_id"; // users : RLS « soi-même + membres du compte » (nom d'un ancien membre : null)
const MINE = "n.account_id = $1::bigint AND n.user_id = $2::bigint";

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

function toNotification(r: Row): Notification {
  const p = (r.payload ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id), type: r.type, entity: r.entity as NotificationEntity, entityId: String(r.entity_id),
    actor: r.actor_user_id === null ? null : { id: String(r.actor_user_id), name: r.actor_name ?? null },
    counts: { created: int(p.created), updated: int(p.updated), deleted: int(p.deleted), approved: int(p.approved), declined: int(p.declined) },
    startDate: typeof p.startDate === "string" ? p.startDate : null,
    currentVersion: typeof p.version === "number" && p.version >= 1 ? p.version : null,
    createdAt: String(r.created_at), readAt: r.read_at ?? null,
  };
}

export async function readUnreadCount(tx: Queryable, ctx: RequestContext): Promise<number> {
  const { rows } = await tx.query<Row>("SELECT count(*) AS n FROM notifications n WHERE " + MINE + " AND n.read_at IS NULL", [ctx.accountId, ctx.userId]);
  return Number(rows[0]!.n);
}

export async function listNotifications(db: Db, ctx: RequestContext, q: { limit?: number; cursor?: string; unread?: boolean }) {
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  const n = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  return withContext(db, ctx, async (tx) => {
    const args: unknown[] = [ctx.accountId, ctx.userId];
    const where = [MINE, ...(q.unread ? ["n.read_at IS NULL"] : [])];
    const total = Number((await tx.query<Row>(`SELECT count(*) AS n FROM notifications n WHERE ${where.join(" AND ")}`, args)).rows[0]!.n);
    if (after !== undefined) { args.push(after); where.push(`n.id < $${args.length}::bigint`); }
    args.push(n + 1);
    const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(" AND ")} ORDER BY n.id DESC LIMIT $${args.length}::int`, args);
    const page = rows.slice(0, n);
    return {
      items: page.map(toNotification),
      page: { nextCursor: rows.length > n ? encodeCursor(String(page[n - 1]!.id)) : null, total },
      unreadCount: await readUnreadCount(tx, ctx),
    };
  });
}

export async function markNotificationRead(db: Db, ctx: RequestContext, id: string): Promise<Notification> {
  if (!isId(id)) throw notFound("notification");
  return withContext(db, ctx, async (tx) => {
    await tx.query(`UPDATE notifications n SET read_at = clock_timestamp() WHERE ${MINE} AND n.id = $3::bigint AND n.read_at IS NULL`, [ctx.accountId, ctx.userId, id]);
    const r = (await tx.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${MINE} AND n.id = $3::bigint`, [ctx.accountId, ctx.userId, id])).rows[0];
    if (!r) throw notFound("notification");
    return toNotification(r);
  });
}

export async function markAllNotificationsRead(db: Db, ctx: RequestContext) {
  return withContext(db, ctx, async (tx) => {
    const { rows } = await tx.query<Row>(`UPDATE notifications n SET read_at = clock_timestamp() WHERE ${MINE} AND n.read_at IS NULL RETURNING n.id`, [ctx.accountId, ctx.userId]);
    return { marked: rows.length, unreadCount: await readUnreadCount(tx, ctx) };
  });
}

async function readPreferences(tx: Queryable, ctx: RequestContext) {
  const { rows } = await tx.query<Row>("SELECT type, enabled FROM notification_preferences WHERE account_id = $1::bigint AND user_id = $2::bigint", [ctx.accountId, ctx.userId]);
  const set = new Map(rows.map((r) => [String(r.type), Boolean(r.enabled)]));
  return { items: NotificationType.options.map((type) => ({ type, enabled: set.get(type) ?? true })) };
}

export async function getNotificationPreferences(db: Db, ctx: RequestContext) {
  return withContext(db, ctx, (tx) => readPreferences(tx, ctx));
}

export async function updateNotificationPreferences(db: Db, ctx: RequestContext, body: NotificationPreferencesUpdate) {
  return withContext(db, ctx, async (tx) => {
    for (const p of body.items) {
      await tx.query(
        `INSERT INTO notification_preferences (account_id, user_id, type, enabled) VALUES ($1::bigint, $2::bigint, $3, $4::boolean)
         ON CONFLICT (account_id, user_id, type) DO UPDATE SET enabled = EXCLUDED.enabled, modified_at = now()`,
        [ctx.accountId, ctx.userId, p.type, p.enabled],
      ).catch((err: unknown) => {
        if ((err as { code?: string })?.code === "23503") throw new ApiFailure("FORBIDDEN", {}); // appelant non membre du compte
        throw err;
      });
    }
    return readPreferences(tx, ctx);
  });
}

/**
 * BR-36 / US-3.5 : l'appelant vient de perdre (409 VERSION_CONFLICT) sur `entity`/`id`. Notifie l'appelant avec l'auteur et la version
 * de la ligne gagnante, sauf désabonnement. Transaction séparée : celle de l'écriture refusée est annulée. Rien si l'entité n'existe plus.
 * `entity` est une constante du code (table d'une ressource), jamais une entrée de la requête.
 */
export async function recordConflict(db: Db, ctx: RequestContext, entity: NotificationEntity, id: string): Promise<void> {
  if (!isId(id)) return;
  await withContext(db, ctx, (tx) => tx.query(
    `INSERT INTO notifications (account_id, user_id, type, entity, entity_id, actor_user_id, payload)
     SELECT $1::bigint, $2::bigint, 'edit_conflict', $3, e.id, e.modified_by, jsonb_build_object('version', e.row_version)
       FROM ${entity} e
      WHERE e.id = $4::bigint AND e.account_id = $1::bigint
        AND NOT EXISTS (SELECT 1 FROM notification_preferences p
                         WHERE p.account_id = $1::bigint AND p.user_id = $2::bigint AND p.type = 'edit_conflict' AND NOT p.enabled)`,
    [ctx.accountId, ctx.userId, entity, id],
  ));
}
