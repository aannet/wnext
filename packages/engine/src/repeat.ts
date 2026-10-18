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
