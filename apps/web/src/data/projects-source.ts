// Données de l'écran Projets (RT-010, RT-012, RT-018) : deux sources de même interface, comme pour le planning.
//  * createApiProjectsSource : branchée sur /api/v1 (client généré) ; PATCH et DELETE portent If-Match = version lue.
//  * createDemoProjectsSource (?demo=1) : tout en mémoire, mêmes règles que l'API (code projet unique, dates ordonnées,
//    version), et chaque projet modifié est répercuté sur la source du planning de la démo (couleur, nom...).
// Les erreurs sont les codes stables du contrat ; l'écran les traduit. `params` porte ce que l'API précise (champ en
// double, périmètre d'un refus BR-33 : { scope: "project" }).
import type { ApiError, Client, Milestone, Phase, ProjectDetail, ProjectTask, ScheduleResponse, TeamMember } from "@wnext/contracts";
import type { createClient } from "../api/client.gen";
import { errorCodeOf } from "./schedule-source";

export type ProjectsErrorCode = ApiError["code"];
export interface ProjectsError { code: ProjectsErrorCode; params: Record<string, string | number | boolean> }
export type ProjectsResult<T> = { ok: true; value: T } | { ok: false; error: ProjectsError };

export type ProjectStatus = ProjectDetail["status"];
export interface ProjectInput {
  name: string;
  projectCode: string | null;
  clientId: string | null;
  color: string;
  startDate: string | null;
  endDate: string | null;
  status: ProjectStatus;
}
export type ProjectPatchInput = Partial<ProjectInput> & { notes?: string | null; nonBillable?: boolean };
export interface PersonRef { id: string; name: string }

export interface ProjectsSource {
  /** Projets du compte, archivés compris. */
  listProjects(): Promise<ProjectsResult<ProjectDetail[]>>;
  listClients(): Promise<ProjectsResult<Client[]>>;
  createClient(name: string): Promise<ProjectsResult<Client>>;
  renameClient(client: Client, name: string): Promise<ProjectsResult<Client>>;
  /** If-Match = client.version ; REFERENCE_IN_USE tant que des projets y sont rattachés. */
  deleteClient(client: Client): Promise<ProjectsResult<null>>;
  createProject(input: ProjectInput): Promise<ProjectsResult<ProjectDetail>>;
  /** If-Match = project.version. */
  updateProject(project: ProjectDetail, patch: ProjectPatchInput): Promise<ProjectsResult<ProjectDetail>>;
  /** Relit un projet (après un VERSION_CONFLICT) ; null s'il n'existe plus. */
  reloadProject(id: string): Promise<ProjectDetail | null>;
  listTasks(projectId: string): Promise<ProjectsResult<ProjectTask[]>>;
  createTask(projectId: string, name: string): Promise<ProjectsResult<ProjectTask>>;
  renameTask(task: ProjectTask, name: string): Promise<ProjectsResult<ProjectTask>>;
  deleteTask(task: ProjectTask): Promise<ProjectsResult<null>>;
  listPhases(projectId: string): Promise<ProjectsResult<Phase[]>>;
  listMilestones(projectId: string): Promise<ProjectsResult<Milestone[]>>;
  listTeam(projectId: string): Promise<ProjectsResult<TeamMember[]>>;
  /** Personnes actives du compte, pour l'ajout à une équipe. */
  listPeople(): Promise<ProjectsResult<PersonRef[]>>;
  addToTeam(projectId: string, personIds: string[]): Promise<ProjectsResult<{ added: string[]; alreadyInTeam: string[] }>>;
  /** Une personne vient d'être retirée du projet (parcours BR-10, fait par la source du planning) : rien à faire sur l'API, la démo oublie le membre. */
  teamRemoved(projectId: string, personId: string): void;
}

const fail = (code: ProjectsErrorCode, params: ProjectsError["params"] = {}): { ok: false; error: ProjectsError } => ({ ok: false, error: { code, params } });
const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });
const PAGE = 200;

type ApiLike = Pick<ReturnType<typeof createClient>,
  "listProjects" | "getProject" | "createProject" | "updateProject" | "listClients" | "createClient" | "updateClient" | "deleteClient"
  | "listProjectTasks" | "createProjectTask" | "updateProjectTask" | "deleteProjectTask" | "listPhases" | "listMilestones"
  | "listProjectTeam" | "addManyToTeam" | "listPeople">;

type Page<T> = { items: T[]; page: { nextCursor?: string | null } };

