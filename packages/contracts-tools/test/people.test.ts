// Contrat d'écriture des personnes : validation des corps, absence de DELETE, aucune fuite de coût ou d'e-mail.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { PersonCreate, PersonPatch, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("PersonCreate", () => {
  it("accepte le minimum et un profil complet", () => {
    expect(ok(PersonCreate, { name: "Alice" })).toBe(true);
    expect(ok(PersonCreate, { name: "Bob", peopleType: "contractor", departmentId: "1", roleId: null, country: "FR", workDaysHours: [8, 8, 8, 8, 4, 0, 0], tags: ["front"], avatarUrl: null, active: false })).toBe(true);
  });
  it.each([
    ["nom absent", {}],
    ["nom vide", { name: "" }],
    ["nom d'espaces", { name: "   " }],
    ["type inconnu", { name: "A", peopleType: "intern" }],
    ["pays en minuscules", { name: "A", country: "fr" }],
    ["pays à 3 lettres", { name: "A", country: "FRA" }],
    ["6 jours seulement", { name: "A", workDaysHours: [8, 8, 8, 8, 8, 0] }],
    ["8 jours", { name: "A", workDaysHours: [8, 8, 8, 8, 8, 0, 0, 0] }],
    ["heures > 24", { name: "A", workDaysHours: [25, 8, 8, 8, 8, 0, 0] }],
    ["heures négatives", { name: "A", workDaysHours: [-1, 8, 8, 8, 8, 0, 0] }],
    ["étiquette vide", { name: "A", tags: [""] }],
    ["trop d'étiquettes", { name: "A", tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
    ["active non booléen", { name: "A", active: "oui" }],
  ])("refuse : %s", (_n, v) => expect(ok(PersonCreate, v)).toBe(false));
});

describe("PersonPatch", () => {
  it("accepte un sous-ensemble et les effacements par null ; refuse le corps vide", () => {
    expect(ok(PersonPatch, { active: false })).toBe(true);
    expect(ok(PersonPatch, { departmentId: null, roleId: null, country: null, avatarUrl: null })).toBe(true);
    expect(ok(PersonPatch, {})).toBe(false);
    expect(ok(PersonPatch, { name: "" })).toBe(false);
    expect(ok(PersonPatch, { workDaysHours: [1] })).toBe(false);
  });
});

describe("routes et spec", () => {
  const spec = buildSpec() as any;
  it("création et modification, pas de suppression", () => {
    const ids = routes.map((r) => r.operationId);
    expect(ids).toEqual(expect.arrayContaining(["createPerson", "updatePerson"]));
    expect(ids).not.toContain("deletePerson");
    expect(spec.paths["/api/v1/people/{id}"].delete).toBeUndefined();
    const codes = (id: string) => Object.keys(routes.find((r) => r.operationId === id)!.responses).map(Number);
    expect(codes("createPerson")).toEqual([201, 400, 401, 403, 404, 500]);
    expect(codes("updatePerson")).toEqual([200, 400, 401, 403, 404, 409, 428, 500]);
  });
  it("aucun champ de coût, de taux ou d'e-mail dans le contrat d'écriture", () => {
    const text = JSON.stringify([spec.components.schemas.PersonCreate, spec.components.schemas.PersonPatch]);
    for (const w of ["cost", "rate", "budget", "email"]) expect(text.toLowerCase()).not.toContain(w);
  });
});
