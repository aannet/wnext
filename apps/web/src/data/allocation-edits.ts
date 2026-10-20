// Écritures d'allocations par gestes (ADR-002 §5) : passage du patch du moteur (BlockPatch, champs modifiés seulement) au
// corps du PATCH / de la découpe (AllocationPatch : la charge voyage dans `load`), et état optimiste local.
//  * Le patch d'un geste reste dans le mode de l'allocation (heures ou %) : on ne change jamais de mode ici.
//  * « Cette occurrence » (BR-25, décision 10 : découpe, pas d'exceptions) : les trois morceaux de splitSeries du moteur,
//    l'occurrence et la suite portant des ids temporaires jusqu'à la réponse.
import type { ApiError, ScheduleResponse } from "@wnext/contracts";
import { SeriesSplitError, splitSeries, type BlockPatch, type GestureBlock, type SeriesSplitCode } from "@wnext/engine";
import type { AllocationPatch, AllocationSplit } from "../api/client.gen";

export type Allocation = ScheduleResponse["allocations"][number];

/** Résultat d'une écriture : codes stables (contrat), NETWORK hors réponse, BUSY si une écriture est déjà en vol. */
export type EditError = ApiError["code"] | "NETWORK" | "BUSY" | "UNSUPPORTED";
export type EditOutcome = { ok: true } | { ok: false; error: EditError; reason?: string };

export interface ScheduleEditor {
  /** Modifie l'allocation (ou toute la série) : optimiste, puis PATCH avec la version lue. */
  updateAllocation(id: string, patch: BlockPatch): Promise<EditOutcome>;
  /** Modifie une seule occurrence (rang `index`) d'une série : découpe en avant / occurrence / après. */
  splitOccurrence(id: string, index: number, patch: BlockPatch): Promise<EditOutcome>;
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

export function toApiPatch(p: BlockPatch): AllocationPatch {
  const { hoursPerDay, percent, ...rest } = p;
  const out: AllocationPatch = { ...rest };
  if (hoursPerDay != null) out.load = { mode: "hours", hoursPerDay };
  if (percent != null) out.load = { mode: "percentage", percent };
  return out;
}

/** Corps de la découpe : la répétition n'est jamais modifiée sur une occurrence isolée (contrat strict). */
export function toSplitBody(occurrenceDate: string, p: BlockPatch): AllocationSplit {
  const { repeatEndDate: _r, ...rest } = toApiPatch(p);
  return Object.keys(rest).length ? { occurrenceDate, patch: rest } : { occurrenceDate };
}

/** Allocation après le patch (même mode, même version : l'état optimiste porte encore la version lue). */
export function patched<A extends Allocation>(a: A, p: BlockPatch): A {
  const out = { ...a } as Allocation;
  if (p.personId !== undefined) out.personId = p.personId;
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
export function localSplit(a: Allocation, index: number, p: BlockPatch, tempId: (n: 1 | 2) => string):
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
      occurrence: { ...patched(s.occurrence, occPatch), id: tempId(1), version: 0 },
      after: s.after && { ...s.after, id: tempId(2), version: 0 },
    },
  };
}
