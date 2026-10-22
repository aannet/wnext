// Commandes d'un bloc du Schedule (RT-047, US-3.2) : supprimer, dupliquer, scinder. Sans React : écritures brutes de la source
// (elles ne s'enregistrent pas elles-mêmes) puis UNE action d'annulation (BR-40) décrivant ce qui a été écrit.
//  * Supprimer : allocation seule, ligne d'un groupe ou toute une série -> DELETE, annulable (recréation sous un nouvel id,
//    hors groupe : aucune route ne rattache une ligne à un groupe) ; tout le groupe -> DELETE /allocations/{id}/group, annulable
//    si le serveur a rendu toutes les lignes supprimées (sinon non annulable, et les actions qui touchent ces lignes sont retirées) ; une
//    occurrence -> découpe (BR-25), non annulable comme toute découpe (voir history.ts). Chaque suppression part avec la version
//    de l'allocation telle que l'utilisateur l'a vue (`a`, figée à l'ouverture de l'étape) : modifiée entre-temps, 409 et relecture,
//    rien supprimé ; l'annulation ne peut donc jamais recréer un état plus ancien que celui supprimé.
//  * Dupliquer : copie juste après le bloc (ou l'occurrence), même personne, même durée en jours calendaires (comme le
//    déplacement), mêmes champs, sans répétition.
//  * Scinder : allocation non répétée d'au moins deux jours ; la première partie garde la ligne (fin ramenée à la veille de la
//    date choisie), la seconde est une création qui reprend tous les champs (hors groupe). Pas de route dédiée : deux
//    écritures, une action ; un refus de la seconde laisse la première enregistrée, et annulable.
import { addDays, dayNumber, type Op } from "@wnext/engine";
import type { AllocationCreate } from "../api/client.gen";
import { localSplit, type Allocation, type EditError } from "../data/allocation-edits";
import { allocationCreateOf } from "../data/record-edits";
import type { ScheduleSource } from "../data/schedule-source";
import type { History } from "./history";
import type { ScopeBlocker, ScopeOption } from "./slot-model";

export type CommandRecords = Pick<ScheduleSource, "createAllocation" | "deleteAllocation" | "updateAllocation">
  & Partial<Pick<ScheduleSource, "deleteAllocationGroup" | "deleteOccurrence">>;

export interface CommandDeps {
  /** Écritures brutes (source) ; l'action d'annulation est enregistrée ici. */
  records: CommandRecords;
  history?: Pick<History, "record" | "invalidate"> | undefined;
}

const ALLOCATIONS = "allocations";
const deleteOp = (a: Allocation): Op => ({ kind: "delete", entity: ALLOCATIONS, id: a.id, before: { ...allocationCreateOf(a) } });

/**
 * Portée d'une suppression : série ouverte sur une occurrence (« cette occurrence », indisponible si le moteur ne sait pas la
 * découper, ou « toute la série ») ; ligne d'un groupe, si la source sait supprimer un groupe (`group`) : « cette ligne » ou
 * « tout le groupe » (pour une série d'un groupe : occurrence, série ou groupe). Vide : rien à choisir, la ligne est supprimée.
 */
export function deleteOptions(a: Allocation, occurrence: number | null, group: boolean): ScopeOption[] {
  const out: ScopeOption[] = [];
  if (a.repeatState !== "none" && occurrence !== null) {
    const split = localSplit(a, occurrence, {}, (n) => `delete-${n}`);
    const blocked: ScopeBlocker | null = split.ok ? null : split.reason === "overlapping" || split.reason === "monthly_clamped" ? split.reason : "other";
    out.push({ scope: "occurrence", blocked }, { scope: "series", blocked: null });
  }
  if (a.groupId !== null && group) {
    if (out.length === 0) out.push({ scope: "line", blocked: null });
    out.push({ scope: "group", blocked: null });
  }
  return out;
}

export type DeleteScope = ScopeOption["scope"];
export type CommandFailure = { ok: false; error: EditError };
/** `count` : allocations supprimées (lignes connues pour un groupe) ; `undoable` : une action d'annulation a été enregistrée. */
export type DeleteOutcome = { ok: true; count: number; undoable: boolean } | CommandFailure;

