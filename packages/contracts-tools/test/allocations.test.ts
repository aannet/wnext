// Contrat d'écriture des allocations : validation des corps, en-tête If-Match, statuts documentés, absence de fuite.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { AllocationCreate, AllocationPatch, ErrorCode, IfMatchHeader, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const valid = { personId: "1", projectId: "2", startDate: "2026-03-02", endDate: "2026-03-06", load: { mode: "hours", hoursPerDay: 6 } } as const;
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("AllocationCreate", () => {
  it("accepte le minimum et un pourcentage > 100 (BR-01) jusqu'à 500 (BR-24)", () => {
    expect(ok(AllocationCreate, valid)).toBe(true);
    expect(ok(AllocationCreate, { ...valid, load: { mode: "percentage", percent: 150 } })).toBe(true);
    expect(ok(AllocationCreate, { ...valid, load: { mode: "percentage", percent: 500 } })).toBe(true);
  });
  it.each([
    ["pourcentage > 500", { ...valid, load: { mode: "percentage", percent: 501 } }],
    ["heures > 24", { ...valid, load: { mode: "hours", hoursPerDay: 25 } }],
    ["heures nulles", { ...valid, load: { mode: "hours", hoursPerDay: 0 } }],
    ["mode hours avec percent", { ...valid, load: { mode: "hours", percent: 50 } }],
    ["mode inconnu", { ...valid, load: { mode: "days", n: 1 } }],
    ["load absent", { personId: "1", projectId: "2", startDate: "2026-03-02", endDate: "2026-03-06" }],
    ["fin avant début", { ...valid, startDate: "2026-03-06", endDate: "2026-03-02" }],
    ["date invalide", { ...valid, startDate: "2026-02-30" }],
    ["répétition sans fin", { ...valid, repeatState: "weekly" }],
    ["fin de série sans répétition", { ...valid, repeatEndDate: "2026-04-01" }],
    ["fin de série avant la fin", { ...valid, repeatState: "weekly", repeatEndDate: "2026-03-03" }],
    ["statut inconnu", { ...valid, status: "draft" }],
  ])("refuse : %s", (_n, v) => expect(ok(AllocationCreate, v)).toBe(false));
  it("accepte une répétition cohérente", () => {
    expect(ok(AllocationCreate, { ...valid, repeatState: "weekly", repeatEndDate: "2026-04-30" })).toBe(true);
  });
});

describe("AllocationPatch", () => {
  it("accepte un sous-ensemble ; refuse le corps vide et des dates inversées", () => {
    expect(ok(AllocationPatch, { personId: "9" })).toBe(true);
    expect(ok(AllocationPatch, { load: { mode: "percentage", percent: 50 } })).toBe(true);
    expect(ok(AllocationPatch, { startDate: "2026-03-02", endDate: "2026-03-02" })).toBe(true);
    expect(ok(AllocationPatch, {})).toBe(false);
    expect(ok(AllocationPatch, { startDate: "2026-03-06", endDate: "2026-03-02" })).toBe(false);
    expect(ok(AllocationPatch, { load: { mode: "hours", hoursPerDay: 0 } })).toBe(false);
  });
});

describe("If-Match", () => {
  it("n'accepte que la version entre guillemets", () => {
    expect(ok(IfMatchHeader, { "If-Match": '"3"' })).toBe(true);
    for (const bad of ["3", '"x"', 'W/"3"', '""', '"3" ']) expect(ok(IfMatchHeader, { "If-Match": bad })).toBe(false);
  });
});

describe("routes et spec", () => {
  const spec = buildSpec() as any;
  it("expose création, modification et suppression avec les statuts documentés", () => {
    const codes = (id: string) => Object.keys(routes.find((r) => r.operationId === id)!.responses).map(Number);
    expect(codes("createAllocation")).toEqual([201, 400, 401, 403, 404, 500]);
    expect(codes("updateAllocation")).toEqual([200, 400, 401, 403, 404, 409, 428, 500]);
    expect(codes("deleteAllocation")).toEqual([204, 400, 401, 403, 404, 409, 428, 500]);
  });
  it("la spec porte If-Match en en-tête requis, l'id en chemin, le corps requis, et 204 sans contenu", () => {
    const patch = spec.paths["/api/v1/allocations/{id}"].patch;
    expect(patch.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", in: "path", required: true }),
      expect.objectContaining({ name: "If-Match", in: "header", required: true }),
    ]));
    expect(patch.requestBody.required).toBe(true);
    expect(spec.paths["/api/v1/allocations/{id}"].delete.responses["204"].content).toBeUndefined();
    expect(spec.paths["/api/v1/allocations"].post.requestBody.required).toBe(true);
  });
  it("les codes d'erreur de concurrence existent", () => {
    for (const c of ["VERSION_CONFLICT", "PRECONDITION_REQUIRED", "FORBIDDEN", "NOT_FOUND"]) expect(ErrorCode.options).toContain(c);
  });
  it("aucun champ de coût ou de budget n'entre dans le contrat d'écriture", () => {
    const text = JSON.stringify([spec.components.schemas.AllocationCreate, spec.components.schemas.AllocationPatch]);
    for (const w of ["cost", "rate", "budget", "email"]) expect(text.toLowerCase()).not.toContain(w);
  });
});
