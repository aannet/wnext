// Contrat d'écriture des allocations : validation des corps, en-tête If-Match, statuts documentés, absence de fuite.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { AllocationCreate, AllocationPatch, ErrorCode, IfMatchHeader, PersonAllocationList, PersonAllocationListQuery, PersonPathParams, ProjectAllocationList, ProjectAllocationListQuery, ProjectPathParams, routes } from "@wnext/contracts";
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

describe("lecture des allocations", () => {
  const alloc = { id: "1", version: 1, personId: "2", projectId: "3", phaseId: null, taskId: null, groupId: null, name: null, notes: null, startDate: "2026-03-02", endDate: "2026-03-06", status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 8, percent: null };
  it("fenêtre obligatoire ; filtres personne et statut ; bornes de page", () => {
    const q = { from: "2026-03-02", to: "2026-03-06" };
    expect(ok(ProjectAllocationListQuery, q)).toBe(true);
    expect(ok(ProjectAllocationListQuery, { ...q, personId: "4", status: "tentative", limit: 10 })).toBe(true);
    for (const b of [{}, { from: "2026-03-02" }, { to: "2026-03-06" }, { ...q, from: "demain" }, { ...q, status: "draft" }, { ...q, personId: "" }, { ...q, limit: 0 }]) {
      expect(ok(ProjectAllocationListQuery, b), JSON.stringify(b)).toBe(false);
    }
  });
  it("la page renvoie des ScheduleAllocation (mêmes champs que le Schedule)", () => {
    expect(ok(ProjectAllocationList, { items: [alloc], page: { nextCursor: null, total: 1 } })).toBe(true);
    expect(ok(ProjectAllocationList, { items: [{ ...alloc, mode: "percentage", hoursPerDay: null, percent: 50 }], page: { nextCursor: null, total: 1 } })).toBe(true);
    expect(ok(ProjectAllocationList, { items: [{ ...alloc, percent: 50 }], page: { nextCursor: null, total: 1 } })).toBe(false); // le mode impose son champ
  });
  it("routes : lecture par id et liste d'un projet, sans corps, ouvertes à tout membre", () => {
    const one = routes.find((r) => r.operationId === "getAllocation")!;
    const list = routes.find((r) => r.operationId === "listProjectAllocations")!;
    expect([one.method, one.path]).toEqual(["get", "/api/v1/allocations/{id}"]);
    expect([list.method, list.path, list.params, list.query]).toEqual(["get", "/api/v1/projects/{projectId}/allocations", ProjectPathParams, ProjectAllocationListQuery]);
    for (const r of [one, list]) {
      expect(r.body).toBeUndefined();
      expect(r.responses[403]).toBeUndefined();
      expect(r.responses[404]).toBeDefined();
    }
    expect(list.responses[400]).toBeDefined();
  });
  it("la spec garde l'écriture sur le même chemin", () => {
    const spec = buildSpec() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(spec.paths["/api/v1/allocations/{id}"]!).sort()).toEqual(["delete", "get", "patch"]);
  });
});

describe("lecture des allocations d'une personne", () => {
  const alloc = { id: "1", version: 1, personId: "2", projectId: "3", phaseId: null, taskId: null, groupId: null, name: null, notes: null, startDate: "2026-03-02", endDate: "2026-03-06", status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 8, percent: null };
  it("fenêtre obligatoire ; filtres projet et statut", () => {
    const q = { from: "2026-03-02", to: "2026-03-06" };
    expect(ok(PersonAllocationListQuery, q)).toBe(true);
    expect(ok(PersonAllocationListQuery, { ...q, projectId: "4", status: "confirmed", limit: 10 })).toBe(true);
    for (const b of [{}, { from: "2026-03-02" }, { to: "2026-03-06" }, { ...q, status: "draft" }, { ...q, projectId: "" }, { ...q, limit: 501 }]) {
      expect(ok(PersonAllocationListQuery, b), JSON.stringify(b)).toBe(false);
    }
  });
  it("la page renvoie des ScheduleAllocation", () => {
    expect(ok(PersonAllocationList, { items: [alloc], page: { nextCursor: null, total: 1 } })).toBe(true);
    expect(ok(PersonAllocationList, { items: [{ ...alloc, percent: 50 }], page: { nextCursor: null, total: 1 } })).toBe(false);
  });
  it("route : lecture seule, ouverte à tout membre", () => {
    const r = routes.find((x) => x.operationId === "listPersonAllocations")!;
    expect([r.method, r.path, r.params, r.query]).toEqual(["get", "/api/v1/people/{id}/allocations", PersonPathParams, PersonAllocationListQuery]);
    expect(r.body).toBeUndefined();
    expect(r.responses[403]).toBeUndefined();
    expect(r.responses[404]).toBeDefined();
    expect(r.responses[400]).toBeDefined();
  });
});
