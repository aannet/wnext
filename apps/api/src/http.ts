import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AccountPatch, NotificationListQuery, NotificationPreferencesUpdate, type NotificationEntity, ImportPathParams, ImportQuery, ImportRequest, type ImportQuery as ImportQueryT, REALTIME_TICKET_PATH, LoggedTimeCreate, LoggedTimeListQuery, LoggedTimePatch, LoggedTimeWindow, ClientCreate, ClientPatch, MilestoneCreate, MilestoneListQuery, MilestonePatch, ProjectBudgetLineCreate, ProjectBudgetLineListQuery, ProjectBudgetLinePatch, ProjectExpenseCreate, ProjectExpenseListQuery, ProjectExpensePatch, PhaseCreate, PhaseListQuery, PhasePatch, ProjectTaskCreate, ProjectTaskListQuery, ProjectTaskPatch, DepartmentCreate, DepartmentPatch, HolidayCreate, HolidayListQuery, HolidayPatch, ProjectCreate, ProjectListQuery, ProjectPatch, ReferenceListQuery, RoleCreate, RolePatch, TimeoffTypeCreate, TimeoffTypePatch, SavedViewCreate, SavedViewListQuery, SavedViewPatch, AllocationCreate, AllocationGroupCreate, AllocationGroupPatch, AllocationPatch, AllocationSplit, IfMatchHeader, ScheduleQuery, PersonCreate, PersonAllocationListQuery, PersonListQuery, ProjectAllocationListQuery, PersonHistoryQuery, PersonPatch, PersonProjectListQuery, PersonDeactivationQuery, PersonDeactivationRequest, TeamBatchAdd, TeamRemovalRequest, TimeoffCreate, TimeoffPatch, type ApiError, type HealthResponse, type ScheduleQuery as ScheduleQueryT, type PersonDeactivationQuery as PersonDeactivationQueryT, type PersonHistoryQuery as PersonHistoryQueryT } from "@wnext/contracts";
import type { Db, RequestContext } from "./db";
import { ApiFailure } from "./failure";
import type { RateLimiter } from "./rate-limit";
import { allocationReader, createAllocation, createAllocationGroup, deleteAllocation, deleteAllocationGroup, updateAllocationGroup, listPersonAllocations, listProjectAllocations, splitAllocation, updateAllocation } from "./allocations";
import { budgetLineReader, createBudgetLine, createExpense, deleteBudgetLine, deleteExpense, expenseReader, updateBudgetLine, updateExpense } from "./budget";
import { createPerson, deactivatePerson, getPersonDeactivationSummary, listPersonHistory, listPersonProjects, personReader, updatePerson } from "./people";
import {
  createDepartment, createHoliday, createProject, createRole, createTimeoffType, deleteDepartment, deleteHoliday, deleteRole, deleteTimeoffType,
  departmentReader, holidayReader, projectReader, roleReader, timeoffTypeReader,
  updateDepartment, updateHoliday, updateProject, updateRole, updateTimeoffType,
} from "./reference";
import { runImport } from "./imports";
import { getNotificationPreferences, listNotifications, markAllNotificationsRead, markNotificationRead, recordConflict, updateNotificationPreferences } from "./notifications";
import { createSavedView, deleteSavedView, getSavedView, listSavedViews, updateSavedView } from "./saved-views";
import { getMe } from "./me";
import { getAccount, updateAccount } from "./account";
import { getSchedule } from "./schedule";
import { addManyToTeam, addToTeam, getTeamRemovalSummary, listTeam, removeFromTeam } from "./team";
import { createLoggedTime, deleteLoggedTime, listLoggedTime, prefillLoggedTime, submitLoggedTime, unlockLoggedTime, updateLoggedTime } from "./logged-time";
import { createTimeoff, deleteTimeoff, updateTimeoff } from "./timeoffs";
import { clientReader, createClient, createMilestone, createPhase, createProjectTask, deleteClient, deleteMilestone, deletePhase, deleteProjectTask, milestoneReader, phaseReader, projectTaskReader, updateClient, updateMilestone, updatePhase, updateProjectTask } from "./project-structure";
import type { TicketService } from "./tickets";
import { API_VERSION } from "./version";

