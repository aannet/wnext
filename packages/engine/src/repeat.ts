// Occurrences d'une allocation répétée (BR-25), pour l'affichage : GET /schedule renvoie la série une seule fois.
// Sémantique de schema.sql (commentaire de la table allocations) : le bloc [startDate, endDate] est l'occurrence 0,
// répétée par pas daily (+1 j) / weekly (+7 j) / monthly (+k mois depuis l'origine, ramené au dernier jour du mois),
// jusqu'à repeatEndDate INCLUSE (la dernière occurrence est tronquée). Les jours non ouvrés restent dans le bloc :
// ils ne portent pas d'heures (allocationHoursOn), c'est à l'affichage de les griser.
import { DAY_MS, addDays, addMonths, assertRange, monthsBetween, toMs } from "./dates";

export interface RepeatInput {
  startDate: string;
  endDate: string;
  repeatState: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate: string | null;
}

export interface Occurrence {
  /** Rang dans la série (0 = bloc d'origine). Stable quelle que soit la fenêtre demandée. */
  index: number;
  startDate: string;
  endDate: string;
}

/** Dernier jour couvert par la série (fin du bloc si non répétée). */
export const seriesEnd = (a: RepeatInput): string => (a.repeatState === "none" ? a.endDate : (a.repeatEndDate ?? a.endDate));

function occurrence(a: RepeatInput, k: number): Occurrence {
  if (a.repeatState === "monthly") return { index: k, startDate: addMonths(a.startDate, k), endDate: addMonths(a.endDate, k) };
  const step = a.repeatState === "daily" ? 1 : a.repeatState === "weekly" ? 7 : 0;
  return { index: k, startDate: addDays(a.startDate, k * step), endDate: addDays(a.endDate, k * step) };
}

/** Occurrences qui touchent [from, to] (bornes incluses, fenêtre <= 400 jours), triées, tronquées à la fin de série. */
export function expandOccurrences(a: RepeatInput, from: string, to: string): Occurrence[] {
  assertRange(from, to);
  const last = seriesEnd(a);
  if (a.repeatState === "none") return a.startDate <= to && a.endDate >= from ? [occurrence(a, 0)] : [];
  // Premier rang candidat : celui dont le bloc peut encore toucher `from` (un bloc dure au plus endDate - startDate).
  const lengthDays = (toMs(a.endDate) - toMs(a.startDate)) / DAY_MS;
  const reach = Math.max(0, (toMs(from) - toMs(a.startDate)) / DAY_MS - lengthDays);
  let k = a.repeatState === "daily" ? Math.floor(reach)
    : a.repeatState === "weekly" ? Math.floor(reach / 7)
    : Math.max(0, monthsBetween(a.startDate, from) - Math.ceil(lengthDays / 28) - 1);
  const out: Occurrence[] = [];
  for (; ; k++) {
    const o = occurrence(a, k);
    if (o.startDate > to || o.startDate > last) break;
    if (o.endDate > last) o.endDate = last;
    if (o.endDate >= from) out.push(o);
  }
  return out;
}

/** Refus de découpe, code stable (traduit en code du contrat par l'API et par le client). Message préfixé du code, inchangé. */
export type SeriesSplitCode = "NOT_A_SERIES" | "OCCURRENCE_NOT_FOUND" | "SERIES_OVERLAPPING" | "SERIES_MONTHLY_CLAMPED";
export class SeriesSplitError extends Error {
  constructor(readonly code: SeriesSplitCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SeriesSplitError";
  }
}

export interface SeriesSplit<T extends RepeatInput> {
  /** Occurrences 0..index-1, série bornée à la veille de l'occurrence ; null si index = 0. */
  before: T | null;
  /** L'occurrence seule, sans répétition (tronquée à la fin de série comme à l'affichage). */
  occurrence: T;
  /**
   * Occurrences index+1.., nouvelle origine, même fin de série ; null s'il n'y en a pas. Si elle se réduit à une seule
   * occurrence tronquée par la fin de série, c'est une allocation non répétée aux dates tronquées (chk_alloc_repeat exige
   * repeatEndDate >= endDate, qu'un bloc entier dépasserait).
   */
  after: T | null;
}

/**
 * Modifier « cette occurrence » (BR-25, US-3.3) : découpe la série en au plus trois allocations, sans table d'exceptions
 * (décision 10 du registre). « Toute la série » ne découpe rien. Les jours couverts sont conservés, morceaux disjoints.
 * Refus explicites : blocs qui se chevauchent (une occurrence plus longue que le pas) et série mensuelle dont la nouvelle
 * origine serait ramenée en fin de mois (le 31 deviendrait le 28 pour toute la suite).
 */
export function splitSeries<T extends RepeatInput>(a: T, index: number): SeriesSplit<T> {
  if (a.repeatState === "none") throw new SeriesSplitError("NOT_A_SERIES", "allocation non répétée");
  const lengthDays = (toMs(a.endDate) - toMs(a.startDate)) / DAY_MS + 1;
  const step = a.repeatState === "daily" ? 1 : a.repeatState === "weekly" ? 7 : 28;
  if (lengthDays > step) throw new SeriesSplitError("SERIES_OVERLAPPING", `bloc de ${lengthDays} j pour un pas ${a.repeatState}`);
  const last = seriesEnd(a);
  const occ = occurrence(a, index);
  if (!Number.isInteger(index) || index < 0 || occ.startDate > last) throw new SeriesSplitError("OCCURRENCE_NOT_FOUND", String(index));
  const next = occurrence(a, index + 1);
  if (next.startDate <= last && a.repeatState === "monthly"
      && (next.startDate.slice(8) !== a.startDate.slice(8) || next.endDate.slice(8) !== a.endDate.slice(8))) {
    throw new SeriesSplitError("SERIES_MONTHLY_CLAMPED", `l'occurrence ${index + 1} (${next.startDate}) ne peut pas servir d'origine`);
  }
  return {
    before: index === 0 ? null : { ...a, repeatEndDate: addDays(occ.startDate, -1) },
    occurrence: { ...a, startDate: occ.startDate, endDate: occ.endDate > last ? last : occ.endDate, repeatState: "none", repeatEndDate: null },
    after: next.startDate > last ? null
      : next.endDate > last ? { ...a, startDate: next.startDate, endDate: last, repeatState: "none", repeatEndDate: null }
      : { ...a, startDate: next.startDate, endDate: next.endDate },
  };
}
