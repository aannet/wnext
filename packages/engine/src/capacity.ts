// Capacité nette par personne et par jour. Miroir TS de daily_capacity() (schema.sql) ; la parité est
// vérifiée par test/capacity.test.ts (mêmes cas que tests/sql/schema_tests.sql T05..T07).
// Dates : chaînes ISO "YYYY-MM-DD" (pas de fuseau). work_days_hours : index 0 = lundi (ADR-001).

import { DAY_MS, assertRange, toIso, toMs, workHours } from "./dates";

export type Half = "am" | "pm";

export interface PersonInput {
  id: string;
  active: boolean;
  workDaysHours: readonly number[];
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

  const rows: CapacityRow[] = [];
  for (const p of input.people) {
    if (!p.active) continue;
    const timeoffs = input.timeoffs.filter(
      (t) => t.personId === p.id && t.deducted && t.approvalStatus !== "declined",
    );
    for (let ms = toMs(from); ms <= toMs(to); ms += DAY_MS) {
      const day = toIso(ms);
      const base = workHours(p.workDaysHours, day);

      // Férié : portée compte / pays / département ; le plus grand l'emporte, plafonné à l'horaire du jour.
      let holiday = 0;
      for (const h of input.holidays) {
        if (h.hdate !== day) continue;
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
