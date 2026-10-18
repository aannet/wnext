// Contrat d'écriture des congés : validation des corps (miroir des CHECK de schema.sql), statuts documentés, absence de fuite.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { ErrorCode, TimeoffCreate, TimeoffPatch, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const valid = { personId: "1", typeId: "2", startDate: "2026-03-02", endDate: "2026-03-06" } as const;
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("TimeoffCreate", () => {
  it("accepte le minimum, des demi-journées et un congé partiel", () => {
    expect(ok(TimeoffCreate, valid)).toBe(true);
    expect(ok(TimeoffCreate, { ...valid, startHalf: "pm", endHalf: "am" })).toBe(true); // lundi après-midi -> vendredi matin
    expect(ok(TimeoffCreate, { ...valid, startDate: "2026-03-02", endDate: "2026-03-02", startHalf: "am", endHalf: "am" })).toBe(true);
    expect(ok(TimeoffCreate, { ...valid, scope: "partial", hoursPerDay: 3 })).toBe(true);
  });
  it.each([
    ["fin avant début", { ...valid, startDate: "2026-03-06", endDate: "2026-03-02" }],
    ["partiel sans heures", { ...valid, scope: "partial" }],
    ["heures sans partiel", { ...valid, hoursPerDay: 3 }],
    ["heures nulles", { ...valid, scope: "partial", hoursPerDay: 0 }],
    ["heures > 24", { ...valid, scope: "partial", hoursPerDay: 25 }],
    ["partiel avec demi-journée", { ...valid, scope: "partial", hoursPerDay: 3, startHalf: "pm" }],
    ["un jour, après-midi puis matin", { ...valid, endDate: "2026-03-02", startHalf: "pm", endHalf: "am" }],
    ["statut inconnu", { ...valid, approvalStatus: "maybe" }],
    ["moitié inconnue", { ...valid, startHalf: "noon" }],
    ["date invalide", { ...valid, startDate: "2026-02-30" }],
    ["personne absente", { typeId: "2", startDate: "2026-03-02", endDate: "2026-03-02" }],
  ])("refuse : %s", (_n, v) => expect(ok(TimeoffCreate, v)).toBe(false));
});

describe("TimeoffPatch", () => {
  it("accepte un sous-ensemble ; refuse le corps vide et des dates inversées", () => {
    expect(ok(TimeoffPatch, { approvalStatus: "approved" })).toBe(true);
    expect(ok(TimeoffPatch, { notes: null })).toBe(true);
    expect(ok(TimeoffPatch, {})).toBe(false);
    expect(ok(TimeoffPatch, { startDate: "2026-03-06", endDate: "2026-03-02" })).toBe(false);
    expect(ok(TimeoffPatch, { hoursPerDay: 0 })).toBe(false);
  });
});

describe("routes et spec", () => {
  const spec = buildSpec() as any;
  it("expose création, modification et suppression avec les statuts documentés", () => {
    const codes = (id: string) => Object.keys(routes.find((r) => r.operationId === id)!.responses).map(Number);
    expect(codes("createTimeoff")).toEqual([201, 400, 401, 403, 404, 409, 500]);
    expect(codes("updateTimeoff")).toEqual([200, 400, 401, 403, 404, 409, 428, 500]);
    expect(codes("deleteTimeoff")).toEqual([204, 400, 401, 403, 404, 409, 428, 500]);
  });
  it("la spec porte If-Match, l'id en chemin, et 204 sans contenu", () => {
    const patch = spec.paths["/api/v1/timeoffs/{id}"].patch;
    expect(patch.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", in: "path", required: true }),
      expect.objectContaining({ name: "If-Match", in: "header", required: true }),
    ]));
    expect(spec.paths["/api/v1/timeoffs/{id}"].delete.responses["204"].content).toBeUndefined();
  });
  it("le chevauchement a son propre code, distinct du conflit de version", () => {
    expect(ErrorCode.options).toContain("TIMEOFF_OVERLAP");
  });
  it("aucun champ de coût ou de budget dans le contrat d'écriture", () => {
    const text = JSON.stringify([spec.components.schemas.TimeoffCreate, spec.components.schemas.TimeoffPatch]);
    for (const w of ["cost", "rate", "budget", "email"]) expect(text.toLowerCase()).not.toContain(w);
  });
});
