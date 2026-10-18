// BR-04 : un congé pleine journée posé sur des allocations ou du temps loggé ne supprime rien (déviation
// volontaire de Float). On détecte les jours en conflit, puis on PROPOSE un report ou une réduction ;
// l'application des changements appartient à l'appelant, après choix de l'utilisateur (reporter / réduire / garder).
// Le temps loggé est signalé, jamais modifié. BR-05 : seules les données de la personne concernée comptent.
// BR-29 : un congé en attente est signalé (badge) mais ne déclenche l'assistant qu'à l'approbation.
import { dailyCapacity, type HolidayInput, type PersonInput, type TimeoffInput } from "./capacity";
import { addDays, MAX_RANGE_DAYS } from "./dates";
import { allocationHoursOn, type AllocationInput } from "./load";

export interface IdentifiedAllocation extends AllocationInput {
  id: string;
}

export interface LoggedTimeInput {
  personId: string;
  day: string;
  hours: number;
}

export interface ConflictAllocation {
  allocationId: string;
  hours: number;
}

export interface ConflictDay {
  day: string;
  /** Capacité nette restante avec ce congé. */
  capacityHours: number;
  /** Heures déduites ce jour-là, tous congés cumulés. */
  timeoffHours: number;
  plannedHours: number;
  loggedHours: number;
  overtimeHours: number;
  allocations: ConflictAllocation[];
}

export interface TimeoffConflictInput {
  person: PersonInput;
  /** Le congé examiné. */
  timeoff: TimeoffInput;
  /** Les AUTRES congés de la personne (le congé examiné est ajouté par la fonction). */
  timeoffs: readonly TimeoffInput[];
  holidays: readonly HolidayInput[];
  allocations: readonly IdentifiedAllocation[];
  logged: readonly LoggedTimeInput[];
  /** Fenêtre à examiner (par défaut : la durée du congé). */
  from?: string;
  to?: string;
}

export interface TimeoffConflicts {
  days: ConflictDay[];
  /** Vrai seulement si le congé est approuvé et qu'au moins un jour est en conflit (BR-29). */
  requiresAssistant: boolean;
}

export function detectTimeoffConflicts(input: TimeoffConflictInput): TimeoffConflicts {
  const { person, timeoff } = input;
  const none: TimeoffConflicts = { days: [], requiresAssistant: false };
  if (timeoff.scope !== "full_day" || !timeoff.deducted || timeoff.approvalStatus === "declined") return none;

  const from = input.from && input.from > timeoff.startDate ? input.from : timeoff.startDate;
  const to = input.to && input.to < timeoff.endDate ? input.to : timeoff.endDate;
  if (from > to) return none;

  const others = input.timeoffs.filter((t) => t.personId === person.id);
  const base = { people: [person], holidays: input.holidays, from, to };
  const withIt = dailyCapacity({ ...base, timeoffs: [...others, timeoff] });
  const without = new Map(dailyCapacity({ ...base, timeoffs: others }).map((r) => [r.day, r]));
  const mine = input.allocations.filter((a) => a.personId === person.id);

  const days: ConflictDay[] = [];
  for (const row of withIt) {
    // Le congé doit réellement retirer de la capacité ce jour-là (pas un week-end, pas un férié déjà plein).
    if ((without.get(row.day)?.capacityHours ?? 0) - row.capacityHours <= 0) continue;
    const allocations = mine
      .map((a) => ({ allocationId: a.id, hours: allocationHoursOn(a, person.workDaysHours, row.day) }))
      .filter((a) => a.hours > 0);
    const planned = allocations.reduce((s, a) => s + a.hours, 0);
    const logged = input.logged.filter((l) => l.personId === person.id && l.day === row.day).reduce((s, l) => s + l.hours, 0);
    if (!(planned > row.capacityHours || (logged > 0 && row.capacityHours === 0))) continue;
    days.push({
      day: row.day, capacityHours: row.capacityHours, timeoffHours: row.timeoffHours, plannedHours: planned,
      loggedHours: logged, overtimeHours: Math.max(planned - row.capacityHours, 0), allocations,
    });
  }
  return { days, requiresAssistant: days.length > 0 && timeoff.approvalStatus === "approved" };
}

export interface Reduction {
  allocationId: string;
  fromHours: number;
  toHours: number;
}

export interface Move {
  allocationId: string;
  fromDay: string;
  toDay: string;
  hours: number;
}

export interface DayResolution {
  day: string;
  /** Option « réduire » : heures par allocation ramenées à la capacité restante. */
  reduce: Reduction[];
  /** Option « reporter » : heures déplacées sur les prochains jours avec de la marge. */
  moves: Move[];
  /** Heures de l'excédent qu'aucun jour de l'horizon ne peut absorber. */
  unplacedHours: number;
}

export interface ResolutionInput extends Omit<TimeoffConflictInput, "logged" | "from" | "to"> {
  conflicts: readonly ConflictDay[];
  /** Jours examinés après le dernier conflit pour trouver de la marge (défaut 60). */
  horizonDays?: number;
}

const QUARTER = 4;

export function proposeResolution(input: ResolutionInput): DayResolution[] {
  const { person, conflicts } = input;
  if (conflicts.length === 0) return [];
  const horizon = input.horizonDays ?? 60;
  const first = conflicts[0]!.day;
  const lastConflict = conflicts[conflicts.length - 1]!.day;
  const windowEnd = addDays(first, Math.min(MAX_RANGE_DAYS, Math.round((Date.parse(lastConflict) - Date.parse(first)) / 86_400_000) + horizon));

  const others = input.timeoffs.filter((t) => t.personId === person.id);
  const mine = input.allocations.filter((a) => a.personId === person.id);
  const capacity = new Map(
    dailyCapacity({ people: [person], holidays: input.holidays, timeoffs: [...others, input.timeoff], from: first, to: windowEnd })
      .map((r) => [r.day, r.capacityHours]),
  );
  const planned = new Map<string, number>();
  for (const day of capacity.keys()) {
    planned.set(day, mine.reduce((s, a) => s + allocationHoursOn(a, person.workDaysHours, day), 0));
  }
  const spare = (day: string) => Math.max((capacity.get(day) ?? 0) - (planned.get(day) ?? 0), 0);

  return conflicts.map((c) => {
    const factor = c.plannedHours > 0 ? c.capacityHours / c.plannedHours : 0;
    const reduce = c.allocations
      .map((a) => ({ allocationId: a.allocationId, fromHours: a.hours, toHours: Math.floor(a.hours * factor * QUARTER) / QUARTER }))
      .filter((r) => r.toHours !== r.fromHours);

    // Report : on retire l'excédent des allocations dans l'ordre, et on le replace jour après jour.
    let toPlace = c.overtimeHours;
    const moves: Move[] = [];
    for (const a of c.allocations) {
      let need = Math.min(a.hours, toPlace);
      toPlace -= need;
      for (let d = addDays(c.day, 1); need > 0 && d <= windowEnd; d = addDays(d, 1)) {
        const take = Math.min(need, spare(d));
        if (take <= 0) continue;
        moves.push({ allocationId: a.allocationId, fromDay: c.day, toDay: d, hours: take });
        planned.set(d, (planned.get(d) ?? 0) + take);
        need -= take;
      }
      if (need > 0) toPlace += need; // non placé
    }
    return { day: c.day, reduce, moves, unplacedHours: toPlace };
  });
}
