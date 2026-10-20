// BR-04, application du report assisté : traduit, pour UNE allocation et le choix de l'utilisateur (reporter ou réduire),
// les propositions jour par jour de proposeResolution en écritures d'allocation (bornes de l'allocation d'origine et
// morceaux à créer). Pur : l'appelant exécute (PATCH, POST, DELETE) et en fait une seule action d'annulation.
//  * Chaque jour de l'allocation reçoit une quantité : « origine » (inchangé) ou un nombre d'heures (jour en conflit après
//    report ou réduction, jour cible d'un report). Les jours consécutifs de même quantité forment un morceau ; un jour non
//    ouvré (0 h à l'horaire de la personne) ne coupe pas un morceau, un jour à 0 h ouvré le coupe.
//  * En mode heures, un nombre égal à hoursPerDay vaut « origine » : le morceau reporté juste après l'allocation la prolonge.
//  * L'allocation d'origine devient le premier morceau de sa charge (même mode : simple PATCH des dates, et des heures en mode
//    heures) ; les autres morceaux sont créés (charge d'origine, ou en heures). Rien à garder : suppression.
//  * Rien n'est jamais perdu en silence : les heures d'un report que l'horizon n'a pas pu placer restent sur leur jour.
//  * Séries (répétition) : non traitées (null) ; l'écran les laisse telles quelles (garder), à ajuster à la main.
import { addDays, workHours } from "./dates";
import { allocationHoursOn } from "./load";
import type { DayResolution, IdentifiedAllocation } from "./timeoff-conflicts";

export type ResolutionChoice = "move" | "reduce";

export interface ResolutionSlice {
  startDate: string;
  endDate: string;
  /** null = charge d'origine de l'allocation (même mode) ; sinon heures par jour. */
  hoursPerDay: number | null;
}

export interface ResolutionWrites {
  allocationId: string;
  /** Allocation d'origine après écriture (dates, heures si elles changent en mode heures) ; null = à supprimer. */
  update: { startDate: string; endDate: string; hoursPerDay?: number } | null;
  /** Morceaux à créer (copies de l'allocation d'origine, sans répétition). */
  creates: ResolutionSlice[];
  /** Heures déplacées vers d'autres jours (reporter) ou retirées (réduire). */
  movedHours: number;
  removedHours: number;
}

export interface ResolutionWritesInput {
  allocation: IdentifiedAllocation;
  workDaysHours: readonly number[];
  resolutions: readonly DayResolution[];
  choice: ResolutionChoice;
}

type Amount = number | "origin";

export function resolutionWrites(input: ResolutionWritesInput): ResolutionWrites | null {
  const { allocation: a, workDaysHours: wdh, choice } = input;
  if (a.repeatState !== "none") return null;
  const amounts = new Map<string, number>();
  let movedHours = 0;
  let removedHours = 0;
  for (const r of input.resolutions) {
    const h = allocationHoursOn(a, wdh, r.day);
    if (h <= 0) continue;
    if (choice === "move") {
      const moves = r.moves.filter((m) => m.allocationId === a.id);
      const moved = moves.reduce((s, m) => s + m.hours, 0);
      if (moved <= 0) continue;
      amounts.set(r.day, h - moved);
      movedHours += moved;
      for (const m of moves) {
        amounts.set(m.toDay, (amounts.get(m.toDay) ?? allocationHoursOn(a, wdh, m.toDay)) + m.hours);
      }
    } else {
      const red = r.reduce.find((x) => x.allocationId === a.id);
      if (!red) continue;
      amounts.set(r.day, red.toHours);
      removedHours += h - red.toHours;
    }
  }
  if (amounts.size === 0) return null;

  const days = [...amounts.keys()].sort();
  const from = a.startDate < days[0]! ? a.startDate : days[0]!;
  const to = a.endDate > days[days.length - 1]! ? a.endDate : days[days.length - 1]!;
  const sameAsOrigin = (h: number) => a.mode === "hours" && h === a.hoursPerDay;
  const amountOn = (d: string): Amount => {
    const v = amounts.get(d);
    if (v === undefined) return d >= a.startDate && d <= a.endDate ? "origin" : 0;
    return sameAsOrigin(v) ? "origin" : v;
  };

  // Morceaux : le dernier de la liste s'allonge tant que la quantité ne change pas.
  const slices: ResolutionSlice[] = [];
  let open = false;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (workHours(wdh, d) <= 0) continue; // jour non ouvré : ne coupe pas
    const v = amountOn(d);
    if (v === 0) { open = false; continue; }
    const hours = v === "origin" ? null : v;
    const last = slices[slices.length - 1];
    if (open && last && last.hoursPerDay === hours) { last.endDate = d; continue; }
    slices.push({ startDate: d, endDate: d, hoursPerDay: hours });
    open = true;
  }

  // L'origine garde le premier morceau de sa charge ; en mode heures, n'importe quel morceau (même mode).
  const keepIndex = Math.max(slices.findIndex((s) => s.hoursPerDay === null), a.mode === "hours" && slices.length > 0 ? 0 : -1);
  const kept = keepIndex >= 0 ? slices[keepIndex]! : null;
  const update = kept
    ? { startDate: kept.startDate, endDate: kept.endDate, ...(kept.hoursPerDay !== null ? { hoursPerDay: kept.hoursPerDay } : {}) }
    : null;
  return {
    allocationId: a.id, update, creates: slices.filter((_, i) => i !== keepIndex), movedHours, removedHours,
  };
}
