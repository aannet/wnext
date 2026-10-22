import type { Client, Me, ProjectDetail } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { canEditProjects, diffOf, errorKey, filterProjects, inputOf, NO_CLIENT, NO_FILTERS, scheduleProjectOf, validateForm, valuesOf, type FormValues } from "../src/projects/projects-model";

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "1", version: 1, name: "Refonte Site", projectCode: "WEB-1", color: "#3B82F6", status: "planned", nonBillable: false,
  startDate: null, endDate: null, projectManagerId: null, managerUserIds: [], clientId: null, tags: [], notes: null, ...over,
});
const clients: Client[] = [{ id: "c1", version: 1, name: "Acme", shortName: null, tags: [] }];

describe("filterProjects", () => {
  const list = [
    project({ id: "1", name: "Refonte Site", projectCode: "WEB-1", clientId: "c1" }),
    project({ id: "2", name: "Étude préalable", projectCode: null }),
    project({ id: "3", name: "Ancien portail", status: "archived" }),
    project({ id: "4", name: "Application mobile", projectCode: "MOB-7", status: "in_progress", clientId: "c1" }),
  ];
  const names = (f: Partial<typeof NO_FILTERS>) => filterProjects(list, { ...NO_FILTERS, ...f }).map((p) => p.name);

  it("masque les archivés par défaut et trie par nom", () => {
    expect(names({})).toEqual(["Application mobile", "Étude préalable", "Refonte Site"]);
  });
  it("le filtre de statut archivé les montre", () => {
    expect(names({ status: "archived" })).toEqual(["Ancien portail"]);
  });
  it("recherche par nom ou par code, sans tenir compte de la casse ni des accents", () => {
    expect(names({ search: "etude" })).toEqual(["Étude préalable"]);
    expect(names({ search: "mob-7" })).toEqual(["Application mobile"]);
  });
  it("filtre par client, y compris « sans client »", () => {
    expect(names({ clientId: "c1" })).toEqual(["Application mobile", "Refonte Site"]);
    expect(names({ clientId: NO_CLIENT })).toEqual(["Étude préalable"]);
  });
});

describe("validateForm (US-2.1)", () => {
  const base: FormValues = { ...valuesOf(project({ projectCode: null })), name: "Nouveau", projectCode: "" };
  it("accepte un formulaire valide", () => {
    expect(validateForm(base, [], clients)).toEqual({});
  });
  it("refuse un nom vide", () => {
    expect(validateForm({ ...base, name: "  " }, [], clients).name).toBe("projects.form.error.name");
  });
  it("refuse un code projet déjà pris", () => {
    expect(validateForm({ ...base, projectCode: "WEB-1" }, [project()], clients).projectCode).toBe("projects.form.error.code_taken");
    expect(validateForm({ ...base, projectCode: "WEB-2" }, [project()], clients).projectCode).toBeUndefined();
  });
  it("refuse une fin antérieure au début, accepte l'égalité", () => {
    expect(validateForm({ ...base, startDate: "2026-03-10", endDate: "2026-03-09" }, [], clients).endDate).toBe("projects.form.error.dates");
    expect(validateForm({ ...base, startDate: "2026-03-10", endDate: "2026-03-10" }, [], clients).endDate).toBeUndefined();
  });
  it("refuse une couleur qui n'est pas #RRGGBB", () => {
    expect(validateForm({ ...base, color: "bleu" }, [], clients).color).toBe("projects.form.error.color");
    expect(validateForm({ ...base, color: "#abc" }, [], clients).color).toBe("projects.form.error.color");
  });
  it("refuse un nouveau client qui porte le nom d'un client existant", () => {
    expect(validateForm({ ...base, newClientName: " acme " }, [], clients).newClientName).toBe("projects.form.error.client_exists");
    expect(validateForm({ ...base, newClientName: "Acme 2" }, [], clients).newClientName).toBeUndefined();
    expect(validateForm({ ...base, newClientName: "ACME" }, [], clients).newClientName).toBe("projects.form.error.client_exists");
  });
});

describe("corps d'écriture", () => {
  it("inputOf normalise : espaces retirés, code vide = null, couleur en majuscules", () => {
    const v: FormValues = { ...valuesOf(project()), name: "  X  ", projectCode: " ", color: "#aabbcc", startDate: "" };
    expect(inputOf(v, "c1")).toMatchObject({ name: "X", projectCode: null, color: "#AABBCC", startDate: null, clientId: "c1" });
  });
  it("diffOf n'envoie que les champs modifiés (casse de la couleur ignorée)", () => {
    const p = project();
    expect(diffOf(p, valuesOf(p), null)).toEqual({});
    expect(diffOf(p, { ...valuesOf(p), color: "#3b82f6" }, null)).toEqual({});
    expect(diffOf(p, { ...valuesOf(p), color: "#112233", name: "Autre" }, null)).toEqual({ color: "#112233", name: "Autre" });
    expect(diffOf(p, valuesOf(p), "c1")).toEqual({ clientId: "c1" });
  });
});

describe("errorKey : erreurs de l'API traduites", () => {
  const e = (code: string, params: Record<string, string | number | boolean> = {}) => errorKey({ code: code as never, params });
  it("code projet en double", () => expect(e("ALREADY_EXISTS", { entity: "project", field: "projectCode" })).toBe("projects.error.code_taken"));
  it("403 de périmètre (BR-33) distinct du 403 général", () => {
    expect(e("FORBIDDEN", { scope: "project" })).toBe("projects.error.forbidden_project");
    expect(e("FORBIDDEN")).toBe("projects.error.forbidden");
  });
  it("conflit de version, dates, référence utilisée, inconnu", () => {
    expect(e("VERSION_CONFLICT", { currentVersion: 3 })).toBe("projects.error.conflict");
    expect(e("VALIDATION_FAILED", { field: "endDate" })).toBe("projects.form.error.dates");
    expect(e("REFERENCE_IN_USE")).toBe("projects.error.in_use");
    expect(e("INTERNAL_ERROR")).toBe("projects.error.other");
  });
});

describe("droits d'écriture", () => {
  const me = (role: Me["role"]) => ({ role }) as Me;
  it("owner, admin et project_manager écrivent ; member et guest lisent", () => {
    expect(["owner", "admin", "project_manager"].map((r) => canEditProjects(me(r as Me["role"])))).toEqual([true, true, true]);
    expect(["member", "guest"].map((r) => canEditProjects(me(r as Me["role"])))).toEqual([false, false]);
  });
});

it("scheduleProjectOf garde la forme de la grille (sans les champs du détail)", () => {
  expect(scheduleProjectOf(project({ color: "#112233" }))).toEqual({
    id: "1", version: 1, name: "Refonte Site", projectCode: "WEB-1", color: "#112233", status: "planned", nonBillable: false, startDate: null, endDate: null,
  });
});
