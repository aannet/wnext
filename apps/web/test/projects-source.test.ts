import type { ProjectDetail } from "@wnext/contracts";
import { describe, expect, it, vi } from "vitest";
import { demoSchedule } from "../src/demo";
import { createApiProjectsSource, createDemoProjectsSource, type ProjectInput } from "../src/data/projects-source";

const input = (over: Partial<ProjectInput> = {}): ProjectInput => ({ name: "Nouveau", projectCode: null, clientId: null, color: "#112233", startDate: null, endDate: null, status: "planned", ...over });

function demo() {
  const seen: ProjectDetail[] = [];
  const source = createDemoProjectsSource(demoSchedule("2026-10-20", 12), { onProject: (p) => seen.push({ ...p }) });
  return { source, seen };
}
const value = async <T,>(p: Promise<{ ok: boolean; value?: T; error?: unknown }>) => { const r = await p; if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value as T; };

describe("source de démonstration : mêmes règles que l'API", () => {
  it("refuse un code projet en double (création et modification) avec le champ en cause", async () => {
    const { source } = demo();
    await value(source.createProject(input({ projectCode: "J-1" })));
    const dup = await source.createProject(input({ name: "Autre", projectCode: "J-1" }));
    expect(dup).toEqual({ ok: false, error: { code: "ALREADY_EXISTS", params: { entity: "project", field: "projectCode" } } });
    const other = await value<ProjectDetail>(source.createProject(input({ name: "Autre", projectCode: "J-2" })));
    const r = await source.updateProject(other, { projectCode: "J-1" });
    expect(r).toMatchObject({ ok: false, error: { code: "ALREADY_EXISTS" } });
  });

  it("refuse une fin antérieure au début", async () => {
    const { source } = demo();
    const r = await source.createProject(input({ startDate: "2026-05-02", endDate: "2026-05-01" }));
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", params: { field: "endDate" } } });
  });

  it("verrou optimiste : version périmée = VERSION_CONFLICT, version suivante sinon", async () => {
    const { source } = demo();
    const p = await value<ProjectDetail>(source.createProject(input()));
    const updated = await value<ProjectDetail>(source.updateProject(p, { color: "#445566" }));
    expect(updated).toMatchObject({ version: p.version + 1, color: "#445566" });
    expect(await source.updateProject(p, { name: "Périmé" })).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
  });

  it("répercute chaque création et modification sur le planning (hook)", async () => {
    const { source, seen } = demo();
    const p = await value<ProjectDetail>(source.createProject(input({ color: "#112233" })));
    await value(source.updateProject(p, { color: "#445566" }));
    expect(seen.map((x) => x.color)).toEqual(["#112233", "#445566"]);
  });

  it("un client inconnu est refusé (NOT_FOUND, entity client) et un client peut être créé puis renommé", async () => {
    const { source } = demo();
    expect(await source.createProject(input({ clientId: "inconnu" }))).toMatchObject({ ok: false, error: { code: "NOT_FOUND", params: { entity: "client" } } });
    const c = await value<{ id: string; version: number; name: string }>(source.createClient("Initech"));
    expect((await value<typeof c>(source.renameClient(c as never, "Initrode"))).name).toBe("Initrode");
  });

  it("tâches : ajout, renommage, suppression ; équipe : ajout idempotent puis oubli après retrait", async () => {
    const { source } = demo();
    const p = await value<ProjectDetail>(source.createProject(input()));
    const t = await value<{ id: string; version: number; name: string }>(source.createTask(p.id, "Maquettes"));
    await value(source.renameTask(t as never, "Wireframes"));
    expect((await value<{ name: string }[]>(source.listTasks(p.id))).map((x) => x.name)).toEqual(["Wireframes"]);
    await value(source.deleteTask({ ...t, version: 2 } as never));
    expect(await value<unknown[]>(source.listTasks(p.id))).toEqual([]);
    expect(await value(source.addToTeam(p.id, ["1", "2"]))).toEqual({ added: ["1", "2"], alreadyInTeam: [] });
    expect(await value(source.addToTeam(p.id, ["2"]))).toEqual({ added: [], alreadyInTeam: ["2"] });
    source.teamRemoved(p.id, "2");
    expect((await value<{ personId: string }[]>(source.listTeam(p.id))).map((m) => m.personId)).toEqual(["1"]);
  });
});

describe("source API : appels du client généré", () => {
  const okPage = <T,>(items: T[], nextCursor: string | null = null) => ({ ok: true as const, status: 200, data: { items, page: { nextCursor } } });
  const fakeApi = (over: Record<string, unknown> = {}) => ({
    listProjects: vi.fn(async (q: { status?: string }) => (q.status === "archived" ? okPage([{ id: "9", status: "archived" }]) : okPage([{ id: "1", status: "planned" }]))),
    updateProject: vi.fn(async () => ({ ok: true as const, status: 200, data: { id: "1" } })),
    updateClient: vi.fn(), createClient: vi.fn(), listClients: vi.fn(), getProject: vi.fn(), createProject: vi.fn(),
    ...over,
  });

  it("lit les projets actifs puis archivés", async () => {
    const api = fakeApi();
    const r = await createApiProjectsSource(api as never).listProjects();
    expect(r).toMatchObject({ ok: true });
    expect((r as { value: { id: string }[] }).value.map((p) => p.id)).toEqual(["1", "9"]);
  });

  it("PATCH porte If-Match = version lue, entre guillemets", async () => {
    const api = fakeApi();
    await createApiProjectsSource(api as never).updateProject({ id: "1", version: 4 } as ProjectDetail, { color: "#112233" });
    expect(api.updateProject).toHaveBeenCalledWith({ path: { id: "1" }, headers: { "If-Match": '"4"' }, body: { color: "#112233" } });
  });

  it("garde les params de l'erreur (403 de périmètre) et traduit un échec réseau en INTERNAL_ERROR", async () => {
    const forbidden = fakeApi({ updateProject: vi.fn(async () => ({ ok: false as const, status: 403, error: { code: "FORBIDDEN", params: { scope: "project" }, requestId: "r" } })) });
    expect(await createApiProjectsSource(forbidden as never).updateProject({ id: "1", version: 1 } as ProjectDetail, { name: "x" }))
      .toEqual({ ok: false, error: { code: "FORBIDDEN", params: { scope: "project" } } });
    const broken = fakeApi({ updateProject: vi.fn(async () => { throw new Error("réseau"); }) });
    expect(await createApiProjectsSource(broken as never).updateProject({ id: "1", version: 1 } as ProjectDetail, { name: "x" }))
      .toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });
});
