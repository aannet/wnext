// Texte et infobulle de la jauge d'une personne (colonne de gauche, RT-008) : pourcentage de la période visible, ▲ et
// « +N h » au-delà de 100 % (l'état ne repose pas sur la couleur seule, WCAG 1.4.1), infobulle « du … au … : X h planifiées
// sur Y h de capacité », suivie de « N jours en surcharge » s'il y en a (RT-063). Texte du catalogue i18n ; dates courtes
// dans la locale de l'interface.
import type { I18n } from "@lingui/core";
import type { GridGauge } from "./grid-model";

export function gaugeLabeler(i18n: I18n): (g: GridGauge) => { text: string; title: string } {
  const fmt = new Intl.DateTimeFormat(i18n.locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const date = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  return (g) => {
    const text = g.state === "over"
      ? g.percent === null ? i18n._("schedule.gauge.overNoCapacity", { over: g.overHours }) : i18n._("schedule.gauge.over", { percent: g.percent, over: g.overHours })
      // Ni capacité ni charge : un tiret, sans lettre ni traduction (l'infobulle dit 0 h sur 0 h).
      : g.percent === null ? "—" : i18n._("schedule.gauge.percent", { percent: g.percent });
    const values = { start: date(g.from), end: date(g.to), planned: g.plannedHours, capacity: g.capacityHours };
    const title = i18n._(g.from === g.to ? "schedule.gauge.title.day" : "schedule.gauge.title", values);
    // Surcharge jour par jour (RT-063) : le nombre de jours en surcharge s'ajoute à l'infobulle.
    return { text, title: g.overDays > 0 ? i18n._("schedule.gauge.title.overDays", { title, days: g.overDays }) : title };
  };
}
