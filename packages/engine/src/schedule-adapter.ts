// Pont entre le contrat GET /api/v1/schedule (@wnext/contracts) et les entrées du moteur. Le client (et l'API) calculent
// capacité, utilisation et conflits à partir de la seule réponse : même code, mêmes nombres des deux côtés.
// Limite : la réponse ne porte pas la facturabilité des phases et tâches ; billableHours n'est donc pas fiable à partir
// de ce seul contrat (les rapports passeront par leur propre endpoint).
import type { ScheduleResponse } from "@wnext/contracts";
import type { HolidayInput, PersonInput, TimeoffInput } from "./capacity";
import { DEFAULT_THRESHOLDS, type CapacityThresholds } from "./capacity-state";
import { utilization, type UtilizationRow } from "./utilization";
import type { IdentifiedAllocation } from "./timeoff-conflicts";

export interface ScheduleEngineInput {
  people: PersonInput[];
  holidays: HolidayInput[];
  timeoffs: TimeoffInput[];
  allocations: IdentifiedAllocation[];
  thresholds: CapacityThresholds;
  from: string;
  to: string;
}

export function scheduleToEngineInput(r: ScheduleResponse): ScheduleEngineInput {
  const types = new Map(r.timeoffTypes.map((t) => [t.id, t]));
  const projects = new Map(r.projects.map((p) => [p.id, p]));
  return {
    from: r.window.from,
    to: r.window.to,
    thresholds: { underPercent: r.account.capacityThresholds.underPercent ?? DEFAULT_THRESHOLDS.underPercent },
    people: r.people.map((p) => ({ id: p.id, active: p.active, workDaysHours: p.workDaysHours, country: p.country, departmentId: p.departmentId })),
    holidays: r.holidays.map((h) => ({ hdate: h.date, country: h.country, departmentId: h.departmentId, hoursOff: h.hoursOff })),
    timeoffs: r.timeoffs.map((t) => {
      const type = types.get(t.typeId);
      if (!type) throw new Error(`UNKNOWN_TIMEOFF_TYPE: ${t.typeId} (congé ${t.id})`);
      return {
        personId: t.personId, startDate: t.startDate, endDate: t.endDate, scope: t.scope, startHalf: t.startHalf, endHalf: t.endHalf,
        hoursPerDay: t.hoursPerDay, deducted: type.deducted, approvalStatus: t.approvalStatus,
      };
    }),
    allocations: r.allocations.map((a) => {
      const project = projects.get(a.projectId);
      if (!project) throw new Error(`UNKNOWN_PROJECT: ${a.projectId} (allocation ${a.id})`);
      return {
        id: a.id, personId: a.personId, startDate: a.startDate, endDate: a.endDate, mode: a.mode, hoursPerDay: a.hoursPerDay, percent: a.percent,
        status: a.status, billable: a.billable, repeatState: a.repeatState, repeatEndDate: a.repeatEndDate,
        projectTentative: project.status === "tentative", projectNonBillable: project.nonBillable,
        phaseNonBillable: false, taskBillable: null,
      };
    }),
  };
}

/** Utilisation par personne et par jour sur la fenêtre de la réponse. */
export function scheduleUtilization(r: ScheduleResponse): UtilizationRow[] {
  const { thresholds: _t, ...input } = scheduleToEngineInput(r);
  return utilization({ ...input, from: r.window.from, to: r.window.to });
}
