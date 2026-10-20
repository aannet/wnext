// Horaire de travail daté (BR-19). Miroir TS de people_history (attribut work_days_hours) et de
// person_work_days_hours_on() (migration 0002_people_history). Dates ISO "YYYY-MM-DD" ; index 0 = lundi (ADR-001).

/** Une période d'horaire : bornes INCLUSES, null = ouverte (depuis toujours / sans fin), comme en base. */
export interface WorkScheduleEntry {
  validFrom: string | null;
  validTo: string | null;
  workDaysHours: readonly number[];
}

export interface ScheduledPerson {
  /** Horaire de la période ouverte (people.work_days_hours) : repli hors de tout historique. */
  workDaysHours: readonly number[];
  /** Historique daté ; absent ou vide = horaire constant. Périodes sans recouvrement (EXCLUDE en base). */
  workSchedule?: readonly WorkScheduleEntry[];
}

/** Horaire en vigueur le jour `day` : la période qui le couvre, sinon workDaysHours (même repli que le COALESCE SQL). */
export function workDaysHoursOn(p: ScheduledPerson, day: string): readonly number[] {
  for (const e of p.workSchedule ?? []) {
    if ((e.validFrom === null || e.validFrom <= day) && (e.validTo === null || day <= e.validTo)) return e.workDaysHours;
  }
  return p.workDaysHours;
}
