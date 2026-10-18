// BR-24 : le pourcentage se convertit sur les heures ouvrées BRUTES du jour (avant congés et fériés), pour le
// stockage et l'affichage ; l'alerte de sur-allocation, elle, se compare à la capacité nette (capacity-state.ts).
export const MAX_PERCENT = 500; // plafond technique (schema.sql : percent <= 500), pas une règle métier

export const isValidPercent = (percent: number): boolean => Number.isFinite(percent) && percent > 0 && percent <= MAX_PERCENT;

export const percentToHours = (percent: number, workHoursOfDay: number): number => (workHoursOfDay * percent) / 100;

/** null sur un jour non ouvré (aucune base). Arrondi à 2 décimales comme NUMERIC(5,2). */
export function hoursToPercent(hours: number, workHoursOfDay: number): number | null {
  if (workHoursOfDay <= 0) return null;
  return Math.round((hours / workHoursOfDay) * 10_000) / 100;
}
