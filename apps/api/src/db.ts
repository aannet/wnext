// Surface minimale de la base dont dépend l'API : PGlite (tests) et un pool `pg` (production) la satisfont.
// Le contexte de session (SET LOCAL) est posé au début de CHAQUE transaction (schema.sql, en-tête).
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface RequestContext {
  accountId: string;
  userId: string;
  role: "owner" | "admin" | "project_manager" | "member" | "guest";
}

/** Erreurs que Postgres résout en annulant une transaction, sans effet de bord : interblocage (40P01) et échec de sérialisation (40001). */
const RETRYABLE = new Set(["40P01", "40001"]);
const MAX_ATTEMPTS = 3;

// Toute l'opération vit dans la transaction (aucun effet hors base) : si Postgres l'annule pour interblocage, la rejouer est sûr
// et elle voit alors l'état validé par l'autre (ex. deux congés qui se chevauchent : le perdant reçoit TIMEOFF_OVERLAP, pas un 500).
export async function withContext<T>(db: Db, ctx: RequestContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)",
          [ctx.accountId, ctx.userId, ctx.role],
        );
        return fn(tx);
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.has((err as { code?: string })?.code ?? "")) throw err;
    }
  }
}
