// Contrat du retrait d'équipe (BR-10) : récapitulatif puis confirmation, codes dédiés, aucune écriture à la lecture.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { ErrorCode, TeamRemovalRequest, TeamRemovalSummary, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("TeamRemovalRequest", () => {
  it("la confirmation est optionnelle (rien à supprimer) mais bien formée si présente", () => {
    expect(ok(TeamRemovalRequest, {})).toBe(true);
    expect(ok(TeamRemovalRequest, { confirmation: { allocationCount: 2, logCount: 1, logHours: 3.5 } })).toBe(true);
  });
  it.each([
    ["compte négatif", { confirmation: { allocationCount: -1, logCount: 0, logHours: 0 } }],
    ["compte décimal", { confirmation: { allocationCount: 1.5, logCount: 0, logHours: 0 } }],
    ["champ manquant", { confirmation: { allocationCount: 1, logCount: 0 } }],
    ["heures négatives", { confirmation: { allocationCount: 0, logCount: 0, logHours: -1 } }],
  ])("refuse : %s", (_n, v) => expect(ok(TeamRemovalRequest, v)).toBe(false));
});

describe("TeamRemovalSummary", () => {
  const s = { inTeam: true, allocationCount: 0, firstAllocation: null, lastAllocation: null, logCount: 0, logHours: 0, lockedLogCount: 0, canRemove: true };
  it("accepte un récapitulatif vide (dates nulles) et plein", () => {
    expect(ok(TeamRemovalSummary, s)).toBe(true);
    expect(ok(TeamRemovalSummary, { ...s, allocationCount: 2, firstAllocation: "2026-03-02", lastAllocation: "2026-04-30" })).toBe(true);
    expect(ok(TeamRemovalSummary, { ...s, firstAllocation: "demain" })).toBe(false);
  });
});

describe("routes et spec", () => {
  const spec = buildSpec() as any;
  const codes = (id: string) => Object.keys(routes.find((r) => r.operationId === id)!.responses).map(Number);
  it("récapitulatif en GET (lecture seule), exécution en POST ; statuts documentés", () => {
    expect(routes.find((r) => r.operationId === "getTeamRemovalSummary")!.method).toBe("get");
    expect(routes.find((r) => r.operationId === "removeFromTeam")!.method).toBe("post");
    expect(codes("getTeamRemovalSummary")).toEqual([200, 401, 403, 404, 500]);
    expect(codes("removeFromTeam")).toEqual([200, 400, 401, 403, 404, 409, 428, 500]);
  });
  it("les deux ids sont en chemin ; pas de DELETE (la confirmation voyage dans un corps)", () => {
    const p = spec.paths["/api/v1/projects/{projectId}/team/{personId}/removal"].post;
    expect(p.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "projectId", in: "path", required: true }),
      expect.objectContaining({ name: "personId", in: "path", required: true }),
    ]));
    expect(spec.paths["/api/v1/projects/{projectId}/team/{personId}/removal"].delete).toBeUndefined();
  });
  it("trois codes dédiés, distincts des conflits de version", () => {
    for (const c of ["TEAM_REMOVAL_CONFIRMATION_REQUIRED", "TEAM_REMOVAL_STALE_CONFIRMATION", "TEAM_REMOVAL_LOCKED_LOGS"]) expect(ErrorCode.options).toContain(c);
  });
});
