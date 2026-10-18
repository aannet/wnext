import { withContext, type Db, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { readChangeHead } from "./schedule";
import type { Row } from "./schedule";

// Lecture du journal de changements (schema.sql : change_log) à partir d'un curseur, pour le temps réel et la reprise.
// Le journal ne porte que des références (entité, id, version) : le client (ou la couche WebSocket) recharge l'entité.
// Le contrat WebSocket n'existe pas encore ; cette fonction en est la source, sans surface HTTP.

export interface Change {
  seq: string;
  entity: string;
  id: string;
  op: "insert" | "update" | "delete";
  /** null pour un delete */
  version: number | null;
}

export type ChangesResult =
  | { status: "ok"; changes: Change[]; head: string; hasMore: boolean }
  /** Le curseur est plus ancien que la rétention du journal : le client doit recharger le Schedule (GET /schedule). */
  | { status: "expired"; head: string };

const MAX_PAGE = 1000;

export async function readChanges(db: Db, ctx: RequestContext, after: string, limit = 500): Promise<ChangesResult> {
  if (!/^\d{1,15}$/.test(after)) throw new ApiFailure("SCHEDULE_CURSOR_INVALID");
  const n = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE);
  return withContext(db, ctx, async (tx) => {
    const head = await readChangeHead(tx, ctx.accountId);
    if (BigInt(after) > BigInt(head)) throw new ApiFailure("SCHEDULE_CURSOR_INVALID"); // curseur du futur : forgé ou autre base
    const purged = (await tx.query<Row>("SELECT purged_through FROM account_change_seq WHERE account_id = $1::bigint", [ctx.accountId])).rows[0]?.purged_through ?? 0;
    if (BigInt(after) < BigInt(purged)) return { status: "expired" as const, head };
    const { rows } = await tx.query<Row>(
      `SELECT seq, entity, entity_id, op, version FROM change_log
        WHERE account_id = $1::bigint AND seq > $2::bigint AND seq <= $3::bigint ORDER BY seq LIMIT $4`,
      [ctx.accountId, after, head, n + 1],
    );
    const page = rows.slice(0, n);
    return {
      status: "ok" as const,
      changes: page.map((r) => ({ seq: String(r.seq), entity: String(r.entity), id: String(r.entity_id), op: r.op, version: r.version === null ? null : Number(r.version) })),
      head,
      hasMore: rows.length > n,
    };
  });
}
