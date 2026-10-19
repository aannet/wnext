// Contrat d'écriture des personnes : validation des corps, absence de DELETE, aucune fuite de coût ou d'e-mail.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { PersonCreate, PersonList, PersonListQuery, PersonPatch, PersonProject, PersonProjectList, PersonProjectListQuery, SchedulePerson, routes } from "@wnext/contracts";
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

describe("lecture des personnes", () => {
  const person = { id: "1", version: 1, name: "Alice", peopleType: "employee", departmentId: null, roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true };
  const project = { id: "2", version: 1, name: "P", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: "2026-12-31" };

  it("la liste renvoie des SchedulePerson : ni coût, ni taux, ni e-mail", () => {
    expect(ok(PersonList, { items: [person], page: { nextCursor: null, total: 1 } })).toBe(true);
    const keys = Object.keys(SchedulePerson.shape);
    expect(keys.filter((k) => /cost|rate|email|salary/i.test(k))).toEqual([]);
  });
  it("filtres : département, rôle, tag, recherche, inactifs ; bornes de page", () => {
    expect(ok(PersonListQuery, { departmentId: "1", roleId: "2", tag: "senior", search: "ali", includeInactive: true, limit: 50 })).toBe(true);
    for (const q of [{ search: "" }, { search: "   " }, { search: "x".repeat(201) }, { tag: "" }, { includeInactive: "true" }, { limit: 501 }, { departmentId: "" }]) {
      expect(ok(PersonListQuery, q), JSON.stringify(q)).toBe(false);
    }
  });
  it("projets d'une personne : projet au format du Schedule, inTeam, allocationCount", () => {
    const item = { project, inTeam: true, allocationCount: 3 };
    expect(ok(PersonProject, item)).toBe(true);
    expect(ok(PersonProject, { ...item, allocationCount: -1 })).toBe(false);
    expect(ok(PersonProject, { project, inTeam: true })).toBe(false);
    expect(ok(PersonProjectList, { items: [item], page: { nextCursor: null, total: 1 } })).toBe(true);
    expect(ok(PersonProjectListQuery, { status: "archived" })).toBe(true);
    expect(ok(PersonProjectListQuery, { status: "active" })).toBe(false);
  });
  it("routes : liste, lecture, projets ; lecture seule, sans corps", () => {
    const get = (id: string) => routes.find((r) => r.operationId === id)!;
    expect([get("listPeople").method, get("listPeople").path]).toEqual(["get", "/api/v1/people"]);
    expect([get("getPerson").method, get("getPerson").path]).toEqual(["get", "/api/v1/people/{id}"]);
    expect([get("listPersonProjects").method, get("listPersonProjects").path]).toEqual(["get", "/api/v1/people/{id}/projects"]);
    for (const id of ["listPeople", "getPerson", "listPersonProjects"]) {
      expect(get(id).body).toBeUndefined();
      expect(get(id).responses[403]).toBeUndefined(); // lecture ouverte à tout membre
    }
    expect(get("getPerson").responses[404]).toBeDefined();
  });
  it("la spec garde l'écriture existante sur les mêmes chemins", () => {
    const spec = buildSpec() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(spec.paths["/api/v1/people"]!).sort()).toEqual(["get", "post"]);
    expect(Object.keys(spec.paths["/api/v1/people/{id}"]!).sort()).toEqual(["get", "patch"]);
    expect(Object.keys(spec.paths["/api/v1/people/{id}/projects"]!)).toEqual(["get"]);
  });
});
