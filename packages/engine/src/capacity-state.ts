// États de capacité par personne x jour (BR-38, décision Q5 du 2026-10-18, ux-ui.md §2.5). Les états restent hors de la
// fonction SQL utilization(), qui ne renvoie que des nombres. Seul le seuil de sous-allocation est paramétrable par
// compte ; la sur-allocation est fixée à 100 % (planifié > capacité nette).
import type { UtilizationRow } from "./utilization";

export interface CapacityThresholds {
  /** Sous-allocation : charge < ce pourcentage de la capacité nette (1..100). */
  underPercent: number;
}

export const DEFAULT_THRESHOLDS: CapacityThresholds = { underPercent: 80 };

/** Lit les seuils d'un compte (JSONB déjà converti en camelCase) ; manquant => défaut ; hors bornes => INVALID_THRESHOLD. */
export function resolveThresholds(raw: Partial<CapacityThresholds> | null | undefined): CapacityThresholds {
  const under = raw?.underPercent ?? DEFAULT_THRESHOLDS.underPercent;
  if (!Number.isFinite(under) || under < 1 || under > 100) throw new RangeError(`INVALID_THRESHOLD: underPercent=${under} (1..100)`);
  return { underPercent: under };
}

export type CapacityState = "unavailable" | "under" | "ok" | "full" | "over";

export interface CapacityStatus {
  state: CapacityState;
  freeHours: number;
  /** Heures au-delà de la capacité nette (BR-03) ; > 0 même à capacité 0. */
  overHours: number;
  /** Sur-allocation sur le confirmé seul (rouge plein). */
  overbookedConfirmed: boolean;
  /** Sur-allocation due uniquement aux heures tentatives (hachuré, « potentielle »). */
  potentialOnly: boolean;
}

const EPS = 1e-9;

type LoadFigures = Pick<UtilizationRow, "capacityHours" | "plannedHours" | "tentativeHours">;

export function classifyCapacity(r: LoadFigures, t: CapacityThresholds): CapacityStatus {
  const { capacityHours: cap, plannedHours: planned } = r;
  const over = planned - cap > EPS;
  const confirmedOver = planned - r.tentativeHours - cap > EPS;
  let state: CapacityState;
  if (over) state = "over"; // y compris capacité 0 : jamais masqué (BR-38)
  else if (cap <= 0) state = "unavailable";
  else if (Math.abs(planned - cap) <= EPS) state = "full";
  else if (planned / cap < t.underPercent / 100 - EPS) state = "under";
  else state = "ok";
  return {
    state,
    freeHours: Math.max(cap - planned, 0),
    overHours: Math.max(planned - cap, 0),
    overbookedConfirmed: confirmedOver,
    potentialOnly: over && !confirmedOver,
  };
}

export interface UtilizationAggregate extends CapacityStatus {
  capacityHours: number;
  plannedHours: number;
  tentativeHours: number;
  billableHours: number;
  /** Somme des dépassements quotidiens : un jour libre ne compense pas un jour sur-alloué. */
  overtimeHours: number;
  /** null si capacité 0. */
  utilization: number | null;
  overbookedDays: number;
}

/** Jauge récapitulative d'une personne sur une période (lignes d'une même personne). */
export function aggregateUtilization(rows: readonly UtilizationRow[], t: CapacityThresholds): UtilizationAggregate {
  const sum = (f: (r: UtilizationRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const figures = {
    capacityHours: sum((r) => r.capacityHours),
    plannedHours: sum((r) => r.plannedHours),
    tentativeHours: sum((r) => r.tentativeHours),
  };
  return {
    ...figures,
    ...classifyCapacity(figures, t),
    billableHours: sum((r) => r.billableHours),
    overtimeHours: sum((r) => r.overtimeHours),
    utilization: figures.capacityHours === 0 ? null : figures.plannedHours / figures.capacityHours,
    overbookedDays: rows.filter((r) => r.isOverbooked).length,
  };
}