export function createApiProjectsSource(api: ApiLike): ProjectsSource {
  async function call<T>(run: () => Promise<{ ok: true; data: T } | { ok: false; status: number; error: unknown }>): Promise<ProjectsResult<T>> {
    try {
      const r = await run();
      if (r.ok) return { ok: true, value: r.data };
      const params = (r.error as { params?: ProjectsError["params"] } | null | undefined)?.params;
      return fail(errorCodeOf(r.status, r.error), params && typeof params === "object" ? params : {});
    } catch {
      return fail("INTERNAL_ERROR");
    }
  }
  async function all<T>(fetchPage: (cursor?: string) => Promise<{ ok: true; data: Page<T> } | { ok: false; status: number; error: unknown }>): Promise<ProjectsResult<T[]>> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const r = await call(() => fetchPage(cursor));
      if (!r.ok) return r;
      items.push(...r.value.items);
      cursor = r.value.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return { ok: true, value: items };
  }
  const withCursor = (cursor?: string) => (cursor ? { cursor } : {});
  const toBody = (p: ProjectPatchInput) => p; // mêmes noms de champs que le contrat
  return {
    async listProjects() {
      // Les archivés ne sont listés que sur demande (status=archived) : deux lectures.
      const live = await all((c) => api.listProjects({ limit: PAGE, ...withCursor(c) }));
      if (!live.ok) return live;
      const archived = await all((c) => api.listProjects({ limit: PAGE, status: "archived", ...withCursor(c) }));
      return archived.ok ? { ok: true, value: [...live.value, ...archived.value] } : archived;
    },
    listClients: () => all((c) => api.listClients({ limit: PAGE, ...withCursor(c) })),
    createClient: (name) => call(() => api.createClient({ body: { name } })),
    renameClient: (client, name) => call(() => api.updateClient({ path: { id: client.id }, headers: ifMatch(client.version), body: { name } })),
    async deleteClient(client) {
      const r = await call(() => api.deleteClient({ path: { id: client.id }, headers: ifMatch(client.version) }));
      return r.ok ? { ok: true, value: null } : r;
    },
    createProject: (input) => call(() => api.createProject({ body: toBody(input) as never })),
    updateProject: (project, patch) => call(() => api.updateProject({ path: { id: project.id }, headers: ifMatch(project.version), body: toBody(patch) as never })),
    async reloadProject(id) {
      const r = await call(() => api.getProject({ path: { id } }));
      return r.ok ? r.value : null;
    },
    listTasks: (projectId) => all((c) => api.listProjectTasks({ projectId, limit: PAGE, ...withCursor(c) })),
    createTask: (projectId, name) => call(() => api.createProjectTask({ body: { projectId, name } })),
    renameTask: (task, name) => call(() => api.updateProjectTask({ path: { id: task.id }, headers: ifMatch(task.version), body: { name } })),
    async deleteTask(task) {
      const r = await call(() => api.deleteProjectTask({ path: { id: task.id }, headers: ifMatch(task.version) }));
      return r.ok ? { ok: true, value: null } : r;
    },
    listPhases: (projectId) => all((c) => api.listPhases({ projectId, limit: PAGE, ...withCursor(c) })),
    listMilestones: (projectId) => all((c) => api.listMilestones({ projectId, limit: PAGE, ...withCursor(c) })),
    listTeam: (projectId) => all((c) => api.listProjectTeam({ path: { projectId }, query: { limit: PAGE, ...withCursor(c) } })),
    async listPeople() {
      const r = await all((c) => api.listPeople({ limit: PAGE, ...withCursor(c) }));
      return r.ok ? { ok: true, value: r.value.map((p) => ({ id: p.id, name: p.name })) } : r;
    },
    addToTeam: (projectId, personIds) => call(() => api.addManyToTeam({ path: { projectId }, body: { personIds } })),
    teamRemoved() {},
  };
}

// --- Démo --------------------------------------------------------------------------------------------------------------
export interface DemoProjectsHooks {
  /** Un projet a été créé ou modifié : la source du planning de la démo l'applique à ses blocs (couleur, nom...). */
  onProject(project: ProjectDetail): void;
}

