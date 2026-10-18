// BR-10 : retirer une personne d'un projet supprime ses allocations et temps loggés pour ce projet ->
// récapitulatif + confirmation explicite obligatoires, refus si des logs sont verrouillés (BR-31, BR-12).
// summarizeTeamRemoval est le miroir TS de team_removal_summary() (parité : tests/parity).
import { describe, expect, it } from "vitest";
import { planTeamRemoval, summarizeTeamRemoval, type TeamAllocation, type TeamLog } from "../src/team-removal";

const al = (id: string, startDate: string, endDate: string, over: Partial<TeamAllocation> = {}): TeamAllocation => ({
  id, projectId: "p", personId: "hal", startDate, endDate, repeatEndDate: null, ...over,
});
const lg = (id: string, hours: number, status: TeamLog["status"] = "draft", over: Partial<TeamLog> = {}): TeamLog => ({
  id, projectId: "p", personId: "hal", hours, status, ...over,
});
const ctx = { projectId: "p", personId: "hal" };

// @BR-10
describe("récapitulatif de retrait", () => {
  it("compte allocations et logs, borne première et dernière date (fin de série incluse)", () => {
    const s = summarizeTeamRemoval({ ...ctx,
      allocations: [al("a1", "2026-03-09", "2026-03-10"), al("a2", "2026-02-02", "2026-02-03", { repeatEndDate: "2026-04-30" })],
      logged: [lg("l1", 8), lg("l2", 2.5), lg("l3", 1)] });
    expect(s).toEqual({ allocationCount: 2, firstAllocation: "2026-02-02", lastAllocation: "2026-04-30",
      logCount: 3, logHours: 11.5, lockedLogCount: 0, canRemove: true });
  });
  it("rien à supprimer : dates nulles, retrait possible", () => {
    expect(summarizeTeamRemoval({ ...ctx, allocations: [], logged: [] })).toEqual({
      allocationCount: 0, firstAllocation: null, lastAllocation: null, logCount: 0, logHours: 0, lockedLogCount: 0, canRemove: true });
  });
  it("un log non brouillon (soumis, approuvé, verrouillé) interdit le retrait", () => {
    for (const status of ["submitted", "approved", "locked"] as const) {
      const s = summarizeTeamRemoval({ ...ctx, allocations: [], logged: [lg("l1", 4), lg("l2", 4, status)] });
      expect(s).toMatchObject({ lockedLogCount: 1, canRemove: false });
    }
  });
  it("ignore les autres personnes et les autres projets", () => {
    const s = summarizeTeamRemoval({ ...ctx,
      allocations: [al("a1", "2026-03-09", "2026-03-09"), al("x", "2026-01-01", "2026-12-31", { personId: "other" }), al("y", "2026-01-01", "2026-12-31", { projectId: "q" })],
      logged: [lg("l1", 2), lg("x", 8, "locked", { personId: "other" }), lg("y", 8, "locked", { projectId: "q" })] });
    expect(s).toMatchObject({ allocationCount: 1, logCount: 1, logHours: 2, canRemove: true });
  });
});

describe("garde de confirmation", () => {
  const allocations = [al("a1", "2026-03-09", "2026-03-09"), al("a2", "2026-03-10", "2026-03-10")];
  const logged = [lg("l1", 3), lg("l2", 2)];
  const plan = (confirmation?: { allocationCount: number; logCount: number; logHours: number }, a = allocations, l = logged) =>
    planTeamRemoval({ ...ctx, allocations: a, logged: l, confirmation });

  it("sans confirmation : refusé, avec le récapitulatif à présenter", () => {
    expect(plan()).toMatchObject({ ok: false, reason: "CONFIRMATION_REQUIRED", summary: { allocationCount: 2, logCount: 2, logHours: 5 } });
  });
  it("confirmation conforme : liste exacte des suppressions", () => {
    expect(plan({ allocationCount: 2, logCount: 2, logHours: 5 })).toMatchObject({
      ok: true, deleteAllocationIds: ["a1", "a2"], deleteLogIds: ["l1", "l2"] });
  });
  it("confirmation périmée (une allocation a été ajoutée depuis) : refusé, nouvelle confirmation requise", () => {
    const more = [...allocations, al("a3", "2026-03-11", "2026-03-11")];
    expect(plan({ allocationCount: 2, logCount: 2, logHours: 5 }, more)).toMatchObject({ ok: false, reason: "STALE_CONFIRMATION", summary: { allocationCount: 3 } });
    expect(plan({ allocationCount: 2, logCount: 2, logHours: 5 }, allocations, [lg("l1", 3), lg("l2", 4)])).toMatchObject({ ok: false, reason: "STALE_CONFIRMATION" });
  });
  it("logs verrouillés : refus, même avec une confirmation (BR-31)", () => {
    expect(plan({ allocationCount: 2, logCount: 2, logHours: 5 }, allocations, [lg("l1", 3), lg("l2", 2, "submitted")]))
      .toMatchObject({ ok: false, reason: "LOCKED_LOGS" });
  });
  it("rien à supprimer : pas de confirmation exigée", () => {
    expect(plan(undefined, [], [])).toEqual({ ok: true, deleteAllocationIds: [], deleteLogIds: [],
      summary: expect.objectContaining({ allocationCount: 0, logCount: 0 }) });
  });
  it("ne désigne que la personne et le projet visés", () => {
    const r = plan({ allocationCount: 1, logCount: 0, logHours: 0 }, [al("a1", "2026-03-09", "2026-03-09"), al("x", "2026-03-09", "2026-03-09", { personId: "other" })], []);
    expect(r).toMatchObject({ ok: true, deleteAllocationIds: ["a1"] });
  });
});
