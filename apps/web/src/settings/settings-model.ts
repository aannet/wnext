// Logique pure des Réglages (lot L-F2) : tri des listes, validation d'un jour férié, regroupement des fériés par pays.
import type { Holiday, HolidayInput } from "../data/people-source";
import type { MessageKey } from "../i18n";

export const sortByName = <T extends { name: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

/** Valeur du filtre pays pour « sans pays » (fériés valables pour tous). */
export const NO_COUNTRY = "none";

export interface HolidayValues { name: string; date: string; country: string; hoursOff: string }
export type HolidayErrors = Partial<Record<keyof HolidayValues, MessageKey>>;
export const NEW_HOLIDAY: HolidayValues = { name: "", date: "", country: "", hoursOff: "" };

/** Date ISO réelle : le 30 février est refusé (le simple parse le décalerait au 2 mars). */
const isIsoDate = (s: string) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

export function validateHoliday(v: HolidayValues): HolidayErrors {
  const e: HolidayErrors = {};
  if (!v.name.trim()) e.name = "settings.holidays.error.name";
  if (!isIsoDate(v.date)) e.date = "settings.holidays.error.date";
  if (v.country.trim() && !/^[A-Za-z]{2}$/.test(v.country.trim())) e.country = "settings.holidays.error.country";
  const h = v.hoursOff.trim().replace(",", ".");
  if (h && (!/^\d+(\.\d+)?$/.test(h) || Number(h) > 24)) e.hoursOff = "settings.holidays.error.hours";
  return e;
}

export function holidayInputOf(v: HolidayValues): HolidayInput {
  const h = v.hoursOff.trim().replace(",", ".");
  return { name: v.name.trim(), date: v.date, country: v.country.trim().toUpperCase() || null, hoursOff: h ? Number(h) : null };
}

/** Fériés d'un pays (ou de tous si `country` est vide, ou sans pays si NO_COUNTRY), par date puis nom. */
export function holidaysOf(list: readonly Holiday[], country: string): Holiday[] {
  return list
    .filter((h) => !country || (country === NO_COUNTRY ? h.country === null : h.country === country))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** Pays présents dans la liste, triés. */
export const countriesOf = (list: readonly Holiday[]): string[] => [...new Set(list.map((h) => h.country).filter((c): c is string => c !== null))].sort();
