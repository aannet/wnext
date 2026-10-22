import type { AccountPatch, AccountSettings } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import type { Row } from "./schedule";
import { assertAdmin, invalid } from "./write";

// Réglages du compte (RT-041 ; contrat : packages/contracts/src/account.ts). Lecture : tout membre ; écriture : owner et admin.
// La ligne `accounts` n'a pas d'account_id (c'est le tenant lui-même) : lockAndCheck ne s'applique pas, le verrou optimiste est
// refait ici (FOR UPDATE + comparaison, puis `AND row_version = n` à l'écriture ; trg_90_touch incrémente row_version).
// La RLS (tenant_isolation : id = app.account_id) borne déjà au compte de la requête ; `id = $1` le dit aussi.
// Le seuil est écrit par jsonb_set : les autres clés éventuelles de capacity_thresholds sont gardées.
// Pas de change_log sur accounts : aucune diffusion temps réel, le client relit /me et /schedule.

const COLUMNS = `id::text AS id, row_version, name, timezone, week_start, default_locale, capacity_thresholds -> 'under_percent' AS under_percent`;

const toSettings = (r: Row): AccountSettings => ({
  id: String(r.id), version: Number(r.row_version), name: String(r.name), timezone: String(r.timezone), weekStart: Number(r.week_start),
  defaultLocale: String(r.default_locale), capacityThresholds: { underPercent: Number(r.under_percent) },
});

async function read(tx: Queryable, accountId: string, lock: boolean): Promise<Row> {
  const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1::bigint${lock ? " FOR UPDATE" : ""}`, [accountId]);
  if (!rows[0]) throw new ApiFailure("UNAUTHENTICATED", {}); // compte invisible sous RLS : le jeton ne mène à rien (comme GET /me)
  return rows[0];
}

export async function getAccount(db: Db, ctx: RequestContext): Promise<AccountSettings> {
  return withContext(db, ctx, async (tx) => toSettings(await read(tx, ctx.accountId, false)));
}

export async function updateAccount(db: Db, ctx: RequestContext, expected: number, patch: AccountPatch): Promise<AccountSettings> {
  assertAdmin(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await read(tx, ctx.accountId, true);
    if (Number(cur.row_version) !== expected) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) });
    if (patch.timezone !== undefined) {
      const { rows } = await tx.query<Row>("SELECT 1 FROM pg_timezone_names WHERE name = $1", [patch.timezone]);
      if (!rows.length) throw invalid("timezone");
    }
    const { rows } = await tx.query<Row>(
      `UPDATE accounts SET timezone = $3, week_start = $4::smallint, default_locale = $5,
              capacity_thresholds = CASE WHEN $6::numeric IS NULL THEN capacity_thresholds ELSE jsonb_set(capacity_thresholds, '{under_percent}', to_jsonb($6::numeric)) END
        WHERE id = $1::bigint AND row_version = $2::int RETURNING ${COLUMNS}`,
      [
        ctx.accountId, expected, patch.timezone ?? cur.timezone, patch.weekStart ?? cur.week_start, patch.defaultLocale ?? cur.default_locale,
        patch.capacityThresholds?.underPercent ?? null,
      ],
    );
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expected + 1 });
    return toSettings(rows[0]);
  });
}