// Couche HTTP sans framework. `dispatch` est pure (requête -> statut + corps) : testable sans socket.
// L'authentification est injectée : le mécanisme (session, JWT de l'IdP) reste à décider ; elle renvoie null si non authentifié.
// Les erreurs portent un code stable, jamais de texte localisé (ADR-003 §4).

export interface HttpDeps {
  db: Db;
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<RequestContext | null>;
  /** Émission des tickets d'upgrade temps réel ; absent = la route n'existe pas. */
  tickets?: Pick<TicketService, "issue">;
  /** Limites d'émission des tickets (par utilisateur puis par compte) ; absent = pas de limite. */
  ticketLimits?: { perUser: RateLimiter; perAccount: RateLimiter };
  newRequestId?(): string;
  onError?(err: unknown, requestId: string): void;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Corps brut (texte) ; absent = aucun corps. */
  body?: string;
}
export interface HttpReply { status: number; body: unknown; /** En-têtes supplémentaires (noms en minuscules), ex. retry-after. */ headers?: Record<string, string> }

const STATUS: Record<ApiError["code"], number> = {
  INTERNAL_ERROR: 500,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  SCHEDULE_RANGE_INVALID: 400,
  SCHEDULE_CURSOR_INVALID: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  PRECONDITION_REQUIRED: 428,
  TIMEOFF_OVERLAP: 409,
  ALREADY_EXISTS: 409,
  REFERENCE_IN_USE: 409,
  TEAM_REMOVAL_CONFIRMATION_REQUIRED: 428,
  TEAM_REMOVAL_STALE_CONFIRMATION: 409,
  TEAM_REMOVAL_LOCKED_LOGS: 409,
  PERSON_DEACTIVATION_CONFIRMATION_REQUIRED: 428,
  PERSON_DEACTIVATION_STALE_CONFIRMATION: 409,
  PERSON_DEACTIVATION_INVALID_REPLACEMENT: 409,
  LOGGED_TIME_LOCKED: 409,
  LOGGED_TIME_DAY_LIMIT: 409,
  RATE_LIMITED: 429,
  NOT_A_SERIES: 409,
  OCCURRENCE_NOT_FOUND: 404,
  SERIES_SPLIT_UNSUPPORTED: 409,
  PERSON_HISTORY_LOCKED: 409,
  IMPORT_TOO_LARGE: 413,
  IMPORT_HAS_ERRORS: 422,
};

const fail = (code: ApiError["code"], requestId: string, params: ApiError["params"] = {}): HttpReply =>
  ({ status: STATUS[code], body: { code, params, requestId } satisfies ApiError });

// PostgreSQL refuse U+0000 dans un texte (erreur 22P05 / 22021, donc un 500) : toute entrée qui en contient est refusée en 400.
const hasNul = (v: unknown): boolean =>
  typeof v === "string" ? v.includes("\u0000")
  : Array.isArray(v) ? v.some(hasNul)
  : v !== null && typeof v === "object" ? Object.entries(v).some(([k, x]) => k.includes("\u0000") || hasNul(x))
  : false;

/** Chaîne de requête -> objet typé par le contrat. Clé répétée ou inconnue = VALIDATION_FAILED. */
/** Schéma de requête du contrat (z.object) : seules les clés et safeParse servent ici. */
interface QuerySchema { shape: object; safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } } }
function parseQuery<T>(schema: QuerySchema, search: URLSearchParams): T {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    if (values.length > 1 || !(key in schema.shape)) throw new ApiFailure("VALIDATION_FAILED", { field: key });
    const v = values[0]!;
    if (hasNul(v)) throw new ApiFailure("VALIDATION_FAILED", { field: key });
    if (key === "includeInactive" || key === "dryRun" || key === "unread") {
      if (v !== "true" && v !== "false") throw new ApiFailure("VALIDATION_FAILED", { field: key });
      raw[key] = v === "true";
    } else if (key === "limit") {
      raw[key] = v.trim() === "" ? NaN : Number(v);
    } else raw[key] = v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "query");
    throw new ApiFailure("VALIDATION_FAILED", { field });
  }
  return parsed.data as T;
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * BR-36 / US-3.5 : un 409 VERSION_CONFLICT sur une écriture à verrou optimiste notifie l'appelant (edit_conflict, auteur et version de la
 * ligne gagnante). La notification ne change jamais la réponse : son échec est journalisé (onError) et le 409 part tel quel.
 */
