// Contrat des entités de référence : départements, rôles, types de congé, jours fériés, projets.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import {
  DepartmentCreate, DepartmentPatch, ErrorCode, HolidayCreate, HolidayPatch, ProjectCreate, ProjectDetail, ProjectPatch,
  ScheduleDepartment, ScheduleHoliday, ScheduleProject, ScheduleRole, ScheduleTimeoffType, TimeoffTypeCreate, TimeoffTypePatch, routes,
} from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("noms (départements, rôles, types de congé)", () => {
  it("nom non vide, borné ; le patch exige au moins un champ", () => {
    expect(ok(DepartmentCreate, { name: "Design" })).toBe(true);
    for (const v of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(201) }]) expect(ok(DepartmentCreate, v)).toBe(false);
    expect(ok(DepartmentPatch, {})).toBe(false);
    expect(ok(DepartmentPatch, { name: "Dev" })).toBe(true);
  });
  it("type de congé : deducted optionnel booléen", () => {
    expect(ok(TimeoffTypeCreate, { name: "Maladie", deducted: false })).toBe(true);
    expect(ok(TimeoffTypeCreate, { name: "Maladie", deducted: "oui" })).toBe(false);
    expect(ok(TimeoffTypePatch, {})).toBe(false);
  });
});

describe("jours fériés", () => {
  const h = { name: "Noël", date: "2026-12-25" };
  it("minimum : nom et date ; pays ISO majuscules ; heures dans (0, 24]", () => {
    expect(ok(HolidayCreate, h)).toBe(true);
    expect(ok(HolidayCreate, { ...h, country: "FR", departmentId: "3", hoursOff: 4 })).toBe(true);
    expect(ok(HolidayCreate, { ...h, country: null, departmentId: null, hoursOff: null })).toBe(true);
    for (const bad of [{ country: "fr" }, { country: "FRA" }, { hoursOff: 0 }, { hoursOff: 25 }, { date: "demain" }]) expect(ok(HolidayCreate, { ...h, ...bad })).toBe(false);
    expect(ok(HolidayPatch, {})).toBe(false);
    expect(ok(HolidayPatch, { hoursOff: null })).toBe(true);
  });
});

describe("projets", () => {
  it("minimum : un nom ; couleur hexadécimale ; statut du Schedule ; fin >= début", () => {
    expect(ok(ProjectCreate, { name: "Site" })).toBe(true);
    expect(ok(ProjectCreate, { name: "Site", color: "#aBc123", status: "archived", startDate: "2026-01-01", endDate: "2026-01-01", projectManagerId: "2", tags: ["a"], notes: null, projectCode: "J-1", nonBillable: true })).toBe(true);
    for (const bad of [{ color: "rouge" }, { color: "#12345" }, { status: "done" }, { startDate: "2026-02-01", endDate: "2026-01-01" }, { tags: [""] }, { projectCode: "  " }]) expect(ok(ProjectCreate, { name: "Site", ...bad })).toBe(false);
    expect(ok(ProjectPatch, {})).toBe(false);
    expect(ok(ProjectPatch, { endDate: null })).toBe(true);
    expect(ok(ProjectPatch, { startDate: "2026-02-01", endDate: "2026-01-01" })).toBe(false);
  });
  it("ProjectDetail étend ScheduleProject (même version, mêmes champs de grille)", () => {
    const p = { id: "1", version: 1, name: "P", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false };
    expect(ok(ScheduleProject, p)).toBe(true);
    expect(ok(ProjectDetail, p)).toBe(false);
    expect(ok(ProjectDetail, { ...p, startDate: null, endDate: null, projectManagerId: null, tags: [], notes: null })).toBe(true);
  });
});

describe("version sur les listes de référence du Schedule", () => {
  it.each([
    ["département", ScheduleDepartment, { id: "1", name: "D" }],
    ["rôle", ScheduleRole, { id: "1", name: "R" }],
    ["type de congé", ScheduleTimeoffType, { id: "1", name: "V", deducted: true }],
    ["jour férié", ScheduleHoliday, { id: "1", name: "N", date: "2026-12-25", country: null, departmentId: null, hoursOff: null }],
  ])("%s : version obligatoire (verrou optimiste)", (_n, schema, v) => {
    expect(ok(schema, v)).toBe(false);
    expect(ok(schema, { ...v, version: 1 })).toBe(true);
  });
});

describe("routes et codes", () => {
  const spec = buildSpec() as any;
  const byId = (id: string) => routes.find((r) => r.operationId === id)!;
  const set = [["Department", "departments"], ["Role", "roles"], ["TimeoffType", "timeoff-types"], ["Holiday", "holidays"]] as const;
  it.each(set)("%s : POST, PATCH et DELETE avec If-Match, 409 documenté", (name, path) => {
    expect(byId(`create${name}`)).toMatchObject({ method: "post", path: `/api/v1/${path}` });
    expect(byId(`update${name}`)).toMatchObject({ method: "patch", path: `/api/v1/${path}/{id}` });
    expect(byId(`delete${name}`)).toMatchObject({ method: "delete", path: `/api/v1/${path}/{id}` });
    expect(Object.keys(byId(`delete${name}`).responses).map(Number)).toEqual([204, 400, 401, 403, 404, 409, 428, 500]);
    expect(spec.paths[`/api/v1/${path}/{id}`].patch.parameters.some((p: any) => p.name === "If-Match")).toBe(true);
  });
  it("projets : création et modification, jamais de suppression (archivage)", () => {
    expect(byId("createProject").method).toBe("post");
    expect(byId("updateProject").method).toBe("patch");
    expect(routes.find((r) => r.operationId === "deleteProject")).toBeUndefined();
    expect(spec.paths["/api/v1/projects/{id}"].delete).toBeUndefined();
  });
  it("deux nouveaux codes d'erreur, stables", () => {
    for (const c of ["ALREADY_EXISTS", "REFERENCE_IN_USE"]) expect(ok(ErrorCode, c)).toBe(true);
  });
});
