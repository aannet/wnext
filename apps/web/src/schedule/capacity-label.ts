// Libellé accessible d'une cellule de capacité (aria-label et infobulle) : heures planifiées / capacité, tentatif,
// surcharge. Texte du catalogue i18n (pluriels ICU), la période est déjà formatée par l'appelant.
import type { I18n } from "@lingui/core";
import type { GridCap } from "./grid-model";

export function capacityLabeler(i18n: I18n): (period: string, c: GridCap) => string {
  return (period, c) =>
    c.state === "none"
      ? i18n._("schedule.capacity.none", { period })
      : i18n._("schedule.capacity.cell", {
        period, planned: c.plannedHours, capacity: c.capacityHours, tentative: c.tentativeHours, over: c.overtimeHours, days: c.overbookedDays,
      });
}
