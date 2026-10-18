// Contrat du retrait d'équipe (BR-10) : récapitulatif puis confirmation, codes dédiés, aucune écriture à la lecture.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { ErrorCode, ReferenceListQuery, TEAM_BATCH_MAX, TeamBatchAdd, TeamBatchResult, TeamMember, TeamMemberList, TeamMembership, TeamProjectPathParams, TeamRemovalRequest, TeamRemovalSummary, routes } from "@wnext/contracts";
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

describe("addToTeam (PUT)", () => {
  const route = routes.find((r) => r.operationId === "addToTeam")!;
  it("PUT idempotent sans corps, mêmes statuts d'accès que le retrait", () => {
    expect(route.method).toBe("put");
    expect(route.path).toBe("/api/v1/projects/{projectId}/team/{personId}");
    expect(route.body).toBeUndefined();
    expect(Object.keys(route.responses).map(Number)).toEqual([200, 401, 403, 404, 500]);
  });
  it("TeamMembership : added booléen obligatoire", () => {
    expect(ok(TeamMembership, { added: false })).toBe(true);
    expect(ok(TeamMembership, {})).toBe(false);
  });
  it("présent dans la spec avec ses deux ids en chemin", () => {
    const op = (buildSpec() as any).paths["/api/v1/projects/{projectId}/team/{personId}"].put;
    expect(op.operationId).toBe("addToTeam");
    expect(op.parameters.map((p: any) => p.name).sort()).toEqual(["personId", "projectId"]);
  });
});

describe("lecture de l'équipe", () => {
  const member = { personId: "4", name: "Alice" };
  it("un membre = identité de la personne ; page au format commun", () => {
    expect(ok(TeamMember, member)).toBe(true);
    expect(ok(TeamMember, { personId: "4" })).toBe(false);
    expect(ok(TeamMemberList, { items: [member], page: { nextCursor: null, total: 1 } })).toBe(true);
    expect(ok(TeamMemberList, { items: [], page: { nextCursor: null, total: 0 } })).toBe(true); // équipe vide = liste vide
    expect(ok(TeamMemberList, { items: [member] })).toBe(false);
  });
  it("route GET /projects/{projectId}/team : projet en chemin, pagination en requête, 404 projet", () => {
    const r = routes.find((x) => x.operationId === "listProjectTeam")!;
    expect([r.method, r.path]).toEqual(["get", "/api/v1/projects/{projectId}/team"]);
    expect(r.params).toBe(TeamProjectPathParams);
    expect(r.query).toBe(ReferenceListQuery);
    expect(Object.keys(r.responses).map(Number).sort()).toEqual([200, 400, 401, 404, 500]);
    expect(r.responses[403]).toBeUndefined(); // lecture ouverte à tout membre
  });
  it("la spec OpenAPI la décrit sans collision avec les routes d'écriture de l'équipe", () => {
    const spec = buildSpec() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(spec.paths["/api/v1/projects/{projectId}/team"]!)).toContain("get");
    expect(Object.keys(spec.paths["/api/v1/projects/{projectId}/team/{personId}"]!)).toEqual(["put"]);
  });
});

describe("ajout en lot", () => {
  it("corps : 1 à 500 identifiants distincts", () => {
    expect(ok(TeamBatchAdd, { personIds: ["1"] })).toBe(true);
    expect(ok(TeamBatchAdd, { personIds: Array.from({ length: TEAM_BATCH_MAX }, (_, i) => String(i + 1)) })).toBe(true);
    for (const b of [{}, { personIds: [] }, { personIds: ["1", "1"] }, { personIds: [""] }, { personIds: [1] }, { personIds: Array.from({ length: TEAM_BATCH_MAX + 1 }, (_, i) => String(i + 1)) }]) {
      expect(ok(TeamBatchAdd, b), JSON.stringify(b).slice(0, 40)).toBe(false);
    }
  });
  it("le doublon est signalé sur le champ personIds", () => {
    const r = TeamBatchAdd.safeParse({ personIds: ["1", "1"] });
    expect(!r.success && r.error.issues[0]!.path).toEqual(["personIds"]);
  });
  it("résultat : deux listes", () => {
    expect(ok(TeamBatchResult, { added: ["1"], alreadyInTeam: [] })).toBe(true);
    expect(ok(TeamBatchResult, { added: ["1"] })).toBe(false);
  });
  it("route POST /projects/{projectId}/team : corps, 200, 400, 401, 403, 404", () => {
    const r = routes.find((x) => x.operationId === "addManyToTeam")!;
    expect([r.method, r.path, r.body]).toEqual(["post", "/api/v1/projects/{projectId}/team", TeamBatchAdd]);
    expect(Object.keys(r.responses).map(Number).sort()).toEqual([200, 400, 401, 403, 404, 500]);
  });
  it("la spec porte GET et POST sur le même chemin", () => {
    const spec = buildSpec() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(spec.paths["/api/v1/projects/{projectId}/team"]!).sort()).toEqual(["get", "post"]);
  });
});
