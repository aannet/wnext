// BR-38 + décision Q5 (2026-10-18) : états de capacité par personne x jour (ux-ui.md §2.5).
// Sous-allocation : < seuil du compte (défaut 80 %). Sur-allocation : planifié > capacité nette, fixe à 100 %.
// Capacité nulle et charge > 0 => sur-allocation, jamais NULL. Tentatif : inclus, décomposé (Q-01).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS, aggregateUtilization, classifyCapacity, resolveThresholds,
} from "../src/capacity-state";
import type { UtilizationRow } from "../src/utilization";

const row = (capacityHours: number, plannedHours: number, tentativeHours = 0, over: Partial<UtilizationRow> = {}): UtilizationRow => ({
  personId: "p", day: "2026-03-02", capacityHours, plannedHours, tentativeHours, billableHours: 0,
  overtimeHours: Math.max(plannedHours - capacityHours, 0),
  utilization: capacityHours === 0 ? null : plannedHours / capacityHours,
  isOverbooked: plannedHours > capacityHours, ...over,
});

// @BR-38
describe("états de capacité", () => {
  const c = (cap: number, planned: number, tent = 0, t = DEFAULT_THRESHOLDS) => classifyCapacity(row(cap, planned, tent), t);

  it("sous-allocation sous le seuil (strict), heures libres rapportées", () => {
    expect(c(8, 6)).toMatchObject({ state: "under", freeHours: 2, overHours: 0 });
    expect(c(8, 0)).toMatchObject({ state: "under", freeHours: 8 });
  });
  it("exactement au seuil : OK", () => {
    expect(c(8, 6.4).state).toBe("ok");
  });
  it("pile à la capacité : limite", () => {
    expect(c(8, 8)).toMatchObject({ state: "full", freeHours: 0, overHours: 0 });
  });
  it("au-dessus de la capacité : sur-allocation, surtemps rapporté", () => {
    expect(c(8, 9)).toMatchObject({ state: "over", overHours: 1 });
    expect(c(4, 5)).toMatchObject({ state: "over", overHours: 1 }); // 125 %
  });
  it("capacité nulle et aucune charge : indisponible", () => {
    expect(c(0, 0).state).toBe("unavailable");
  });
  it("capacité nulle et charge > 0 : sur-allocation maximale, jamais masquée (utilization NULL)", () => {
    const r = classifyCapacity(row(0, 6), DEFAULT_THRESHOLDS);
    expect(r).toMatchObject({ state: "over", overHours: 6 });
    expect(row(0, 6).utilization).toBeNull();
  });
  it("seuil de compte paramétré", () => {
    expect(c(8, 7, 0, { underPercent: 90 }).state).toBe("under"); // 87,5 % < 90
    expect(c(8, 7, 0, { underPercent: 50 }).state).toBe("ok");
  });
  it("tentatif : sur-allocation potentielle seulement vs confirmée", () => {
    expect(c(8, 10, 3)).toMatchObject({ state: "over", overbookedConfirmed: false, potentialOnly: true });
    expect(c(8, 10, 1)).toMatchObject({ state: "over", overbookedConfirmed: true, potentialOnly: false });
    expect(c(8, 6, 0)).toMatchObject({ overbookedConfirmed: false, potentialOnly: false });
  });
});

describe("seuils de compte", () => {
  it("défaut 80 % ; valeur du compte reprise", () => {
    expect(resolveThresholds(undefined)).toEqual({ underPercent: 80 });
    expect(resolveThresholds({})).toEqual({ underPercent: 80 });
    expect(resolveThresholds({ underPercent: 90 })).toEqual({ underPercent: 90 });
  });
  it("valeur hors de 1..100 refusée (le seuil de sur-allocation, lui, est fixe)", () => {
    for (const v of [0, -5, 101, Number.NaN]) expect(() => resolveThresholds({ underPercent: v })).toThrow(/INVALID_THRESHOLD/);
  });
});

// @BR-03 @BR-38
describe("agrégat sur une période", () => {
  it("somme planifié/capacité, surtemps = somme des dépassements quotidiens (un jour sur-alloué n'est pas compensé par un jour libre)", () => {
    const a = aggregateUtilization([row(8, 10, 2), row(8, 2), row(0, 0)], DEFAULT_THRESHOLDS);
    expect(a).toMatchObject({ capacityHours: 16, plannedHours: 12, tentativeHours: 2, overtimeHours: 2, overbookedDays: 1, utilization: 0.75 });
    expect(a.state).toBe("under");
  });
  it("capacité nulle sur toute la période avec charge : sur-allocation", () => {
    expect(aggregateUtilization([row(0, 4)], DEFAULT_THRESHOLDS)).toMatchObject({ state: "over", utilization: null, overbookedDays: 1 });
  });
  it("période vide : indisponible", () => {
    expect(aggregateUtilization([], DEFAULT_THRESHOLDS).state).toBe("unavailable");
  });
});
