import type { Me } from "@wnext/contracts";
import { withContext, type Db, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import type { Row } from "./schedule";

// GET /api/v1/me (contrat : packages/contracts/src/me.ts). Une seule lecture, sous RLS (app_user) : l'appartenance de l'appelant au compte
// demandé (account_members, politique own_memberships), son utilisateur (visible_users), sa personne liée et le compte (tenant_isolation).
// Le rôle renvoyé est celui de la base ; pas d'appartenance (retirée depuis l'authentification) : 401, comme un jeton qui ne mène à rien.

export async function getMe(db: Db, ctx: RequestContext): Promise<Me> {
  return withContext(db, ctx, async (tx) => {
    const r = (await tx.query<Row>(
      `SELECT m.role::text AS role, u.id::text AS user_id, u.email::text AS email, NULLIF(btrim(u.name), '') AS user_name,
              p.id::text AS person_id, p.name AS person_name,
              a.id::text AS account_id, a.name AS account_name, a.timezone, a.week_start, a.default_locale
         FROM account_members m
         JOIN users u ON u.id = m.user_id
         JOIN accounts a ON a.id = m.account_id
         LEFT JOIN people p ON p.id = m.person_id AND p.account_id = m.account_id
        WHERE m.account_id = $1::bigint AND m.user_id = $2::bigint`,
      [ctx.accountId, ctx.userId],
    )).rows[0];
    if (!r) throw new ApiFailure("UNAUTHENTICATED", {});
    const email = String(r.email);
    return {
      user: { id: String(r.user_id), name: r.user_name ? String(r.user_name) : email.split("@")[0] || email, email },
      role: String(r.role) as Me["role"],
      person: r.person_id ? { id: String(r.person_id), name: String(r.person_name) } : null,
      account: { id: String(r.account_id), name: String(r.account_name), timezone: String(r.timezone), weekStart: Number(r.week_start), defaultLocale: String(r.default_locale) },
    };
  });
}
