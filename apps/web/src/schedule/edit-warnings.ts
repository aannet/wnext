// Avertissements non bloquants après un geste (jamais de refus) : BR-01 surcharge (la bande de capacité la montre déjà, le
// message la nomme) et BR-37 dates hors du projet. La phase n'est pas transportée par GET /schedule : pas d'avertissement
// de phase ici. Calcul local sur la personne concernée, jours couverts par l'allocation, au plus 92 jours.
import type { ScheduleResponse } from "@wnext/contracts";
import {
  addDays, allocationDateWarnings, expandOccurrences, scheduleToEngineInput, seriesEnd, utilization, type DateBoundWarning,
} from "@wnext/engine";
import type { Allocation } from "../data/allocation-edits";

export type EditWarning = "OVERLOAD" | Exclude<DateBoundWarning, `PHASE_${string}`>;

const HORIZON_DAYS = 91;

function overloaded(s: ScheduleResponse, a: Allocation): boolean {
  const person = s.people.find((p) => p.id === a.personId);
  const from = a.startDate > s.window.from ? a.startDate : s.window.from;
  let to = seriesEnd(a) < s.window.to ? seriesEnd(a) : s.window.to;
  if (to > addDays(from, HORIZON_DAYS)) to = addDays(from, HORIZON_DAYS);
  if (!person || from > to) return false;
  const projects = new Set(s.projects.map((p) => p.id));
  const types = new Set(s.timeoffTypes.map((t) => t.id));
  const allocations = s.allocations.filter((x) => x.personId === a.personId && x.id !== a.id && projects.has(x.projectId));
  if (projects.has(a.projectId)) allocations.push(a);
  const input = scheduleToEngineInput({
    ...s, people: [person], allocations, timeoffs: s.timeoffs.filter((t) => t.personId === a.personId && types.has(t.typeId)),
  });
  const covered = new Set<string>();
  for (const o of expandOccurrences(a, from, to)) for (let d = o.startDate; d <= o.endDate; d = addDays(d, 1)) covered.add(d);
  return utilization({ ...input, from, to }).some((r) => r.isOverbooked && covered.has(r.day));
}

/** Avertissements de l'allocation telle qu'après le geste (`after`), dans l'état chargé `s`. */
export function editWarnings(s: ScheduleResponse, after: Allocation): EditWarning[] {
  const p = s.projects.find((x) => x.id === after.projectId);
  const dates = allocationDateWarnings(after, p ? { startDate: p.startDate, endDate: p.endDate } : null) as EditWarning[];
  return overloaded(s, after) ? ["OVERLOAD", ...dates] : dates;
}
