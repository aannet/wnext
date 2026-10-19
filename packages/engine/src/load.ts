// Charge planifiée par personne et par jour ouvré. Miroir TS de daily_planned_load() (schema.sql).
// Fériés et congés ne retirent PAS la charge (elle ressort en sur-allocation, BR-01).
import { percentToHours } from "./percent";
import { DAY_MS, addMonths, assertRange, hoursAt, monthsBetween, toMs, windowDays, workHours, type WindowDays } from "./dates";
import { seriesEnd } from "./repeat";

export interface LoadPersonInput {
  id: string;
  workDaysHours: readonly number[];
}

export interface AllocationInput {
  personId: string;
  startDate: string;
  endDate: string;
  mode: "hours" | "percentage";
  hoursPerDay: number | null;
  percent: number | null;
  status: "confirmed" | "tentative";
  billable: boolean;
  repeatState: "none" | "daily" | "weekly" | "monthly";
  repeatEndDate: string | null;
  /** projects.status = 'tentative' (BR-20). */
  projectTentative: boolean;
  projectNonBillable: boolean;
  phaseNonBillable: boolean;
  /** project_tasks.billable ; null = pas de tâche (facturable par défaut). */
  taskBillable: boolean | null;
}

export interface LoadInput {
  people: readonly LoadPersonInput[];
  allocations: readonly AllocationInput[];
  from: string;
  to: string;
}

export interface LoadRow {
  personId: string;
  day: string;
  plannedHours: number;
  tentativeHours: number;
  billableHours: number;
}

/** L'allocation (occurrence de base [start,end] + répétition) couvre-t-elle le jour d ? Borne de série appliquée par l'appelant. */
export function allocationCoversDay(a: Pick<AllocationInput, "startDate" | "endDate" | "repeatState">, d: string): boolean {
  if (a.repeatState === "none") return d >= a.startDate && d <= a.endDate;
  if (d < a.startDate) return false;
  const length = (toMs(a.endDate) - toMs(a.startDate)) / DAY_MS;
  if (a.repeatState === "daily") return true;
  if (a.repeatState === "weekly") return (((toMs(d) - toMs(a.startDate)) / DAY_MS) % 7) <= length;
  for (let k = 0, n = monthsBetween(a.startDate, d); k <= n; k++) {
    if (d >= addMonths(a.startDate, k) && d <= addMonths(a.endDate, k)) return true;
  }
  return false;
}

/** Heures d'une allocation un jour donné (0 hors série, jour non ouvré ou jour non couvert). Base du % : heures ouvrées brutes. */
export function allocationHoursOn(a: AllocationInput, workDaysHours: readonly number[], day: string): number {
  if (day < a.startDate || day > seriesEnd(a)) return 0;
  const wd = workHours(workDaysHours, day);
  if (wd <= 0 || !allocationCoversDay(a, day)) return 0;
  return amountOn(a, wd);
}

/** Heures d'un jour couvert dont l'horaire brut est `wd` (> 0). Base du % : heures ouvrées brutes (BR-24). */
const amountOn = (a: AllocationInput, wd: number) => (a.mode === "hours" ? (a.hoursPerDay ?? 0) : percentToHours(a.percent ?? 0, wd));

export function dailyPlannedLoad(input: LoadInput): LoadRow[] {
  assertRange(input.from, input.to);
  const acc = plannedLoadByPerson(input, windowDays(input.from, input.to));
  const ids = [...acc.keys()].sort(); // ordre des unités UTF-16, comme les comparaisons < des autres tris
  return ids.flatMap((id) => acc.get(id)!.filter((r): r is LoadRow => r !== undefined));
}

/** Charge par personne, indexée par jour de la fenêtre `cal` (case vide = aucune charge). Interne au moteur (utilization). */
export function plannedLoadByPerson(input: LoadInput, cal: WindowDays): Map<string, (LoadRow | undefined)[]> {
  const people = new Map(input.people.map((p) => [p.id, p]));
  const dayNum = (d: string) => Math.round(toMs(d) / DAY_MS);
  // Lignes par personne, indexées par jour de la fenêtre (boucle chaude sans Date ni clé en chaîne).
  const acc = new Map<string, (LoadRow | undefined)[]>();

  for (const a of input.allocations) {
    const person = people.get(a.personId);
    if (!person) continue;
    const lo = Math.max(0, dayNum(a.startDate) - cal.first);
    const hi = Math.min(cal.iso.length - 1, dayNum(seriesEnd(a)) - cal.first);
    if (lo > hi) continue;
    const tentative = a.status === "tentative" || a.projectTentative;
    const billable =
      a.billable && !a.projectNonBillable && !a.phaseNonBillable && (a.taskBillable ?? true) &&
      a.status === "confirmed" && !a.projectTentative;
    const start = dayNum(a.startDate);
    const length = dayNum(a.endDate) - start;
    const rows = acc.get(a.personId) ?? acc.set(a.personId, new Array(cal.iso.length)).get(a.personId)!;

    for (let i = lo; i <= hi; i++) {
      const wd = hoursAt(person.workDaysHours, cal.dow[i]!);
      if (wd <= 0) continue;
      const offset = cal.first + i - start;
      const covered = a.repeatState === "none" || a.repeatState === "daily" ? true
        : a.repeatState === "weekly" ? offset % 7 <= length
        : allocationCoversDay(a, cal.iso[i]!);
      if (!covered) continue;
      const v = amountOn(a, wd);
      if (v <= 0) continue;
      const row = rows[i] ?? (rows[i] = { personId: a.personId, day: cal.iso[i]!, plannedHours: 0, tentativeHours: 0, billableHours: 0 });
      row.plannedHours += v;
      if (tentative) row.tentativeHours += v;
      if (billable) row.billableHours += v;
    }
  }
  return acc;
}