async function onConflictNotify<T>(deps: HttpDeps, ctx: RequestContext, requestId: string, entity: NotificationEntity, id: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiFailure && err.code === "VERSION_CONFLICT") await recordConflict(deps.db, ctx, entity, id).catch((e: unknown) => deps.onError?.(e, requestId));
    throw err;
  }
}
const WRITERS = new Set(["owner", "admin", "project_manager"]);
const ADMINS = new Set(["owner", "admin"]);

function parseJsonBody<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } } }, raw: string | undefined): T {
  if (raw === undefined || raw === "") throw new ApiFailure("VALIDATION_FAILED", { field: "body" });
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new ApiFailure("VALIDATION_FAILED", { field: "body" }); }
  if (hasNul(json)) {
    const top = json !== null && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).find((k) => hasNul({ [k]: (json as Record<string, unknown>)[k] })) : undefined;
    throw new ApiFailure("VALIDATION_FAILED", { field: top ?? "body" });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiFailure("VALIDATION_FAILED", { field: String(parsed.error.issues[0]?.path[0] ?? "body") });
  return parsed.data;
}

/** If-Match: "3" -> 3. Absent = 428 ; mal formé = 400. */
function expectedVersion(headers: HttpRequest["headers"]): number {
  const raw = headers["if-match"];
  if (raw === undefined) throw new ApiFailure("PRECONDITION_REQUIRED");
  const parsed = IfMatchHeader.safeParse({ "If-Match": Array.isArray(raw) ? raw.join(",") : raw });
  if (!parsed.success) throw new ApiFailure("VALIDATION_FAILED", { field: "If-Match" });
  return Number(parsed.data["If-Match"].slice(1, -1));
}

