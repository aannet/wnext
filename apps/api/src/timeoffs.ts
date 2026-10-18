import type { TimeoffCreate, TimeoffPatch } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { TIMEOFF_COLUMNS, toScheduleTimeoff, type Row, type ScheduleTimeoff } from "./schedule";
import { assertWriter, day, invalid, isId, lockAndCheck, notFound } from "./write";

// Écriture des congés. Mêmes principes que les allocations (rôles, verrou optimiste, isolation RLS + account_id) ; en plus :
//  * BR-04 : aucun contrôle des allocations existantes, rien n'est supprimé ni déplacé ; le client déduit l'avertissement ;
//  * le chevauchement à la demi-journée près est refusé par la contrainte d'exclusion de schema.sql (ex_timeoff_no_overlap) ;
//    il devient TIMEOFF_OVERLAP, pas VERSION_CONFLICT : recharger ne le résout pas ;
//  * l'état RÉSULTANT d'un PATCH (courant + champs fournis) doit rester cohérent : mêmes règles que les CHECK de la table.

type Half = "am" | "pm";
interface Fields {
  startDate: string; endDate: string; scope: "full_day" | "partial"; startHalf: Half; endHalf: Half; hoursPerDay: number | null;
}

/** Miroir des CHECK de la table (chk_timeoff_hours, chk_timeoff_halves, end_date >= start_date). Renvoie le champ fautif ou null. */
function incoherent(f: Fields): string | null {
  if (f.endDate < f.startDate) return "endDate";
  if (f.scope === "partial" ? f.hoursPerDay === null : f.hoursPerDay !== null) return "hoursPerDay";
  if (f.scope === "partial" && (f.startHalf !== "am" || f.endHalf !== "pm")) return "scope";
  if (f.endDate === f.startDate && f.startHalf > f.endHalf) return "endHalf"; // 'am' < 'pm'
  return null;
}

async function assertReferences(tx: Queryable, accountId: string, ref: { personId?: string; typeId?: string }) {
  const exists = async (sql: string, id: string, entity: string) => {
    if (!isId(id) || !(await tx.query(sql, [id, accountId])).rows.length) throw notFound(entity);
  };
  if (ref.personId !== undefined) await exists("SELECT 1 FROM people WHERE id = $1::bigint AND account_id = $2::bigint", ref.personId, "person");
  if (ref.typeId !== undefined) await exists("SELECT 1 FROM timeoff_types WHERE id = $1::bigint AND account_id = $2::bigint", ref.typeId, "timeoffType");
}

/** Traduit les violations de contraintes de la base en codes stables ; toute autre erreur remonte telle quelle. */
function translate(err: unknown): never {
  const code = (err as { code?: string })?.code;
  if (code === "23P01") throw new ApiFailure("TIMEOFF_OVERLAP"); // exclusion_violation
  if (code === "23514") throw invalid("body"); // check_violation : filet de sécurité, l'état est déjà validé plus haut
  throw err;
}

export async function createTimeoff(db: Db, ctx: RequestContext, body: TimeoffCreate): Promise<ScheduleTimeoff> {
  assertWriter(ctx);
  if (!isId(body.personId)) throw notFound("person");
  if (!isId(body.typeId)) throw notFound("timeoffType");
  const fields: Fields = {
    startDate: body.startDate, endDate: body.endDate, scope: body.scope ?? "full_day",
    startHalf: body.startHalf ?? "am", endHalf: body.endHalf ?? "pm", hoursPerDay: body.hoursPerDay ?? null,
  };
  const bad = incoherent(fields);
  if (bad) throw invalid(bad);
  return withContext(db, ctx, async (tx) => {
    await assertReferences(tx, ctx.accountId, body);
    try {
      const { rows } = await tx.query<Row>(
        `INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date, scope, start_half, end_half, hours_per_day, approval_status, notes)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4::date, $5::date, $6::timeoff_scope, $7::day_half, $8::day_half, $9::numeric, $10::approval_status, $11)
         RETURNING ${TIMEOFF_COLUMNS}`,
        [ctx.accountId, body.personId, body.typeId, fields.startDate, fields.endDate, fields.scope, fields.startHalf, fields.endHalf, fields.hoursPerDay, body.approvalStatus ?? "pending", body.notes ?? null],
      );
      return toScheduleTimeoff(rows[0]!);
    } catch (err) {
      return translate(err);
    }
  });
}

export async function updateTimeoff(db: Db, ctx: RequestContext, id: string, expectedVersion: number, patch: TimeoffPatch): Promise<ScheduleTimeoff> {
  assertWriter(ctx);
  if (patch.personId !== undefined && !isId(patch.personId)) throw notFound("person");
  if (patch.typeId !== undefined && !isId(patch.typeId)) throw notFound("timeoffType");
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "timeoffs", `${TIMEOFF_COLUMNS}, notes`, "timeoff", ctx.accountId, id, expectedVersion);
    const has = <K extends keyof TimeoffPatch>(k: K) => patch[k] !== undefined;

    const scope = patch.scope ?? cur.scope;
    // Passer en journées entières retire les heures, passer en partiel remet les moitiés par défaut, sans que le client ait à le dire.
    const hoursPerDay: number | null = has("hoursPerDay") ? patch.hoursPerDay ?? null : scope === "full_day" || cur.hours_per_day === null ? null : Number(cur.hours_per_day);
    const fields: Fields = {
      startDate: patch.startDate ?? day(cur.start_date), endDate: patch.endDate ?? day(cur.end_date), scope,
      startHalf: patch.startHalf ?? (scope === "partial" && !has("startHalf") ? "am" : cur.start_half),
      endHalf: patch.endHalf ?? (scope === "partial" && !has("endHalf") ? "pm" : cur.end_half),
      hoursPerDay,
    };
    const bad = incoherent(fields);
    if (bad) throw invalid(bad);

    await assertReferences(tx, ctx.accountId, { personId: patch.personId, typeId: patch.typeId });
    try {
      const { rows } = await tx.query<Row>(
        `UPDATE timeoffs SET person_id = $3::bigint, timeoff_type_id = $4::bigint, start_date = $5::date, end_date = $6::date,
                scope = $7::timeoff_scope, start_half = $8::day_half, end_half = $9::day_half, hours_per_day = $10::numeric,
                approval_status = $11::approval_status, notes = $12
          WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $13::int
          RETURNING ${TIMEOFF_COLUMNS}`,
        [
          id, ctx.accountId, patch.personId ?? String(cur.person_id), patch.typeId ?? String(cur.timeoff_type_id),
          fields.startDate, fields.endDate, fields.scope, fields.startHalf, fields.endHalf, fields.hoursPerDay,
          patch.approvalStatus ?? cur.approval_status, has("notes") ? patch.notes ?? null : cur.notes, expectedVersion,
        ],
      );
      if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
      return toScheduleTimeoff(rows[0]);
    } catch (err) {
      if (err instanceof ApiFailure) throw err;
      return translate(err);
    }
  });
}

export async function deleteTimeoff(db: Db, ctx: RequestContext, id: string, expectedVersion: number): Promise<void> {
  assertWriter(ctx);
  await withContext(db, ctx, async (tx) => {
    await lockAndCheck(tx, "timeoffs", "id, row_version", "timeoff", ctx.accountId, id, expectedVersion);
    const { rows } = await tx.query("DELETE FROM timeoffs WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $3::int RETURNING id", [id, ctx.accountId, expectedVersion]);
    if (!rows.length) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: expectedVersion + 1 });
  });
}
