// Contrat des clients, phases et tâches de projet.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import {
  Client, ClientCreate, ClientPatch, Phase, PhaseCreate, PhaseList, PhaseListQuery, PhasePatch, ProjectTask, ProjectTaskCreate, ProjectTaskListQuery, ProjectTaskPatch, Milestone, MilestoneCreate, MilestoneList, MilestoneListQuery, MilestonePatch, routes,
} from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("clients", () => {
  it("nom obligatoire, nom court et étiquettes facultatifs, patch non vide", () => {
    expect(ok(ClientCreate, { name: "ACME" })).toBe(true);
    expect(ok(ClientCreate, { name: "ACME", shortName: null, tags: ["vip"] })).toBe(true);
    for (const v of [{}, { name: " " }, { name: "A", shortName: "" }, { name: "A", tags: [""] }]) expect(ok(ClientCreate, v)).toBe(false);
    expect(ok(ClientPatch, {})).toBe(false);
    expect(ok(ClientPatch, { shortName: null })).toBe(true);
  });
  it("forme lue", () => expect(ok(Client, { id: "1", version: 1, name: "A", shortName: null, tags: [] })).toBe(true));
});

describe("phases", () => {
  const p = { projectId: "1", name: "Cadrage" };
  it("création : projet et nom obligatoires ; dates ordonnées ; statut du contrat ; position bornée", () => {
    expect(ok(PhaseCreate, p)).toBe(true);
    expect(ok(PhaseCreate, { ...p, startDate: "2026-03-02", endDate: "2026-03-06", status: "in_progress", color: "#112233", position: 0, notes: null })).toBe(true);
    for (const v of [
      { name: "x" }, { projectId: "1" }, { ...p, startDate: "2026-03-06", endDate: "2026-03-02" }, { ...p, status: "active" }, { ...p, color: "rouge" },
      { ...p, position: -1 }, { ...p, position: 32768 }, { ...p, position: 1.5 },
    ]) expect(ok(PhaseCreate, v)).toBe(false);
  });
  it("le projet d'une phase est immuable : absent du patch (champ ignoré par zod, jamais lu par l'API)", () => {
    expect(ok(PhasePatch, { projectId: "2", name: "x" })).toBe(true);
    expect("projectId" in PhasePatch.parse({ projectId: "2", name: "x" })).toBe(false);
    expect(ok(PhasePatch, {})).toBe(false);
    expect(ok(PhasePatch, { startDate: "2026-03-06", endDate: "2026-03-02" })).toBe(false);
  });
  it("filtre projectId et page", () => {
    expect(ok(PhaseListQuery, { projectId: "3", limit: 10 })).toBe(true);
    expect(ok(PhaseListQuery, { projectId: "" })).toBe(false);
    const phase = { id: "1", version: 1, projectId: "1", name: "A", startDate: null, endDate: null, status: "planned", color: null, nonBillable: false, notes: null, position: 0 };
    expect(ok(Phase, phase)).toBe(true);
    expect(ok(PhaseList, { items: [phase], page: { nextCursor: null, total: 1 } })).toBe(true);
  });
});

describe("tâches de projet", () => {
  const t = { projectId: "1", name: "Design" };
  it("création : projet et nom ; phase facultative et annulable ; facturable booléen", () => {
    expect(ok(ProjectTaskCreate, t)).toBe(true);
    expect(ok(ProjectTaskCreate, { ...t, phaseId: "4", billable: false, position: 3 })).toBe(true);
    expect(ok(ProjectTaskCreate, { ...t, phaseId: null })).toBe(true);
    for (const v of [{ name: "x" }, { projectId: "1" }, { ...t, billable: "oui" }, { ...t, position: 40000 }]) expect(ok(ProjectTaskCreate, v)).toBe(false);
  });
  it("patch : non vide, phase déplaçable ou retirée, projet absent", () => {
    expect(ok(ProjectTaskPatch, {})).toBe(false);
    expect(ok(ProjectTaskPatch, { phaseId: null })).toBe(true);
    expect("projectId" in ProjectTaskPatch.parse({ projectId: "2", name: "x" })).toBe(false);
  });
  it("filtres projectId et phaseId", () => {
    expect(ok(ProjectTaskListQuery, { projectId: "1", phaseId: "2" })).toBe(true);
    expect(ok(ProjectTaskListQuery, { phaseId: "" })).toBe(false);
    expect(ok(ProjectTask, { id: "1", version: 1, projectId: "1", phaseId: null, name: "x", billable: true, position: 0 })).toBe(true);
  });
});