// Ressources modifiables : POST /x, PATCH et DELETE /x/{id}. Le rôle est contrôlé ici (avant la validation du corps) puis dans le domaine.
type Parser<T> = Parameters<typeof parseJsonBody<T>>[0];
interface WriteResource {
  pattern: RegExp;
  /** Table de la ressource : un 409 VERSION_CONFLICT sur PATCH/DELETE notifie l'appelant (BR-36), voir recordConflict. */
  entity: NotificationEntity;
  /** Configuration du compte : owner et admin seulement (403 avant la validation du corps). */
  adminOnly?: boolean;
  /** Ouverte à tout membre authentifié : le domaine contrôle les droits (ex. vues sauvegardées). */
  open?: boolean;
  /** Données financières : la LECTURE exige aussi un rôle d'écriture (403 après l'authentification, avant la validation de la requête). */
  restricted?: boolean;
  create(db: Db, ctx: RequestContext, raw: string | undefined): Promise<unknown>;
  update(db: Db, ctx: RequestContext, id: string, version: number, raw: string | undefined): Promise<unknown>;
  /** Lecture ouverte à tout membre authentifié ; absente = la ressource n'a pas encore de GET. */
  read?: { querySchema?: QuerySchema; list?(db: Db, ctx: RequestContext, q: never): Promise<unknown>; get(db: Db, ctx: RequestContext, id: string): Promise<unknown> };
  /** Absent = la ressource n'a pas de DELETE (ex. personnes : on désactive). */
  remove?(db: Db, ctx: RequestContext, id: string, version: number): Promise<void>;
}
function resource<C, P>(def: {
  pattern: RegExp; entity: NotificationEntity; adminOnly?: boolean; open?: boolean; restricted?: boolean; read?: WriteResource["read"]; createSchema: Parser<C>; patchSchema: Parser<P>;
  create(db: Db, ctx: RequestContext, body: C): Promise<unknown>;
  update(db: Db, ctx: RequestContext, id: string, version: number, patch: P): Promise<unknown>;
  remove?(db: Db, ctx: RequestContext, id: string, version: number): Promise<void>;
}): WriteResource {
  return {
    pattern: def.pattern,
    entity: def.entity,
    adminOnly: def.adminOnly,
    open: def.open,
    restricted: def.restricted,
    read: def.read,
    create: (db, ctx, raw) => def.create(db, ctx, parseJsonBody(def.createSchema, raw)),
    update: (db, ctx, id, version, raw) => def.update(db, ctx, id, version, parseJsonBody(def.patchSchema, raw)),
    remove: def.remove,
  };
}
const WRITE_RESOURCES: WriteResource[] = [
  resource({ entity: "allocations", pattern: /^\/api\/v1\/allocations(?:\/([^/]+))?$/, read: { get: allocationReader.get }, createSchema: AllocationCreate, patchSchema: AllocationPatch, create: createAllocation, update: updateAllocation, remove: deleteAllocation }),
  resource({ entity: "people", pattern: /^\/api\/v1\/people(?:\/([^/]+))?$/, read: { querySchema: PersonListQuery, list: personReader.list, get: personReader.get }, createSchema: PersonCreate, patchSchema: PersonPatch, create: createPerson, update: updatePerson }),
  resource({ entity: "logged_time", pattern: /^\/api\/v1\/logged-time(?:\/([^/]+))?$/, createSchema: LoggedTimeCreate, patchSchema: LoggedTimePatch, create: createLoggedTime, update: updateLoggedTime, remove: deleteLoggedTime }),
  resource({ entity: "timeoffs", pattern: /^\/api\/v1\/timeoffs(?:\/([^/]+))?$/, createSchema: TimeoffCreate, patchSchema: TimeoffPatch, create: createTimeoff, update: updateTimeoff, remove: deleteTimeoff }),
  resource({ adminOnly: true, entity: "departments", pattern: /^\/api\/v1\/departments(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: departmentReader.list, get: departmentReader.get }, createSchema: DepartmentCreate, patchSchema: DepartmentPatch, create: createDepartment, update: updateDepartment, remove: deleteDepartment }),
  resource({ adminOnly: true, entity: "roles", pattern: /^\/api\/v1\/roles(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: roleReader.list, get: roleReader.get }, createSchema: RoleCreate, patchSchema: RolePatch, create: createRole, update: updateRole, remove: deleteRole }),
  resource({ adminOnly: true, entity: "timeoff_types", pattern: /^\/api\/v1\/timeoff-types(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: timeoffTypeReader.list, get: timeoffTypeReader.get }, createSchema: TimeoffTypeCreate, patchSchema: TimeoffTypePatch, create: createTimeoffType, update: updateTimeoffType, remove: deleteTimeoffType }),
  resource({ adminOnly: true, entity: "holidays", pattern: /^\/api\/v1\/holidays(?:\/([^/]+))?$/, read: { querySchema: HolidayListQuery, list: holidayReader.list, get: holidayReader.get }, createSchema: HolidayCreate, patchSchema: HolidayPatch, create: createHoliday, update: updateHoliday, remove: deleteHoliday }),
  resource({ entity: "projects", pattern: /^\/api\/v1\/projects(?:\/([^/]+))?$/, read: { querySchema: ProjectListQuery, list: projectReader.list, get: projectReader.get }, createSchema: ProjectCreate, patchSchema: ProjectPatch, create: createProject, update: updateProject }),
  resource({ open: true, entity: "saved_views", pattern: /^\/api\/v1\/saved-views(?:\/([^/]+))?$/, read: { querySchema: SavedViewListQuery, list: listSavedViews, get: getSavedView }, createSchema: SavedViewCreate, patchSchema: SavedViewPatch, create: createSavedView, update: updateSavedView, remove: deleteSavedView }),
  resource({ entity: "clients", pattern: /^\/api\/v1\/clients(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: clientReader.list, get: clientReader.get }, createSchema: ClientCreate, patchSchema: ClientPatch, create: createClient, update: updateClient, remove: deleteClient }),
  resource({ entity: "phases", pattern: /^\/api\/v1\/phases(?:\/([^/]+))?$/, read: { querySchema: PhaseListQuery, list: phaseReader.list, get: phaseReader.get }, createSchema: PhaseCreate, patchSchema: PhasePatch, create: createPhase, update: updatePhase, remove: deletePhase }),
  resource({ entity: "project_tasks", pattern: /^\/api\/v1\/project-tasks(?:\/([^/]+))?$/, read: { querySchema: ProjectTaskListQuery, list: projectTaskReader.list, get: projectTaskReader.get }, createSchema: ProjectTaskCreate, patchSchema: ProjectTaskPatch, create: createProjectTask, update: updateProjectTask, remove: deleteProjectTask }),
  resource({ entity: "milestones", pattern: /^\/api\/v1\/milestones(?:\/([^/]+))?$/, read: { querySchema: MilestoneListQuery, list: milestoneReader.list, get: milestoneReader.get }, createSchema: MilestoneCreate, patchSchema: MilestonePatch, create: createMilestone, update: updateMilestone, remove: deleteMilestone }),
  resource({ restricted: true, entity: "project_expenses", pattern: /^\/api\/v1\/project-expenses(?:\/([^/]+))?$/, read: { querySchema: ProjectExpenseListQuery, list: expenseReader.list, get: expenseReader.get }, createSchema: ProjectExpenseCreate, patchSchema: ProjectExpensePatch, create: createExpense, update: updateExpense, remove: deleteExpense }),
  resource({ restricted: true, entity: "project_budget_lines", pattern: /^\/api\/v1\/project-budget-lines(?:\/([^/]+))?$/, read: { querySchema: ProjectBudgetLineListQuery, list: budgetLineReader.list, get: budgetLineReader.get }, createSchema: ProjectBudgetLineCreate, patchSchema: ProjectBudgetLinePatch, create: createBudgetLine, update: updateBudgetLine, remove: deleteBudgetLine }),
];

