// Conversions des gestes vers le contrat (ADR-002 §5) : charge dans `load`, découpe sans répétition, patch cumulé.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { diffBlocks, gestureBlockOf, localSplit, toApiPatch, toSplitBody } from "../src/data/allocation-edits";

const alloc = (id: string, over: Partial<ScheduleResponse["allocations"][number]> = {}) => ({
  id, version: 3, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 4, percent: null, ...over,
}) as ScheduleResponse["allocations"][number];

describe("conversions", () => {
  it("patch du moteur -> corps du PATCH (charge dans load) et de la découpe (sans répétition)", () => {
    expect(toApiPatch({ startDate: "2026-10-21", hoursPerDay: 4.5 })).toEqual({ startDate: "2026-10-21", load: { mode: "hours", hoursPerDay: 4.5 } });
    expect(toApiPatch({ percent: 55 })).toEqual({ load: { mode: "percentage", percent: 55 } });
    expect(toSplitBody("2026-10-27", { startDate: "2026-10-28", repeatEndDate: "2026-12-01" })).toEqual({ occurrenceDate: "2026-10-27", patch: { startDate: "2026-10-28" } });
    const b = gestureBlockOf(alloc("1"));
    expect(diffBlocks(b, { ...b, endDate: "2026-10-23", hoursPerDay: 5 })).toEqual({ endDate: "2026-10-23", hoursPerDay: 5 });
  });
});

describe("localSplit", () => {
  const weekly = alloc("20", { startDate: "2026-10-19", endDate: "2026-10-20", repeatState: "weekly", repeatEndDate: "2026-11-15" });
  it("occurrence 0 : pas de morceau avant, occurrence patchée et suite avec ids temporaires", () => {
    const r = localSplit(weekly, 0, { hoursPerDay: 6, repeatEndDate: "2027-01-01" }, (k) => `t${k}`);
    expect(r.ok && [r.split.occurrenceDate, r.split.before, r.split.occurrence.hoursPerDay, r.split.occurrence.repeatState, r.split.after?.id, r.split.after?.startDate])
      .toEqual(["2026-10-19", null, 6, "none", "t2", "2026-10-26"]);
  });
  it("allocation non répétée : NOT_A_SERIES", () => {
    expect(localSplit(alloc("1"), 0, {}, String)).toEqual({ ok: false, error: "NOT_A_SERIES" });
  });
});
