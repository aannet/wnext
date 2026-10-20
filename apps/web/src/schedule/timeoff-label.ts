// Libellé accessible d'un congé (aria-label et infobulle) : type, dates, demi-journées, heures par jour (partiel) et statut.
// Texte du catalogue i18n ; le nom du type est une donnée (repli traduit si le type n'est pas chargé).
import type { I18n } from "@lingui/core";
import type { GridTimeoff } from "./grid-model";

export function timeoffLabeler(i18n: I18n): (t: Pick<GridTimeoff, "typeName" | "startDate" | "endDate" | "startHalf" | "endHalf" | "status" | "scope" | "hoursPerDay">) => string {
  const fmt = new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const date = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  return (t) => {
    const v = {
      type: t.typeName || i18n._("schedule.timeoff.untyped"), start: date(t.startDate), end: date(t.endDate), startHalf: t.startHalf, endHalf: t.endHalf,
      half: t.startHalf === t.endHalf ? t.startHalf : "full", status: t.status, partial: t.scope === "partial" ? "yes" : "no", hours: t.hoursPerDay ?? 0,
    };
    return i18n._(t.startDate === t.endDate ? "schedule.timeoff.day" : "schedule.timeoff.days", v);
  };
}