/** `seedTasks` : tâches de départ (démo du planning : la pop-in du créneau en propose). */
export function createDemoProjectsSource(schedule: ScheduleResponse, hooks: DemoProjectsHooks, seedTasks: readonly ProjectTask[] = []): ProjectsSource {
  let seq = 0;
  const nextId = () => `demo-${++seq}`;
  const clients: Client[] = [
    { id: nextId(), version: 1, name: "Acme", shortName: null, tags: [] },
    { id: nextId(), version: 1, name: "Globex", shortName: null, tags: [] },
  ];
  const projects: ProjectDetail[] = schedule.projects.map((p, i) => ({
    ...p, projectManagerId: null, managerUserIds: [], clientId: i % 3 === 0 ? clients[0]!.id : i % 3 === 1 ? clients[1]!.id : null, tags: [], notes: null,
  }));
  const tasks: ProjectTask[] = seedTasks.map((t) => ({ ...t }));
  const phases: Phase[] = (schedule.phases ?? []).map((ph, i) => ({
    id: ph.id, version: ph.version, projectId: ph.projectId, name: ph.name, startDate: ph.startDate, endDate: ph.endDate, status: "in_progress",
    color: ph.color, nonBillable: false, notes: null, position: i,
  }));
  const milestones: Milestone[] = [];
  // Équipe d'un projet : les personnes qui y ont des allocations, plus celles qu'on y ajoute.
  const team = new Map<string, Set<string>>();
  for (const a of schedule.allocations) (team.get(a.projectId) ?? team.set(a.projectId, new Set()).get(a.projectId)!).add(a.personId);
  const names = new Map(schedule.people.map((p) => [p.id, p.name]));
  const ok = <T,>(value: T): ProjectsResult<T> => ({ ok: true, value });
  const find = <T extends { id: string; version: number }>(list: T[], item: T): T | undefined => list.find((x) => x.id === item.id);

  function validate(p: { startDate: string | null; endDate: string | null }, code: string | null, selfId: string | null): ProjectsResult<null> | null {
    if (p.startDate && p.endDate && p.endDate < p.startDate) return fail("VALIDATION_FAILED", { field: "endDate" });
    if (code && projects.some((x) => x.projectCode === code && x.id !== selfId)) return fail("ALREADY_EXISTS", { entity: "project", field: "projectCode" });
    return null;
  }
  const knownClient = (id: string | null) => id === null || clients.some((c) => c.id === id);

  return {
    listProjects: async () => ok(projects.map((p) => ({ ...p }))),
    listClients: async () => ok(clients.map((c) => ({ ...c }))),
    async createClient(name) {
      const c: Client = { id: nextId(), version: 1, name, shortName: null, tags: [] };
      clients.push(c);
      return ok({ ...c });
    },
    async renameClient(client, name) {
      const cur = find(clients, client);
      if (!cur) return fail("NOT_FOUND", { entity: "client" });
      if (cur.version !== client.version) return fail("VERSION_CONFLICT", { currentVersion: cur.version });
      Object.assign(cur, { name, version: cur.version + 1 });
      return ok({ ...cur });
    },
    async deleteClient(client) {
      const cur = find(clients, client);
      if (!cur) return fail("NOT_FOUND", { entity: "client" });
      if (cur.version !== client.version) return fail("VERSION_CONFLICT", { currentVersion: cur.version });
      const used = projects.filter((p) => p.clientId === cur.id).length;
      if (used > 0) return fail("REFERENCE_IN_USE", { entity: "client", projects: used });
      clients.splice(clients.indexOf(cur), 1);
      return ok(null);
    },
    async createProject(input) {
      const bad = validate(input, input.projectCode, null);
      if (bad) return bad as ProjectsResult<ProjectDetail>;
      if (!knownClient(input.clientId)) return fail("NOT_FOUND", { entity: "client" });
      const p: ProjectDetail = { id: nextId(), version: 1, nonBillable: false, projectManagerId: null, managerUserIds: [], tags: [], notes: null, ...input };
      projects.push(p);
      hooks.onProject(p);
      return ok({ ...p });
    },
    async updateProject(project, patch) {
      const cur = find(projects, project);
      if (!cur) return fail("NOT_FOUND", { entity: "project" });
      if (cur.version !== project.version) return fail("VERSION_CONFLICT", { currentVersion: cur.version });
      const next = { ...cur, ...patch, version: cur.version + 1 } as ProjectDetail;
      const bad = validate(next, next.projectCode, cur.id);
      if (bad) return bad as ProjectsResult<ProjectDetail>;
      if (!knownClient(next.clientId)) return fail("NOT_FOUND", { entity: "client" });
      Object.assign(cur, next);
      hooks.onProject(cur);
      return ok({ ...cur });
    },
    reloadProject: async (id) => { const p = projects.find((x) => x.id === id); return p ? { ...p } : null; },
    listTasks: async (projectId) => ok(tasks.filter((t) => t.projectId === projectId).map((t) => ({ ...t }))),
    async createTask(projectId, name) {
      const t: ProjectTask = { id: nextId(), version: 1, projectId, phaseId: null, name, billable: true, position: tasks.filter((x) => x.projectId === projectId).length };
      tasks.push(t);
      return ok({ ...t });
    },
    async renameTask(task, name) {
      const cur = find(tasks, task);
      if (!cur) return fail("NOT_FOUND", { entity: "project_task" });
      if (cur.version !== task.version) return fail("VERSION_CONFLICT", { currentVersion: cur.version });
      Object.assign(cur, { name, version: cur.version + 1 });
      return ok({ ...cur });
    },
    async deleteTask(task) {
      const i = tasks.findIndex((x) => x.id === task.id);
      if (i < 0) return fail("NOT_FOUND", { entity: "project_task" });
      tasks.splice(i, 1);
      return ok(null);
    },
    listPhases: async (projectId) => ok(phases.filter((p) => p.projectId === projectId)),
    listMilestones: async (projectId) => ok(milestones.filter((m) => m.projectId === projectId)),
    listTeam: async (projectId) => ok([...(team.get(projectId) ?? [])].map((personId) => ({ personId, name: names.get(personId) ?? personId }))),
    listPeople: async () => ok(schedule.people.map((p) => ({ id: p.id, name: p.name }))),
    async addToTeam(projectId, personIds) {
      const set = team.get(projectId) ?? team.set(projectId, new Set()).get(projectId)!;
      const added: string[] = [], alreadyInTeam: string[] = [];
      for (const id of personIds) (set.has(id) ? alreadyInTeam : added).push(id);
      for (const id of added) set.add(id);
      return ok({ added, alreadyInTeam });
    },
    teamRemoved: (projectId, personId) => { team.get(projectId)?.delete(personId); },
  };
}
