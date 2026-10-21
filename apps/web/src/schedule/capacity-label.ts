// Libellé accessible d'une cellule de capacité (aria-label et infobulle) : heures planifiées / capacité, tentatif,
// surcharge. Texte du catalogue i18n (pluriels ICU), la période est déjà formatée par l'appelant.
import type { I18n } from "@lingui/core";
import type { GridCap } from "./grid-model";

/**
 * Charge chiffrée d'une cellule (RT-030, Q11), affichée dans la bande quand la bascule « Charge par colonne » est active :
 * pourcentage de la capacité (comme la jauge), heures planifiées si la capacité est nulle, rien sans capacité ni charge.
 */
export function capacityTexter(i18n: I18n): (c: Pick<GridCap, "plannedHours" | "capacityHours" | "state">) => string {
  return (c) => c.state === "none" ? ""
    : c.capacityHours > 0 ? i18n._("schedule.load.percent", { percent: Math.round((c.plannedHours / c.capacityHours) * 100) })
    : i18n._("schedule.load.hours", { hours: c.plannedHours });
}

export function capacityLabeler(i18n: I18n): (period: string, c: GridCap) => string {
  return (period, c) =>
    c.state === "none"
      ? i18n._("schedule.capacity.none", { period })
      : i18n._("schedule.capacity.cell", {
        period, planned: c.plannedHours, capacity: c.capacityHours, tentative: c.tentativeHours, over: c.overtimeHours, days: c.overbookedDays,
      });
}
