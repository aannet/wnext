// Capacité nette par personne et par jour. Miroir TS de daily_capacity() (schema.sql) ; la parité est
// vérifiée par test/capacity.test.ts (mêmes cas que tests/sql/schema_tests.sql T05..T07).
// Dates : chaînes ISO "YYYY-MM-DD" (pas de fuseau). work_days_hours : index 0 = lundi (ADR-001).
// Horaire daté (BR-19) : PersonInput.workSchedule, lu jour par jour comme person_work_days_hours_on() (migration 0002).

import { assertRange, hoursAt, windowDays } from "./dates";
import { workDaysHoursOn, type ScheduledPerson } from "./work-schedule";

export type Half = "am" | "pm";

/** workDaysHours = horaire de la période ouverte ; workSchedule (optionnel) = historique daté (BR-19). */
export interface PersonInput extends ScheduledPerson {
  id: string;
  active: boolean;
  country: string | null;
  departmentId: string | null;
}

export interface HolidayInput {
  hdate: string;
  country: string | null;
  departmentId: string | null;
  /** null = journée entière. */
  hoursOff: number | null;
}

export interface TimeoffInput {
  personId: string;
  startDate: string;
  endDate: string;
  scope: "full_day" | "partial";
  startHalf: Half;
  endHalf: Half;
  hoursPerDay: number | null;
  /** timeoff_types.deducted : seuls les types déduits réduisent la capacité. */
  deducted: boolean;
  approvalStatus: "pending" | "approved" | "declined";
}

export interface CapacityInput {
  people: readonly PersonInput[];
  holidays: readonly HolidayInput[];
  timeoffs: readonly TimeoffInput[];
  from: string;
  to: string;
}

export interface CapacityRow {
  personId: string;
  day: string;
  baseHours: number;
  holidayHours: number;
  timeoffHours: number;
  capacityHours: number;
}

export function dailyCapacity(input: CapacityInput): CapacityRow[] {
  const { from, to } = input;
  assertRange(from, to);

  const cal = windowDays(from, to);
  const holidaysByDay = new Map<string, HolidayInput[]>();
  for (const h of input.holidays) (holidaysByDay.get(h.hdate) ?? holidaysByDay.set(h.hdate, []).get(h.hdate)!).push(h);
  const timeoffsByPerson = new Map<string, TimeoffInput[]>();
  for (const t of input.timeoffs) {
    if (!t.deducted || t.approvalStatus === "declined" || t.endDate < from || t.startDate > to) continue;
    (timeoffsByPerson.get(t.personId) ?? timeoffsByPerson.set(t.personId, []).get(t.personId)!).push(t);
  }

  const rows: CapacityRow[] = [];
  for (const p of input.people) {
    if (!p.active) continue;
    const timeoffs = timeoffsByPerson.get(p.id) ?? [];
    for (let i = 0; i < cal.iso.length; i++) {
      const day = cal.iso[i]!;
      const base = hoursAt(workDaysHoursOn(p, day), cal.dow[i]!); // horaire en vigueur ce jour-là (BR-19)

      // Férié : portée compte / pays / département ; le plus grand l'emporte, plafonné à l'horaire du jour.
      let holiday = 0;
      for (const h of holidaysByDay.get(day) ?? []) {
        if (h.country !== null && h.country !== p.country) continue;
        if (h.departmentId !== null && h.departmentId !== p.departmentId) continue;
        holiday = Math.max(holiday, h.hoursOff ?? base);
      }
      holiday = Math.min(base, holiday);

      // Congés cumulés, plafonnés au reste du jour (pas de double déduction avec le férié).
      let off = 0;
      for (const t of timeoffs) {
        if (day < t.startDate || day > t.endDate) continue;
        if (t.scope === "partial") off += t.hoursPerDay ?? 0;
        else {
          const first = day === t.startDate && t.startHalf === "pm" ? 0 : 1;
          const last = day === t.endDate && t.endHalf === "am" ? 0 : 1;
          off += (base * (first + last)) / 2;
        }
      }
      off = Math.min(off, base - holiday);

      rows.push({ personId: p.id, day, baseHours: base, holidayHours: holiday, timeoffHours: off, capacityHours: base - holiday - off });
    }
  }
  return rows;
}
