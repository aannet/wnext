// Barres de capacité d'une personne par cellule de zoom (jour / semaine / mois, ADR-002 §2), pour la ligne de capacité
// du Schedule. Agrégation par aggregateUtilization (BR-38 : un jour libre ne compense pas un jour sur-alloué, d'où
// overbookedDays) ; la barre ne fait que répartir la hauteur, sans règle de plus.
import { aggregateUtilization, type CapacityThresholds, type UtilizationAggregate } from "./capacity-state";
import type { UtilizationRow } from "./utilization";
import { headerCells, type Zoom } from "./viewport";

export interface CapacityBar {
  /** Segments en fractions de la barre, du bas vers le haut ; leur somme vaut 1 (barre vide : tout à 0). */
  confirmed: number;
  tentative: number;
  free: number;
  /** Part de la barre au-delà de la capacité nette (dessinée au-dessus de la ligne de capacité). */
  over: number;
  /** Position de la ligne de capacité dans la barre (1 sans dépassement). */
  capacityLine: number;
}

export interface CapacityCell extends UtilizationAggregate {
  from: string;
  to: string;
  bar: CapacityBar;
}

/** Répartit la barre : total = max(capacité, planifié) ; le confirmé d'abord, puis le tentatif, puis le libre. */
export function capacityBar(a: Pick<UtilizationAggregate, "capacityHours" | "plannedHours" | "tentativeHours">): CapacityBar {
  const total = Math.max(a.capacityHours, a.plannedHours);
  if (total <= 0) return { confirmed: 0, tentative: 0, free: 0, over: 0, capacityLine: 1 };
  const confirmed = (a.plannedHours - a.tentativeHours) / total;
  const tentative = a.tentativeHours / total;
  const free = Math.max(a.capacityHours - a.plannedHours, 0) / total;
  const over = Math.max(a.plannedHours - a.capacityHours, 0) / total;
  return { confirmed, tentative, free, over, capacityLine: a.capacityHours / total };
}

/** Cellules de la plage pour une personne (lignes de utilization() de cette seule personne). */
export function capacityCells(
  rows: readonly UtilizationRow[],
  range: { from: string; to: string },
  zoom: Zoom,
  weekStart: number,
  thresholds: CapacityThresholds,
): CapacityCell[] {
  return headerCells(range, zoom, weekStart).map((c) => {
    const agg = aggregateUtilization(rows.filter((r) => r.day >= c.from && r.day <= c.to), thresholds);
    return { from: c.from, to: c.to, ...agg, bar: capacityBar(agg) };
  });
}
