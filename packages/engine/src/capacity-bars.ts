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

export interface CapacityCell {
  from: string;
  to: string;
  aggregate: UtilizationAggregate;
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
  return cellsOf(rows, headerCells(range, zoom, weekStart), thresholds);
}

/** Toutes les personnes d'un coup (en-têtes calculés une fois) : lignes de utilization(), toutes personnes mêlées. */
export function capacityCellsByPerson(
  rows: readonly UtilizationRow[],
  range: { from: string; to: string },
  zoom: Zoom,
  weekStart: number,
  thresholds: CapacityThresholds,
): Map<string, CapacityCell[]> {
  const cells = headerCells(range, zoom, weekStart);
  const byPerson = new Map<string, UtilizationRow[]>();
  for (const r of rows) (byPerson.get(r.personId) ?? byPerson.set(r.personId, []).get(r.personId)!).push(r);
  return new Map([...byPerson].map(([id, rs]) => [id, cellsOf(rs, cells, thresholds)]));
}

function cellsOf(rows: readonly UtilizationRow[], cells: readonly { from: string; to: string }[], thresholds: CapacityThresholds): CapacityCell[] {
  // Un seul passage : chaque ligne va dans la cellule qui contient son jour (cellules contiguës et triées).
  const buckets: UtilizationRow[][] = cells.map(() => []);
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let k = 0;
  for (const r of sorted) {
    while (k < cells.length && r.day > cells[k]!.to) k++;
    if (k === cells.length) break;
    if (r.day >= cells[k]!.from) buckets[k]!.push(r);
  }
  return cells.map((c, i) => {
    const aggregate = aggregateUtilization(buckets[i]!, thresholds);
    return { from: c.from, to: c.to, aggregate, bar: capacityBar(aggregate) };
  });
}
