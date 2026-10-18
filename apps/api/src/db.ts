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

export async function withContext<T>(db: Db, ctx: RequestContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)",
      [ctx.accountId, ctx.userId, ctx.role],
    );
    return fn(tx);
  });
}
