// Contrat des entités de référence : départements, rôles, types de congé, jours fériés, projets.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import {
  DepartmentCreate, DepartmentList, DepartmentPatch, ErrorCode, HolidayCreate, HolidayListQuery, HolidayPatch, ProjectCreate, ProjectList, ProjectListQuery, ReferenceListQuery, ProjectDetail, ProjectPatch,
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
    const p = { id: "1", version: 1, name: "P", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null };
    expect(ok(ScheduleProject, p)).toBe(true);
    expect(ok(ScheduleProject, { ...p, startDate: undefined })).toBe(false); // bornes toujours présentes (BR-37 côté client)
    expect(ok(ProjectDetail, p)).toBe(false);
    expect(ok(ProjectDetail, { ...p, projectManagerId: null, clientId: null, tags: [], notes: null, managerUserIds: [] })).toBe(true);
  });
  it("ProjectDetail : managerUserIds (user_id des co-gestionnaires) requis, liste vide possible, ids non vides (RT-039)", () => {
    const d = { id: "1", version: 1, name: "P", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null, projectManagerId: "7", clientId: null, tags: [], notes: null };
    expect(ok(ProjectDetail, d)).toBe(false);
    expect(ok(ProjectDetail, { ...d, managerUserIds: ["3", "12"] })).toBe(true);
    expect(ok(ProjectDetail, { ...d, managerUserIds: [""] })).toBe(false);
    expect(ok(ProjectDetail, { ...d, managerUserIds: null })).toBe(false);
    expect(ok(ScheduleProject, { ...d, managerUserIds: ["3"] })).toBe(true); // la grille ne le porte pas (champ ignoré)
    expect(Object.keys(ScheduleProject.shape)).not.toContain("managerUserIds");
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

describe("lecture", () => {
  it("requêtes de liste : limite 1..500, curseur non vide, filtres typés, rien d'autre", () => {
    expect(ok(ReferenceListQuery, {})).toBe(true);
    expect(ok(ReferenceListQuery, { limit: 500, cursor: "abc" })).toBe(true);
    for (const v of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { cursor: "" }]) expect(ok(ReferenceListQuery, v)).toBe(false);
    expect(ok(HolidayListQuery, { from: "2026-01-01", to: "2026-12-31" })).toBe(true);
    expect(ok(HolidayListQuery, { from: "2026-12-31", to: "2026-01-01" })).toBe(false);
    expect(ok(HolidayListQuery, { from: "demain" })).toBe(false);
    expect(ok(ProjectListQuery, { status: "archived" })).toBe(true);
    expect(ok(ProjectListQuery, { status: "perdu" })).toBe(false);
  });
  it("page : items + page.nextCursor/total ; les projets sont listés en détail", () => {
    const page = { nextCursor: null, total: 1 };
    expect(ok(DepartmentList, { items: [{ id: "1", version: 1, name: "Design" }], page })).toBe(true);
    expect(ok(DepartmentList, { items: [{ id: "1", name: "Design" }], page })).toBe(false); // version requise
    expect(ok(ProjectList, { items: [{ id: "1", version: 1, name: "P", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false }], page })).toBe(false); // détail incomplet
  });
  it("routes : liste et lecture par id pour les cinq entités, ouvertes à tout membre (pas de 403)", () => {
    for (const [path, plural] of [["departments", "Departments"], ["roles", "Roles"], ["timeoff-types", "TimeoffTypes"], ["holidays", "Holidays"], ["projects", "Projects"]]) {
      const list = routes.find((r) => r.method === "get" && r.path === `/api/v1/${path}`);
      const one = routes.find((r) => r.method === "get" && r.path === `/api/v1/${path}/{id}`);
      expect(list?.operationId).toBe(`list${plural}`);
      expect(one?.operationId).toMatch(/^get/);
      expect(Object.keys(list!.responses).map(Number)).not.toContain(403);
      expect(Object.keys(one!.responses).map(Number)).toEqual(expect.arrayContaining([200, 401, 404]));
    }
  });
});
