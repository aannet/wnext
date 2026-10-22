// Écritures d'allocations par gestes (ADR-002 §5) et par la pop-in du créneau (RT-011, RT-014) : passage du patch (BlockPatch
// du moteur, élargi en AllocationEdit : projet, phase, tâche, statut, note, mode) au corps du PATCH / de la découpe
// (AllocationPatch : la charge voyage dans `load`), et état optimiste local.
//  * Le patch d'un geste reste dans le mode de l'allocation (heures ou %) ; seule la pop-in change de mode (`mode` + la
//    quantité du nouveau mode).
//  * Changer de projet sans préciser phase et tâche les remet à zéro, comme l'API (resolvePatch).
//  * « Cette occurrence » (BR-25, décision 10 : découpe, pas d'exceptions) : les trois morceaux de splitSeries du moteur,
//    l'occurrence et la suite portant des ids temporaires jusqu'à la réponse. Le patch de l'occurrence porte tous les champs
//    de la pop-in sauf la répétition (OccurrencePatch du contrat).
//  * « Tout le groupe » (BR-26, RT-042) : champs communs seulement (AllocationGroupPatch : ni personne ni charge).
import type { ApiError, ScheduleResponse } from "@wnext/contracts";
import { SeriesSplitError, splitSeries, type BlockPatch, type GestureBlock, type SeriesSplitCode } from "@wnext/engine";
import type { AllocationGroupPatch, AllocationPatch, AllocationSplit } from "../api/client.gen";

export type Allocation = ScheduleResponse["allocations"][number];

/** Résultat d'une écriture : codes stables (contrat), NETWORK hors réponse, BUSY si une écriture est déjà en vol. */
export type EditError = ApiError["code"] | "NETWORK" | "BUSY" | "UNSUPPORTED";
export type EditOutcome = { ok: true } | { ok: false; error: EditError; reason?: string };

/** Patch d'une allocation : champs d'un geste, plus ceux de la pop-in (absents = inchangés). */
export type AllocationEdit = BlockPatch & {
  projectId?: string; phaseId?: string | null; taskId?: string | null; status?: Allocation["status"]; notes?: string | null; mode?: Allocation["mode"];
};

/**
 * Écriture de groupe réussie : état d'avant de chaque ligne écrite qu'on a pu lire (magasin, lecture préalable) et ids des
 * lignes écrites dont l'état d'avant est inconnu (l'écriture ne peut alors pas être annulée).
 */
export type GroupEditOutcome = { ok: true; before: Allocation[]; unknown: string[] } | Exclude<EditOutcome, { ok: true }>;

/** Patch de toutes les lignes d'un groupe : champs communs, sans personne ni charge (propres à chaque ligne). */
export type AllocationGroupEdit = Omit<AllocationEdit, "personId" | "hoursPerDay" | "percent" | "mode">;

export interface ScheduleEditor {
  /** Modifie l'allocation (ou toute la série) : optimiste, puis PATCH avec la version lue. */
  updateAllocation(id: string, patch: AllocationEdit): Promise<EditOutcome>;
  /** Modifie une seule occurrence (rang `index`) d'une série : découpe en avant / occurrence / après. */
  splitOccurrence(id: string, index: number, patch: AllocationEdit): Promise<EditOutcome>;
  /** Modifie toutes les lignes du groupe de l'allocation `id` (BR-26) : optimiste, puis PATCH /allocations/{id}/group, If-Match de `id`. */
  updateAllocationGroup?(id: string, patch: AllocationGroupEdit): Promise<GroupEditOutcome>;
}

/** Bloc du moteur pour une allocation (ou une occurrence : dates de l'occurrence, sans répétition). */
export function gestureBlockOf(a: Allocation, occurrence?: { startDate: string; endDate: string }): GestureBlock {
  const base: GestureBlock = {
    personId: a.personId, startDate: a.startDate, endDate: a.endDate, mode: a.mode,
    hoursPerDay: a.hoursPerDay, percent: a.percent, repeatState: a.repeatState, repeatEndDate: a.repeatEndDate,
  };
  return occurrence ? { ...base, ...occurrence, repeatState: "none", repeatEndDate: null } : base;
}

const FIELDS = ["personId", "startDate", "endDate", "hoursPerDay", "percent", "repeatEndDate"] as const;

/** Champs de `b` qui diffèrent de `a` (patch cumulé de plusieurs gestes clavier). */
export function diffBlocks(a: GestureBlock, b: GestureBlock): BlockPatch {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (a[k] !== b[k]) out[k] = b[k];
  return out as BlockPatch;
}

