// BR-37 : bornes de dates, avertir sans jamais bloquer.
import { describe, expect, it } from "vitest";
import { allocationDateWarnings, phaseDateWarnings } from "../src/date-bounds";

const a = (startDate: string, endDate: string, repeatEndDate: string | null = null) =>
  ({ startDate, endDate, repeatState: repeatEndDate ? "weekly" as const : "none" as const, repeatEndDate });
const project = { startDate: "2026-03-01", endDate: "2026-03-31" };

// @BR-37
describe("allocationDateWarnings", () => {
  it("dans les bornes : aucun avertissement", () => {
    expect(allocationDateWarnings(a("2026-03-01", "2026-03-31"), project)).toEqual([]);
  });

  it("avant le début / après la fin du projet, ou les deux", () => {
    expect(allocationDateWarnings(a("2026-02-27", "2026-03-03"), project)).toEqual(["ALLOCATION_STARTS_BEFORE_PROJECT"]);
    expect(allocationDateWarnings(a("2026-03-30", "2026-04-02"), project)).toEqual(["ALLOCATION_ENDS_AFTER_PROJECT"]);
    expect(allocationDateWarnings(a("2026-02-01", "2026-05-01"), project)).toEqual(["ALLOCATION_STARTS_BEFORE_PROJECT", "ALLOCATION_ENDS_AFTER_PROJECT"]);
  });

  it("série répétée : la fin de série compte", () => {
    expect(allocationDateWarnings(a("2026-03-02", "2026-03-03", "2026-04-15"), project)).toEqual(["ALLOCATION_ENDS_AFTER_PROJECT"]);
  });

  it("phase : bornes de la phase vérifiées en plus de celles du projet", () => {
    const phase = { startDate: "2026-03-10", endDate: "2026-03-20" };
    expect(allocationDateWarnings(a("2026-03-09", "2026-03-21"), project, phase)).toEqual(["ALLOCATION_STARTS_BEFORE_PHASE", "ALLOCATION_ENDS_AFTER_PHASE"]);
  });

  it("borne absente (date NULL) ou projet sans dates : ne contraint rien", () => {
    expect(allocationDateWarnings(a("2020-01-01", "2030-01-01"), { startDate: null, endDate: null })).toEqual([]);
    expect(allocationDateWarnings(a("2020-01-01", "2030-01-01"), { startDate: "2026-03-01", endDate: null })).toEqual(["ALLOCATION_STARTS_BEFORE_PROJECT"]);
    expect(allocationDateWarnings(a("2020-01-01", "2030-01-01"), null, null)).toEqual([]);
  });
});

// @BR-37
describe("phaseDateWarnings", () => {
  it("phase hors du projet signalée de chaque côté ; dates absentes ignorées", () => {
    expect(phaseDateWarnings({ startDate: "2026-02-20", endDate: "2026-04-10" }, project)).toEqual(["PHASE_STARTS_BEFORE_PROJECT", "PHASE_ENDS_AFTER_PROJECT"]);
    expect(phaseDateWarnings({ startDate: "2026-03-05", endDate: null }, project)).toEqual([]);
    expect(phaseDateWarnings({ startDate: "2026-02-01", endDate: "2026-02-02" }, null)).toEqual([]);
  });
});
