import type { Queryable, RequestContext } from "./db";
import type { Row } from "./schedule";
import { isId, notFound } from "./write";

// RT-048 (US-6.1) : périmètre de lecture par personne. UNE règle, appliquée par le REST (schedule, people, allocations, temps saisi,
// équipe) et par le temps réel (changes.ts : filtre par abonné du journal, rattrapage compris). La RLS n'isole que les comptes.
//  * member : sa seule personne liée (account_members.person_id) ; aucune personne liée = rien. Une autre personne est un 404,
//    comme une personne inexistante (ne pas révéler son existence).
//  * owner, admin, project_manager, guest : tout le compte.

/** Entités du journal (change_log) qui appartiennent à une personne : filtrées pour le member par change_log.person_ids (0006). */
export const PERSON_SCOPED_ENTITIES = ["people", "allocations", "timeoffs", "logged_time", "project_team"] as const;

/** Personnes lisibles par l'appelant : null = toutes ; sinon sa personne liée (tableau vide si aucune). Dans la transaction de la lecture. */
export async function readablePeople(tx: Queryable, ctx: RequestContext): Promise<string[] | null> {
  if (ctx.role !== "member") return null;
  if (!isId(ctx.userId)) return [];
  const { rows } = await tx.query<Row>(
    "SELECT person_id FROM account_members WHERE account_id = $1::bigint AND user_id = $2::bigint AND person_id IS NOT NULL",
    [ctx.accountId, ctx.userId],
  );
  return rows.map((r) => String(r.person_id));
}

/** 404 (entité `person`) si la personne n'est pas lisible par l'appelant ; à appeler avant toute autre lecture de la personne. */
export async function assertPersonReadable(tx: Queryable, ctx: RequestContext, personId: string): Promise<void> {
  const people = await readablePeople(tx, ctx);
  if (people !== null && !people.includes(personId)) throw notFound("person");
}