describe("routes", () => {
  const ops = (path: string) => routes.filter((r) => r.path === path || r.path.startsWith(`${path}/`)).map((r) => `${r.method} ${r.path.replace(path, "")}`).sort();
  it.each(["/api/v1/clients", "/api/v1/phases", "/api/v1/project-tasks"])("%s : liste, lecture, création, modification, suppression", (path) => {
    expect(ops(path)).toEqual(["delete /{id}", "get ", "get /{id}", "patch /{id}", "post "]);
  });
  it("pas de 409 ALREADY_EXISTS sur ces création : aucune unicité", () => {
    for (const path of ["/api/v1/clients", "/api/v1/phases", "/api/v1/project-tasks"]) {
      const post = routes.find((r) => r.method === "post" && r.path === path)!;
      expect(post.responses[409]).toBeUndefined();
      expect(post.responses[403]).toBeDefined();
    }
  });
  it("les départements gardent leur 409 (non-régression de l'aide commune)", () => {
    expect(routes.find((r) => r.method === "post" && r.path === "/api/v1/departments")!.responses[409]).toBeDefined();
  });
  it("la spec OpenAPI les décrit", () => {
    const spec = buildSpec() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (const p of ["/api/v1/clients", "/api/v1/clients/{id}", "/api/v1/phases", "/api/v1/phases/{id}", "/api/v1/project-tasks", "/api/v1/project-tasks/{id}"]) expect(spec.paths[p]).toBeDefined();
    for (const s of ["Client", "Phase", "ProjectTask", "PhaseCreate", "ProjectTaskPatch"]) expect(spec.components.schemas[s]).toBeDefined();
  });
});

describe("jalons", () => {
  const m = { projectId: "1", name: "Livraison", dueDate: "2026-06-30" };
  it("création : projet, nom et échéance obligatoires ; phase facultative et annulable", () => {
    expect(ok(MilestoneCreate, m)).toBe(true);
    expect(ok(MilestoneCreate, { ...m, phaseId: "4" })).toBe(true);
    expect(ok(MilestoneCreate, { ...m, phaseId: null })).toBe(true);
    for (const v of [{ name: "x", dueDate: "2026-06-30" }, { projectId: "1", dueDate: "2026-06-30" }, { projectId: "1", name: "x" }, { ...m, name: " " }, { ...m, dueDate: "bientôt" }, { ...m, dueDate: "2026-02-30" }]) {
      expect(ok(MilestoneCreate, v), JSON.stringify(v)).toBe(false);
    }
  });
  it("patch : non vide, projet absent", () => {
    expect(ok(MilestonePatch, {})).toBe(false);
    expect(ok(MilestonePatch, { dueDate: "2026-07-01" })).toBe(true);
    expect(ok(MilestonePatch, { phaseId: null })).toBe(true);
    expect("projectId" in MilestonePatch.parse({ projectId: "2", name: "x" })).toBe(false);
  });
  it("filtres projet, phase et intervalle d'échéance ; forme lue", () => {
    expect(ok(MilestoneListQuery, { projectId: "1", phaseId: "2", dueFrom: "2026-01-01", dueTo: "2026-12-31", limit: 10 })).toBe(true);
    for (const v of [{ projectId: "" }, { dueFrom: "hier" }, { dueTo: "2026-13-01" }]) expect(ok(MilestoneListQuery, v), JSON.stringify(v)).toBe(false);
    const item = { id: "1", version: 1, projectId: "1", phaseId: null, name: "x", dueDate: "2026-06-30" };
    expect(ok(Milestone, item)).toBe(true);
    expect(ok(MilestoneList, { items: [item], page: { nextCursor: null, total: 1 } })).toBe(true);
  });
  it("routes à plat, écriture sans admin, suppression sans 409 de référence", () => {
    const ops = Object.fromEntries(routes.filter((r) => r.path.includes("/milestones")).map((r) => [r.operationId, r]));
    expect(Object.keys(ops).sort()).toEqual(["createMilestone", "deleteMilestone", "getMilestone", "listMilestones", "updateMilestone"]);
    expect(ops.createMilestone!.body).toBe(MilestoneCreate);
    expect(ops.listMilestones!.query).toBe(MilestoneListQuery);
  });
});
