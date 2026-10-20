// Libellé accessible d'un bloc (aria-label) : projet, dates de l'occurrence, heures par jour ou %, tentatif, répétition.
// Texte du catalogue i18n ; dates formatées une fois par jour distinct (cache), le nom du projet est une donnée.
import type { I18n } from "@lingui/core";
import type { GridBlock } from "./grid-model";

export function blockLabeler(i18n: I18n): (b: GridBlock) => string {
  const fmt = new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const dates = new Map<string, string>();
  const date = (d: string) => {
    let s = dates.get(d);
    if (s === undefined) { s = fmt.format(new Date(`${d}T00:00:00Z`)); dates.set(d, s); }
    return s;
  };
  return (b) => {
    const v = {
      project: b.label, start: date(b.startDate), end: date(b.endDate), tentative: b.tentative ? "yes" : "no", repeat: b.repeat,
      hours: b.hoursPerDay ?? 0, percent: b.percent ?? 0,
    };
    return b.startDate === b.endDate
      ? i18n._(b.percent !== null ? "schedule.block.day.percent" : "schedule.block.day.hours", v)
      : i18n._(b.percent !== null ? "schedule.block.percent" : "schedule.block.hours", v);
  };
}
