import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { readChangeHead } from "./schedule";
import type { Row } from "./schedule";
import { PERSON_SCOPED_ENTITIES, readablePeople } from "./scope";

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

// change_log.person_ids vient de la migration 0006. Une base au seul schema.sql (tests de l'étage rapide) ne l'a pas : un member n'y
// reçoit alors aucun changement par personne (refus par défaut). Seule la présence est mise en cache, comme people_history (schedule.ts).
const personLogReady = new WeakSet<Db>();
async function hasPersonLog(db: Db, tx: Queryable): Promise<boolean> {
  if (personLogReady.has(db)) return true;
  const ok = Boolean((await tx.query<Row>(
    "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'change_log'::regclass AND attname = 'person_ids' AND NOT attisdropped) AS ok",
  )).rows[0]?.ok);
  if (ok) personLogReady.add(db);
  return ok;
}

export async function readChanges(db: Db, ctx: RequestContext, after: string, limit = 500): Promise<ChangesResult> {
  if (!/^\d{1,15}$/.test(after)) throw new ApiFailure("SCHEDULE_CURSOR_INVALID");
  const n = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE);
  return withContext(db, ctx, async (tx) => {
    const head = await readChangeHead(tx, ctx.accountId);
    if (BigInt(after) > BigInt(head)) throw new ApiFailure("SCHEDULE_CURSOR_INVALID"); // curseur du futur : forgé ou autre base
    const purged = (await tx.query<Row>("SELECT purged_through FROM account_change_seq WHERE account_id = $1::bigint", [ctx.accountId])).rows[0]?.purged_through ?? 0;
    if (BigInt(after) < BigInt(purged)) return { status: "expired" as const, head };
    // RT-048 : filtre par abonné, même règle que le REST (scope.ts). Le LIMIT porte sur les lignes visibles : une page n'est jamais vide
    // tant qu'il en reste, et `head` (pas le dernier seq envoyé) dit jusqu'où le journal a été lu.
    const args: unknown[] = [ctx.accountId, after, head, n + 1];
    let scope = "";
    const readable = await readablePeople(tx, ctx);
    if (readable !== null) {
      args.push([...PERSON_SCOPED_ENTITIES]);
      scope = ` AND (entity <> ALL ($5::text[])${(await hasPersonLog(db, tx)) ? ` OR person_ids && $${args.push(readable)}::bigint[]` : ""})`;
    }
    const { rows } = await tx.query<Row>(
      `SELECT seq, entity, entity_id, op, version FROM change_log
        WHERE account_id = $1::bigint AND seq > $2::bigint AND seq <= $3::bigint${scope} ORDER BY seq LIMIT $4`,
      args,
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
