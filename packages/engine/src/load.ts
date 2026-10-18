// Charge planifiée par personne et par jour ouvré. Miroir TS de daily_planned_load() (schema.sql).
// Fériés et congés ne retirent PAS la charge (elle ressort en sur-allocation, BR-01).
import { DAY_MS, addMonths, assertRange, monthsBetween, toMs, toIso, workHours } from "./dates";

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

export function dailyPlannedLoad(input: LoadInput): LoadRow[] {
  const { from, to } = input;
  assertRange(from, to);
  const people = new Map(input.people.map((p) => [p.id, p]));
  const acc = new Map<string, LoadRow>();

  for (const a of input.allocations) {
    const person = people.get(a.personId);
    if (!person) continue;
    const spanEnd = a.repeatState === "none" ? a.endDate : (a.repeatEndDate ?? a.endDate);
    const first = a.startDate > from ? a.startDate : from;
    const last = spanEnd < to ? spanEnd : to;
    const tentative = a.status === "tentative" || a.projectTentative;
    const billable =
      a.billable && !a.projectNonBillable && !a.phaseNonBillable && (a.taskBillable ?? true) &&
      a.status === "confirmed" && !a.projectTentative;

    for (let ms = toMs(first); ms <= toMs(last); ms += DAY_MS) {
      const day = toIso(ms);
      const wd = workHours(person.workDaysHours, day);
      if (wd <= 0 || !allocationCoversDay(a, day)) continue;
      const v = a.mode === "hours" ? (a.hoursPerDay ?? 0) : (wd * (a.percent ?? 0)) / 100;
      const key = `${a.personId}|${day}`;
      const row = acc.get(key) ?? { personId: a.personId, day, plannedHours: 0, tentativeHours: 0, billableHours: 0 };
      row.plannedHours += v;
      if (tentative) row.tentativeHours += v;
      if (billable) row.billableHours += v;
      acc.set(key, row);
    }
  }
  return [...acc.values()].sort((x, y) => (x.personId < y.personId ? -1 : x.personId > y.personId ? 1 : x.day < y.day ? -1 : 1));
}