export async function dispatch(deps: HttpDeps, req: HttpRequest): Promise<HttpReply> {
  const requestId = deps.newRequestId?.() ?? randomUUID();
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/health") return { status: 200, body: { status: "ok", version: API_VERSION } satisfies HealthResponse };
    if (req.method === "GET" && url.pathname === "/api/v1/me") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      return { status: 200, body: await getMe(deps.db, ctx) };
    }
    if (url.pathname === "/api/v1/account" && (req.method === "GET" || req.method === "PATCH")) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (req.method === "GET") return { status: 200, body: await getAccount(deps.db, ctx) };
      if (!ADMINS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      const version = expectedVersion(req.headers);
      // Pas de notification edit_conflict sur 409 : NotificationEntity ne connaît pas les comptes.
      return { status: 200, body: await updateAccount(deps.db, ctx, version, parseJsonBody(AccountPatch, req.body)) };
    }
    if (req.method === "POST" && url.pathname === REALTIME_TICKET_PATH && deps.tickets) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      // Utilisateur d'abord : un utilisateur trop insistant n'épuise pas le quota de son compte. Après l'authentification : un anonyme ne consomme rien.
      const wait = deps.ticketLimits?.perUser.hit(`${ctx.accountId}:${ctx.userId}`) || deps.ticketLimits?.perAccount.hit(ctx.accountId) || 0;
      if (wait > 0) return { ...fail("RATE_LIMITED", requestId, { retryAfterSeconds: wait }), headers: { "retry-after": String(wait) } };
      return { status: 200, body: deps.tickets.issue(ctx) };
    }
    if (req.method === "GET" && url.pathname === "/api/v1/schedule") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId); // l'auth passe avant la validation : pas d'oracle pour un anonyme
      return { status: 200, body: await getSchedule(deps.db, ctx, parseQuery<ScheduleQueryT>(ScheduleQuery, url.searchParams)) };
    }
    const projectAllocations = /^\/api\/v1\/projects\/([^/]+)\/allocations$/.exec(url.pathname);
    if (projectAllocations && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId); // l'auth passe avant la validation : pas d'oracle pour un anonyme
      let projectId: string;
      try { projectId = decodeURIComponent(projectAllocations[1]!); } catch { projectId = "%"; }
      return { status: 200, body: await listProjectAllocations(deps.db, ctx, projectId, parseQuery(ProjectAllocationListQuery, url.searchParams)) };
    }
    const personAllocations = /^\/api\/v1\/people\/([^/]+)\/allocations$/.exec(url.pathname);
    if (personAllocations && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId); // l'auth passe avant la validation : pas d'oracle pour un anonyme
      let personId: string;
      try { personId = decodeURIComponent(personAllocations[1]!); } catch { personId = "%"; }
      return { status: 200, body: await listPersonAllocations(deps.db, ctx, personId, parseQuery(PersonAllocationListQuery, url.searchParams)) };
    }
    const personProjects = /^\/api\/v1\/people\/([^/]+)\/projects$/.exec(url.pathname);
    if (personProjects && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      let personId: string;
      try { personId = decodeURIComponent(personProjects[1]!); } catch { personId = "%"; }
      return { status: 200, body: await listPersonProjects(deps.db, ctx, personId, parseQuery(PersonProjectListQuery, url.searchParams) as { limit?: number; cursor?: string; status?: string }) };
    }
    const personHistory = /^\/api\/v1\/people\/([^/]+)\/history$/.exec(url.pathname);
    if (personHistory && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      let personId: string;
      try { personId = decodeURIComponent(personHistory[1]!); } catch { personId = "%"; }
      return { status: 200, body: await listPersonHistory(deps.db, ctx, personId, parseQuery<PersonHistoryQueryT>(PersonHistoryQuery, url.searchParams)) };
    }
    const deactivation = /^\/api\/v1\/people\/([^/]+)\/(deactivation-summary|deactivation)$/.exec(url.pathname);
    if (deactivation && (deactivation[2] === "deactivation-summary" ? req.method === "GET" : req.method === "POST")) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      let personId: string;
      try { personId = decodeURIComponent(deactivation[1]!); } catch { personId = "%"; }
      if (deactivation[2] === "deactivation-summary") return { status: 200, body: await getPersonDeactivationSummary(deps.db, ctx, personId, parseQuery(PersonDeactivationQuery, url.searchParams) as PersonDeactivationQueryT) };
      return { status: 200, body: await deactivatePerson(deps.db, ctx, personId, parseJsonBody(PersonDeactivationRequest, req.body ?? "{}")) };
    }
    const importRoute = /^\/api\/v1\/imports\/([^/]+)$/.exec(url.pathname);
    if (importRoute && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!ADMINS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      const kind = ImportPathParams.safeParse({ kind: importRoute[1] });
      if (!kind.success) return fail("NOT_FOUND", requestId, { entity: "route" });
      const query = parseQuery<ImportQueryT>(ImportQuery, url.searchParams);
      return { status: 200, body: await runImport(deps.db, ctx, kind.data.kind, query, parseJsonBody(ImportRequest, req.body)) };
    }
    if (url.pathname === "/api/v1/allocation-groups" && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      return { status: 201, body: await createAllocationGroup(deps.db, ctx, parseJsonBody(AllocationGroupCreate, req.body)) };
    }
    const allocationGroup = /^\/api\/v1\/allocations\/([^/]+)\/group$/.exec(url.pathname);
    if (allocationGroup && (req.method === "PATCH" || req.method === "DELETE")) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
      let id: string;
      try { id = decodeURIComponent(allocationGroup[1]!); } catch { id = "%"; }
      const version = expectedVersion(req.headers);
      if (req.method === "DELETE") {
        const deleted = await onConflictNotify(deps, ctx, requestId, "allocations", id, () => deleteAllocationGroup(deps.db, ctx, id, version));
        // RFC 7240 : seule la préférence return=representation change la réponse (lignes supprimées, état d'avant ; RT-047).
        const prefer = req.headers.prefer;
        const representation = (Array.isArray(prefer) ? prefer.join(",") : prefer ?? "").split(",").some((x) => x.trim().toLowerCase() === "return=representation");
        return representation ? { status: 200, body: deleted } : { status: 204, body: undefined };
      }
      const patch = parseJsonBody(AllocationGroupPatch, req.body);
      return { status: 200, body: await onConflictNotify(deps, ctx, requestId, "allocations", id, () => updateAllocationGroup(deps.db, ctx, id, version, patch)) };
    }
    const allocationSplit = /^\/api\/v1\/allocations\/([^/]+)\/split$/.exec(url.pathname);
    if (allocationSplit && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      let id: string;
      try { id = decodeURIComponent(allocationSplit[1]!); } catch { id = "%"; }
      const version = expectedVersion(req.headers);
      const split = parseJsonBody(AllocationSplit, req.body);
      return { status: 200, body: await onConflictNotify(deps, ctx, requestId, "allocations", id, () => splitAllocation(deps.db, ctx, id, version, split)) };
    }
    const teamList = /^\/api\/v1\/projects\/([^/]+)\/team$/.exec(url.pathname);
    if (teamList && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      let projectId: string;
      try { projectId = decodeURIComponent(teamList[1]!); } catch { projectId = "%"; }
      return { status: 200, body: await addManyToTeam(deps.db, ctx, projectId, parseJsonBody(TeamBatchAdd, req.body)) };
    }
    if (teamList && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      let projectId: string;
      try { projectId = decodeURIComponent(teamList[1]!); } catch { projectId = "%"; }
      return { status: 200, body: await listTeam(deps.db, ctx, projectId, parseQuery(ReferenceListQuery, url.searchParams) as { limit?: number; cursor?: string }) };
    }
    const member = /^\/api\/v1\/projects\/([^/]+)\/team\/([^/]+)$/.exec(url.pathname);
    if (member && req.method === "PUT") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
      const [projectId, personId] = [member[1]!, member[2]!].map((v) => { try { return decodeURIComponent(v); } catch { return "%"; } }) as [string, string];
      return { status: 200, body: await addToTeam(deps.db, ctx, projectId, personId) };
    }
    const team = /^\/api\/v1\/projects\/([^/]+)\/team\/([^/]+)\/(removal-summary|removal)$/.exec(url.pathname);
    if (team && (team[3] === "removal-summary" ? req.method === "GET" : req.method === "POST")) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
      const [projectId, personId] = [team[1]!, team[2]!].map((v) => { try { return decodeURIComponent(v); } catch { return "%"; } }) as [string, string];
      if (team[3] === "removal-summary") return { status: 200, body: await getTeamRemovalSummary(deps.db, ctx, projectId, personId) };
      return { status: 200, body: await removeFromTeam(deps.db, ctx, projectId, personId, parseJsonBody(TeamRemovalRequest, req.body ?? "{}")) };
    }
    if (url.pathname === "/api/v1/logged-time" && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId); // l'auth passe avant la validation : pas d'oracle pour un anonyme
      return { status: 200, body: await listLoggedTime(deps.db, ctx, parseQuery(LoggedTimeListQuery, url.searchParams)) };
    }
    if ((url.pathname === "/api/v1/logged-time/prefill" || url.pathname === "/api/v1/logged-time/submit") && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role }); // avant la validation du corps
      const body = parseJsonBody(LoggedTimeWindow, req.body);
      return { status: 200, body: await (url.pathname.endsWith("/prefill") ? prefillLoggedTime : submitLoggedTime)(deps.db, ctx, body) };
    }
    const unlock = /^\/api\/v1\/logged-time\/([^/]+)\/unlock$/.exec(url.pathname);
    if (unlock && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!ADMINS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
      let id: string;
      try { id = decodeURIComponent(unlock[1]!); } catch { id = "%"; }
      const version = expectedVersion(req.headers);
      return { status: 200, body: await onConflictNotify(deps, ctx, requestId, "logged_time", id, () => unlockLoggedTime(deps.db, ctx, id, version)) };
    }
    // Notifications in-app (FR-10, US-7.3) : tout membre authentifié, sur ses seules notifications (le domaine filtre par utilisateur).
    if (url.pathname === "/api/v1/notifications" && req.method === "GET") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      return { status: 200, body: await listNotifications(deps.db, ctx, parseQuery(NotificationListQuery, url.searchParams)) };
    }
    const notificationRead = /^\/api\/v1\/notifications\/([^/]+)\/read$/.exec(url.pathname);
    if ((url.pathname === "/api/v1/notifications/read-all" || notificationRead) && req.method === "POST") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (url.pathname === "/api/v1/notifications/read-all") return { status: 200, body: await markAllNotificationsRead(deps.db, ctx) };
      let id: string;
      try { id = decodeURIComponent(notificationRead![1]!); } catch { id = "%"; }
      return { status: 200, body: await markNotificationRead(deps.db, ctx, id) };
    }
    if (url.pathname === "/api/v1/notification-preferences" && (req.method === "GET" || req.method === "PUT")) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (req.method === "GET") return { status: 200, body: await getNotificationPreferences(deps.db, ctx) };
      return { status: 200, body: await updateNotificationPreferences(deps.db, ctx, parseJsonBody(NotificationPreferencesUpdate, req.body)) };
    }
    for (const resource of WRITE_RESOURCES) {
      const m = resource.pattern.exec(url.pathname);
      if (!m) continue;
      let id: string | undefined;
      if (m[1] !== undefined) {
        try { id = decodeURIComponent(m[1]); } catch { id = "%"; } // séquence % illisible : identifiant qui ne désigne rien (404)
      }
      const reading = req.method === "GET" && resource.read !== undefined && (id !== undefined || resource.read.list !== undefined); // sans `list`, seule la lecture par id existe
      const known = reading || (id === undefined ? req.method === "POST" : req.method === "PATCH" || (req.method === "DELETE" && resource.remove !== undefined));
      if (!known) break;
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (reading) {
        if (resource.restricted && !WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
        const read = resource.read!;
        if (id !== undefined) return { status: 200, body: await read.get(deps.db, ctx, id) };
        return { status: 200, body: await read.list!(deps.db, ctx, parseQuery(read.querySchema!, url.searchParams) as never) };
      }
      if (!resource.open && !(resource.adminOnly ? ADMINS : WRITERS).has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
      if (id === undefined) return { status: 201, body: await resource.create(deps.db, ctx, req.body) };
      const version = expectedVersion(req.headers);
      const target = id;
      if (req.method === "DELETE") {
        await onConflictNotify(deps, ctx, requestId, resource.entity, target, () => resource.remove!(deps.db, ctx, target, version));
        return { status: 204, body: undefined };
      }
      return { status: 200, body: await onConflictNotify(deps, ctx, requestId, resource.entity, target, () => resource.update(deps.db, ctx, target, version, req.body)) };
    }
    return fail("NOT_FOUND", requestId, { entity: "route" });
  } catch (err) {
    if (err instanceof ApiFailure) return fail(err.code, requestId, err.params);
    deps.onError?.(err, requestId);
    return fail("INTERNAL_ERROR", requestId); // jamais de détail interne vers le client
  }
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((incoming: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    incoming.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    incoming.on("end", () => {
      const req: HttpRequest = { method: incoming.method ?? "GET", url: incoming.url ?? "/", headers: incoming.headers, body: tooLarge ? "\u0000" : size ? Buffer.concat(chunks).toString("utf8") : undefined };
      dispatch(deps, req).then((reply) => {
        res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...reply.headers });
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
  });
}
