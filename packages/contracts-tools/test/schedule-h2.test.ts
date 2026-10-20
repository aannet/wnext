// Lot H2 : GET /schedule porte l'horaire daté (BR-19) et les phases (BR-37), champs optionnels ; écarts Schemathesis E-04
// (corps facultatif) et E-05 (404 documenté sur GET /logged-time).
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { SchedulePerson, SchedulePhase, ScheduleResponse } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec = buildSpec() as any;
const person = {
  id: "1", version: 1, name: "A", peopleType: "employee", departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
};

describe("GET /schedule : horaire daté (@BR-19) et phases (@BR-37)", () => {
  it("workSchedule est optionnel et valide des périodes bornées ou ouvertes", () => {
    expect(SchedulePerson.safeParse(person).success).toBe(true);
    const workSchedule = [
      { validFrom: null, validTo: "2026-03-31", workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
      { validFrom: "2026-04-01", validTo: null, workDaysHours: [4, 4, 4, 4, 4, 0, 0] },
    ];
    expect(SchedulePerson.safeParse({ ...person, workSchedule }).success).toBe(true);
    expect(SchedulePerson.safeParse({ ...person, workSchedule: [{ validFrom: null, validTo: null, workDaysHours: [8] }] }).success).toBe(false);
  });
  it("une phase porte projet, dates (null = non bornée) et couleur facultative", () => {
    expect(SchedulePhase.safeParse({ id: "1", version: 1, projectId: "2", name: "Cadrage", startDate: "2026-03-01", endDate: null, color: null }).success).toBe(true);
    expect(SchedulePhase.safeParse({ id: "1", version: 1, projectId: "2", name: "Cadrage", startDate: "x", endDate: null, color: null }).success).toBe(false);
  });
  it("les deux champs sont optionnels dans la spec (ajout non cassant)", () => {
    expect(spec.components.schemas.SchedulePerson.required).not.toContain("workSchedule");
    expect(spec.components.schemas.ScheduleResponse.required).not.toContain("phases");
    expect(spec.components.schemas.ScheduleResponse.properties.phases.items.$ref).toBe("#/components/schemas/SchedulePhase");
    expect(ScheduleResponse.shape.phases.safeParse(undefined).success).toBe(true);
  });
});

describe("écarts Schemathesis", () => {
  it("E-04 : corps facultatif pour la désactivation et le retrait d'équipe, requis ailleurs", () => {
    expect(spec.paths["/api/v1/people/{id}/deactivation"].post.requestBody.required).toBe(false);
    expect(spec.paths["/api/v1/projects/{projectId}/team/{personId}/removal"].post.requestBody.required).toBe(false);
    expect(spec.paths["/api/v1/allocations"].post.requestBody.required).toBe(true);
  });
  it("E-05 : GET /logged-time documente 404 (personne inconnue)", () => {
    expect(spec.paths["/api/v1/logged-time"].get.responses["404"].content["application/json"].schema.$ref).toBe("#/components/schemas/ApiError");
  });
});