export async function deleteAllocationScoped(deps: CommandDeps, a: Allocation, occurrence: number | null, scope: DeleteScope): Promise<DeleteOutcome> {
  const { records, history } = deps;
  if (scope === "occurrence") {
    const out = records.deleteOccurrence && occurrence !== null ? await records.deleteOccurrence(a.id, occurrence, a.version) : { ok: false as const, error: "UNSUPPORTED" as const };
    if (!out.ok) return { ok: false, error: out.error };
    history?.invalidate(ALLOCATIONS, [a.id]);
    return { ok: true, count: 1, undoable: false };
  }
  if (scope === "group") {
    const out = records.deleteAllocationGroup ? await records.deleteAllocationGroup(a.id, a.version) : { ok: false as const, error: "UNSUPPORTED" as const };
    if (!out.ok) return { ok: false, error: out.error };
    if (!out.complete) {
      history?.invalidate(ALLOCATIONS, out.before.map((x) => x.id));
      return { ok: true, count: out.before.length, undoable: false };
    }
    history?.record({ label: "allocation.delete", ops: out.before.map(deleteOp) });
    return { ok: true, count: out.before.length, undoable: history !== undefined };
  }
  const out = await records.deleteAllocation(a.id, a.version);
  if (!out.ok) return { ok: false, error: out.error };
  history?.record({ label: "allocation.delete", ops: [deleteOp(a)] });
  return { ok: true, count: 1, undoable: history !== undefined };
}

type Dates = { startDate: string; endDate: string };
/** Place imposée de la copie (Alt + glisser) : personne et dates du fantôme. */
export type CopyPlace = Dates & { personId: string };

/**
 * Corps de la copie : juste après le bloc (ou l'occurrence `occ`), même durée en jours calendaires, sans répétition ; `at` :
 * à cette place (Alt + glisser).
 */
export function duplicateBody(a: Allocation, occ?: Dates | null, at?: CopyPlace): AllocationCreate {
  const start = occ?.startDate ?? a.startDate;
  const end = occ?.endDate ?? a.endDate;
  const from = addDays(end, 1);
  const place = at ?? { personId: a.personId, startDate: from, endDate: addDays(from, dayNumber(end) - dayNumber(start)) };
  return allocationCreateOf({ ...a, ...place, repeatState: "none", repeatEndDate: null });
}

export type DuplicateOutcome = { ok: true; id: string; body: AllocationCreate } | CommandFailure;

export async function duplicateAllocation(deps: CommandDeps, a: Allocation, occ?: Dates | null, at?: CopyPlace): Promise<DuplicateOutcome> {
  const body = duplicateBody(a, occ, at);
  const out = await deps.records.createAllocation(body);
  if (!out.ok) return { ok: false, error: out.error };
  deps.history?.record({ label: "allocation.duplicate", ops: [{ kind: "create", entity: ALLOCATIONS, id: out.id, after: { ...body } }] });
  return { ok: true, id: out.id, body };
}

/** Ce qui empêche de scinder : une série (découper d'abord l'occurrence) ou un bloc d'un seul jour ; null si possible. */
export type SplitBlocker = "series" | "one_day";
export function splitBlocker(a: Allocation): SplitBlocker | null {
  if (a.repeatState !== "none") return "series";
  return a.startDate >= a.endDate ? "one_day" : null;
}

/** Début proposé de la seconde partie : le milieu du bloc (au moins le deuxième jour). */
export function defaultSplitDate(a: Allocation): string {
  const days = dayNumber(a.endDate) - dayNumber(a.startDate) + 1;
  return addDays(a.startDate, Math.max(1, Math.floor(days / 2)));
}

/** La seconde partie commence après le premier jour et au plus tard le dernier. */
export const splitDateValid = (a: Allocation, date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && date > a.startDate && date <= a.endDate;

/** `partial` : la première écriture a réussi avant le refus (enregistrée, annulable). */
export type SplitOutcome = { ok: true } | { ok: false; error: EditError; partial: boolean };

export async function splitAllocationAt(deps: CommandDeps, a: Allocation, date: string): Promise<SplitOutcome> {
  const { records, history } = deps;
  if (splitBlocker(a) !== null || !splitDateValid(a, date)) return { ok: false, error: "VALIDATION_FAILED", partial: false };
  const firstEnd = addDays(date, -1);
  const up = await records.updateAllocation(a.id, { endDate: firstEnd });
  if (!up.ok) return { ok: false, error: up.error, partial: false };
  const ops: Op[] = [{ kind: "update", entity: ALLOCATIONS, id: a.id, before: { endDate: a.endDate }, after: { endDate: firstEnd } }];
  const body = allocationCreateOf({ ...a, startDate: date, endDate: a.endDate });
  const created = await records.createAllocation(body);
  if (created.ok) ops.push({ kind: "create", entity: ALLOCATIONS, id: created.id, after: { ...body } });
  history?.record({ label: "allocation.split", ops });
  return created.ok ? { ok: true } : { ok: false, error: created.error, partial: true };
}
