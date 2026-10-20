// Pré-remplissage du timesheet (BR-11) : miroir, par jour, des allocations confirmées de la fenêtre.
// Pur : aucune lecture de congés ni de fériés (le miroir ne les retire pas, l'utilisateur ajuste) ; la persistance est dans l'API.
import { allocationHoursOn, type AllocationInput } from "./load";
import { DAY_MS, assertRange, toIso, toMs } from "./dates";
import { workDaysHoursOn, type WorkScheduleEntry } from "./work-schedule";

/** Plafond de saisie par personne et par jour (BR-28, CHECK de logged_time). */
export const MAX_LOGGED_HOURS_PER_DAY = 24;

export interface PrefillAllocation extends AllocationInput {
  id: string;
  projectId: string;
  phaseId: string | null;
  taskId: string | null;
}

/** Temps déjà saisi pour la personne : `allocationId` null = saisie libre. */
export interface PrefillExisting {
  allocationId: string | null;
  workDate: string;
  hours: number;
}

export interface PrefillInput {
  /** Horaire de la période ouverte (people.work_days_hours) : repli hors de tout historique. */
  workDaysHours: readonly number[];
  /** Horaire daté (people_history, BR-19) : chaque jour suit la période qui le couvre, comme daily_planned_load (0002). */
  workSchedule?: readonly WorkScheduleEntry[];
  allocations: readonly PrefillAllocation[];
  existing: readonly PrefillExisting[];
  from: string;
  to: string;
}

export interface PrefillRow {
  allocationId: string;
  projectId: string;
  phaseId: string | null;
  taskId: string | null;
  workDate: string;
  hours: number;
  billable: boolean;
}

const cents = (h: number) => Math.round(h * 100) / 100;

/**
 * Lignes à créer pour la personne sur [from, to]. Une allocation confirmée (projet non tentatif) donne une ligne par jour couvert ;
 * (allocation, jour) déjà saisi est sauté (idempotence, uq_log_prefill) ; le total d'un jour, existant compris, ne dépasse pas 24 h
 * (la ligne est tronquée au reste, ou omise). Tri : jour, puis identifiant d'allocation.
 */
export function planPrefill(input: PrefillInput): PrefillRow[] {
  const { from, to } = input;
  assertRange(from, to);
  const taken = new Set<string>();
  const used = new Map<string, number>();
  for (const e of input.existing) {
    if (e.allocationId !== null) taken.add(`${e.allocationId}|${e.workDate}`);
    used.set(e.workDate, (used.get(e.workDate) ?? 0) + e.hours);
  }
  const mirrored = input.allocations
    .filter((a) => a.status === "confirmed" && !a.projectTentative)
    .sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : BigInt(x.id) > BigInt(y.id) ? 1 : 0));

  const out: PrefillRow[] = [];
  for (let ms = toMs(from); ms <= toMs(to); ms += DAY_MS) {
    const workDate = toIso(ms);
    const wdh = workDaysHoursOn(input, workDate);
    for (const a of mirrored) {
      if (taken.has(`${a.id}|${workDate}`)) continue;
      const planned = cents(allocationHoursOn(a, wdh, workDate));
      if (planned <= 0) continue;
      const hours = cents(Math.min(planned, MAX_LOGGED_HOURS_PER_DAY - (used.get(workDate) ?? 0)));
      if (hours <= 0) continue;
      used.set(workDate, (used.get(workDate) ?? 0) + hours);
      out.push({
        allocationId: a.id, projectId: a.projectId, phaseId: a.phaseId, taskId: a.taskId, workDate, hours,
        billable: a.billable && !a.projectNonBillable && !a.phaseNonBillable && (a.taskBillable ?? true),
      });
    }
  }
  return out;
}