export function toApiPatch(p: AllocationEdit): AllocationPatch {
  const { hoursPerDay, percent, mode: _m, ...rest } = p;
  const out: AllocationPatch = { ...rest };
  if (hoursPerDay != null) out.load = { mode: "hours", hoursPerDay };
  if (percent != null) out.load = { mode: "percentage", percent };
  return out;
}

/** Corps de la découpe : la répétition n'est jamais modifiée sur une occurrence isolée (contrat strict). */
export function toSplitBody(occurrenceDate: string, p: AllocationEdit): AllocationSplit {
  const { repeatEndDate: _r, ...rest } = toApiPatch(p);
  return Object.keys(rest).length ? { occurrenceDate, patch: rest } : { occurrenceDate };
}

/** Corps du PATCH de groupe : les champs communs tels quels (le type écarte déjà personne et charge). */
export function toGroupBody(p: AllocationGroupEdit): AllocationGroupPatch {
  const { personId: _p, hoursPerDay: _h, percent: _c, mode: _m, ...rest } = p as AllocationEdit;
  return rest;
}

/** Allocation après le patch (même version : l'état optimiste porte encore la version lue). */
export function patched<A extends Allocation>(a: A, p: AllocationEdit): A {
  let out = { ...a } as Allocation;
  if (p.personId !== undefined) out.personId = p.personId;
  if (p.projectId !== undefined && p.projectId !== a.projectId) { out.projectId = p.projectId; out.phaseId = null; out.taskId = null; }
  if (p.phaseId !== undefined) out.phaseId = p.phaseId;
  if (p.taskId !== undefined) out.taskId = p.taskId;
  if (p.status !== undefined) out.status = p.status;
  if (p.notes !== undefined) out.notes = p.notes;
  if (p.mode === "hours" && out.mode !== "hours" && p.hoursPerDay != null) out = { ...out, mode: "hours", hoursPerDay: p.hoursPerDay, percent: null };
  if (p.mode === "percentage" && out.mode !== "percentage" && p.percent != null) out = { ...out, mode: "percentage", hoursPerDay: null, percent: p.percent };
  if (p.startDate !== undefined) out.startDate = p.startDate;
  if (p.endDate !== undefined) out.endDate = p.endDate;
  if (p.repeatEndDate !== undefined) out.repeatEndDate = p.repeatEndDate;
  if (out.mode === "hours" && p.hoursPerDay != null) out.hoursPerDay = p.hoursPerDay;
  if (out.mode === "percentage" && p.percent != null) out.percent = p.percent;
  return out as A;
}

export interface LocalSplit {
  occurrenceDate: string;
  /** Ligne d'origine après découpe ; null pour l'occurrence 0 (la ligne est supprimée). */
  before: Allocation | null;
  occurrence: Allocation;
  after: Allocation | null;
}

const REASONS: Partial<Record<SeriesSplitCode, string>> = { SERIES_OVERLAPPING: "overlapping", SERIES_MONTHLY_CLAMPED: "monthly_clamped" };

/** Découpe locale (optimiste) ; un refus typé du moteur (SeriesSplitError) rend le code du contrat et sa raison. */
export function localSplit(a: Allocation, index: number, p: AllocationEdit, tempId: (n: 1 | 2) => string):
  { ok: true; split: LocalSplit } | { ok: false; error: EditError; reason?: string } {
  let s: ReturnType<typeof splitSeries<Allocation>>;
  try {
    s = splitSeries(a, index);
  } catch (err) {
    if (!(err instanceof SeriesSplitError)) throw err;
    const tag = err.code;
    if (tag === "NOT_A_SERIES" || tag === "OCCURRENCE_NOT_FOUND") return { ok: false, error: tag };
    return { ok: false, error: "SERIES_SPLIT_UNSUPPORTED", reason: REASONS[tag] };
  }
  const { repeatEndDate: _r, ...occPatch } = p;
  return {
    ok: true,
    split: {
      occurrenceDate: s.occurrence.startDate,
      before: s.before,
      // Comme l'API : seul « avant » (la ligne d'origine) reste dans le groupe, les morceaux insérés en sortent (BR-26).
      occurrence: { ...patched(s.occurrence, occPatch), id: tempId(1), version: 0, groupId: null },
      after: s.after && { ...s.after, id: tempId(2), version: 0, groupId: null },
    },
  };
}
