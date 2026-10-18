// BR-24 : pourcentage = % x heures ouvrées BRUTES du jour (avant congés et fériés), pour le stockage et l'affichage.
// Non plafonné à 100 % par la règle métier ; plafond technique 500 % (schema.sql : percent <= 500).
import { describe, expect, it } from "vitest";
import { MAX_PERCENT, hoursToPercent, isValidPercent, percentToHours } from "../src/percent";

// @BR-24
describe("pourcentage <-> heures (base brute)", () => {
  it("convertit sur les heures ouvrées du jour", () => {
    expect(percentToHours(50, 8)).toBe(4);
    expect(percentToHours(150, 8)).toBe(12);
    expect(percentToHours(50, 4)).toBe(2);
  });
  it("convertit les heures en pourcentage, arrondi à 2 décimales (NUMERIC(5,2))", () => {
    expect(hoursToPercent(4, 8)).toBe(50);
    expect(hoursToPercent(3, 8)).toBe(37.5);
    expect(hoursToPercent(1, 3)).toBe(33.33);
    expect(hoursToPercent(12, 8)).toBe(150);
  });
  it("jour non ouvré : pas de pourcentage défini", () => {
    expect(hoursToPercent(4, 0)).toBeNull();
    expect(percentToHours(50, 0)).toBe(0);
  });
  it("bornes : > 0 et <= 500 (plafond technique)", () => {
    expect(MAX_PERCENT).toBe(500);
    expect([0, -1, 500.01, Number.NaN].map(isValidPercent)).toEqual([false, false, false, false]);
    expect([0.01, 100, 150, 500].map(isValidPercent)).toEqual([true, true, true, true]);
  });
});
