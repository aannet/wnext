// Capacité nette par personne et par jour. Miroir TS de daily_capacity() (schema.sql) ; la parité est
// vérifiée par test/capacity.test.ts (mêmes cas que tests/sql/schema_tests.sql T05..T07).
// Dates : chaînes ISO "YYYY-MM-DD" (pas de fuseau). work_days_hours : index 0 = lundi (ADR-001).

export const MAX_RANGE_DAYS = 400;

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

const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Heures ouvrées d'un jour : ISODOW 1..7 = lundi..dimanche -> index 0..6. */
export function workHours(workDaysHours: readonly number[], day: string): number {
  return workDaysHours[(new Date(toMs(day)).getUTCDay() + 6) % 7] ?? 0;
}

export function dailyCapacity(input: CapacityInput): CapacityRow[] {
  const { from, to } = input;
  const span = (toMs(to) - toMs(from)) / DAY_MS;
  if (!Number.isFinite(span) || span < 0 || span > MAX_RANGE_DAYS) {
    throw new Error(`INVALID_RANGE: ${from}..${to} (plage invalide ou > ${MAX_RANGE_DAYS} jours)`);
  }

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
