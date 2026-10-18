import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { REALTIME_TICKET_PATH, ClientCreate, ClientPatch, PhaseCreate, PhaseListQuery, PhasePatch, ProjectTaskCreate, ProjectTaskListQuery, ProjectTaskPatch, DepartmentCreate, DepartmentPatch, HolidayCreate, HolidayListQuery, HolidayPatch, ProjectCreate, ProjectListQuery, ProjectPatch, ReferenceListQuery, RoleCreate, RolePatch, TimeoffTypeCreate, TimeoffTypePatch, AllocationCreate, AllocationPatch, IfMatchHeader, ScheduleQuery, PersonCreate, PersonPatch, TeamRemovalRequest, TimeoffCreate, TimeoffPatch, type ApiError, type HealthResponse, type ScheduleQuery as ScheduleQueryT } from "@wnext/contracts";
import type { Db, RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { createAllocation, deleteAllocation, updateAllocation } from "./allocations";
import { createPerson, updatePerson } from "./people";
import {
  createDepartment, createHoliday, createProject, createRole, createTimeoffType, deleteDepartment, deleteHoliday, deleteRole, deleteTimeoffType,
  departmentReader, holidayReader, projectReader, roleReader, timeoffTypeReader,
  updateDepartment, updateHoliday, updateProject, updateRole, updateTimeoffType,
} from "./reference";
import { getSchedule } from "./schedule";
import { addToTeam, getTeamRemovalSummary, removeFromTeam } from "./team";
import { createTimeoff, deleteTimeoff, updateTimeoff } from "./timeoffs";
import { clientReader, createClient, createPhase, createProjectTask, deleteClient, deletePhase, deleteProjectTask, phaseReader, projectTaskReader, updateClient, updatePhase, updateProjectTask } from "./project-structure";
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
export interface HttpReply { status: number; body: unknown }

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
};

const fail = (code: ApiError["code"], requestId: string, params: ApiError["params"] = {}): HttpReply =>
  ({ status: STATUS[code], body: { code, params, requestId } satisfies ApiError });

/** Chaîne de requête -> objet typé par le contrat. Clé répétée ou inconnue = VALIDATION_FAILED. */
/** Schéma de requête du contrat (z.object) : seules les clés et safeParse servent ici. */
interface QuerySchema { shape: object; safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } } }
function parseQuery<T>(schema: QuerySchema, search: URLSearchParams): T {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    if (values.length > 1 || !(key in schema.shape)) throw new ApiFailure("VALIDATION_FAILED", { field: key });
    const v = values[0]!;
    if (key === "includeInactive") {
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
const WRITERS = new Set(["owner", "admin", "project_manager"]);
const ADMINS = new Set(["owner", "admin"]);

function parseJsonBody<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } } }, raw: string | undefined): T {
  if (raw === undefined || raw === "") throw new ApiFailure("VALIDATION_FAILED", { field: "body" });
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new ApiFailure("VALIDATION_FAILED", { field: "body" }); }
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
  /** Configuration du compte : owner et admin seulement (403 avant la validation du corps). */
  adminOnly?: boolean;
  create(db: Db, ctx: RequestContext, raw: string | undefined): Promise<unknown>;
  update(db: Db, ctx: RequestContext, id: string, version: number, raw: string | undefined): Promise<unknown>;
  /** Lecture ouverte à tout membre authentifié ; absente = la ressource n'a pas encore de GET. */
  read?: { querySchema: QuerySchema; list(db: Db, ctx: RequestContext, q: never): Promise<unknown>; get(db: Db, ctx: RequestContext, id: string): Promise<unknown> };
  /** Absent = la ressource n'a pas de DELETE (ex. personnes : on désactive). */
  remove?(db: Db, ctx: RequestContext, id: string, version: number): Promise<void>;
}
function resource<C, P>(def: {
  pattern: RegExp; adminOnly?: boolean; read?: WriteResource["read"]; createSchema: Parser<C>; patchSchema: Parser<P>;
  create(db: Db, ctx: RequestContext, body: C): Promise<unknown>;
  update(db: Db, ctx: RequestContext, id: string, version: number, patch: P): Promise<unknown>;
  remove?(db: Db, ctx: RequestContext, id: string, version: number): Promise<void>;
}): WriteResource {
  return {
    pattern: def.pattern,
    adminOnly: def.adminOnly,
    read: def.read,
    create: (db, ctx, raw) => def.create(db, ctx, parseJsonBody(def.createSchema, raw)),
    update: (db, ctx, id, version, raw) => def.update(db, ctx, id, version, parseJsonBody(def.patchSchema, raw)),
    remove: def.remove,
  };
}
const WRITE_RESOURCES: WriteResource[] = [
  resource({ pattern: /^\/api\/v1\/allocations(?:\/([^/]+))?$/, createSchema: AllocationCreate, patchSchema: AllocationPatch, create: createAllocation, update: updateAllocation, remove: deleteAllocation }),
  resource({ pattern: /^\/api\/v1\/people(?:\/([^/]+))?$/, createSchema: PersonCreate, patchSchema: PersonPatch, create: createPerson, update: updatePerson }),
  resource({ pattern: /^\/api\/v1\/timeoffs(?:\/([^/]+))?$/, createSchema: TimeoffCreate, patchSchema: TimeoffPatch, create: createTimeoff, update: updateTimeoff, remove: deleteTimeoff }),
  resource({ adminOnly: true, pattern: /^\/api\/v1\/departments(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: departmentReader.list, get: departmentReader.get }, createSchema: DepartmentCreate, patchSchema: DepartmentPatch, create: createDepartment, update: updateDepartment, remove: deleteDepartment }),
  resource({ adminOnly: true, pattern: /^\/api\/v1\/roles(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: roleReader.list, get: roleReader.get }, createSchema: RoleCreate, patchSchema: RolePatch, create: createRole, update: updateRole, remove: deleteRole }),
  resource({ adminOnly: true, pattern: /^\/api\/v1\/timeoff-types(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: timeoffTypeReader.list, get: timeoffTypeReader.get }, createSchema: TimeoffTypeCreate, patchSchema: TimeoffTypePatch, create: createTimeoffType, update: updateTimeoffType, remove: deleteTimeoffType }),
  resource({ adminOnly: true, pattern: /^\/api\/v1\/holidays(?:\/([^/]+))?$/, read: { querySchema: HolidayListQuery, list: holidayReader.list, get: holidayReader.get }, createSchema: HolidayCreate, patchSchema: HolidayPatch, create: createHoliday, update: updateHoliday, remove: deleteHoliday }),
  resource({ pattern: /^\/api\/v1\/projects(?:\/([^/]+))?$/, read: { querySchema: ProjectListQuery, list: projectReader.list, get: projectReader.get }, createSchema: ProjectCreate, patchSchema: ProjectPatch, create: createProject, update: updateProject }),
  resource({ pattern: /^\/api\/v1\/clients(?:\/([^/]+))?$/, read: { querySchema: ReferenceListQuery, list: clientReader.list, get: clientReader.get }, createSchema: ClientCreate, patchSchema: ClientPatch, create: createClient, update: updateClient, remove: deleteClient }),
  resource({ pattern: /^\/api\/v1\/phases(?:\/([^/]+))?$/, read: { querySchema: PhaseListQuery, list: phaseReader.list, get: phaseReader.get }, createSchema: PhaseCreate, patchSchema: PhasePatch, create: createPhase, update: updatePhase, remove: deletePhase }),
  resource({ pattern: /^\/api\/v1\/project-tasks(?:\/([^/]+))?$/, read: { querySchema: ProjectTaskListQuery, list: projectTaskReader.list, get: projectTaskReader.get }, createSchema: ProjectTaskCreate, patchSchema: ProjectTaskPatch, create: createProjectTask, update: updateProjectTask, remove: deleteProjectTask }),
];

export async function dispatch(deps: HttpDeps, req: HttpRequest): Promise<HttpReply> {
  const requestId = deps.newRequestId?.() ?? randomUUID();
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/health") return { status: 200, body: { status: "ok", version: API_VERSION } satisfies HealthResponse };
    if (req.method === "POST" && url.pathname === REALTIME_TICKET_PATH && deps.tickets) {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      return { status: 200, body: deps.tickets.issue(ctx) };
    }
    if (req.method === "GET" && url.pathname === "/api/v1/schedule") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId); // l'auth passe avant la validation : pas d'oracle pour un anonyme
      return { status: 200, body: await getSchedule(deps.db, ctx, parseQuery<ScheduleQueryT>(ScheduleQuery, url.searchParams)) };
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
    for (const resource of WRITE_RESOURCES) {
      const m = resource.pattern.exec(url.pathname);
      if (!m) continue;
      let id: string | undefined;
      if (m[1] !== undefined) {
        try { id = decodeURIComponent(m[1]); } catch { id = "%"; } // séquence % illisible : identifiant qui ne désigne rien (404)
      }
      const reading = req.method === "GET" && resource.read !== undefined;
      const known = reading || (id === undefined ? req.method === "POST" : req.method === "PATCH" || (req.method === "DELETE" && resource.remove !== undefined));
      if (!known) break;
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (reading) {
        const read = resource.read!;
        if (id !== undefined) return { status: 200, body: await read.get(deps.db, ctx, id) };
        return { status: 200, body: await read.list(deps.db, ctx, parseQuery(read.querySchema, url.searchParams) as never) };
      }
      if (!(resource.adminOnly ? ADMINS : WRITERS).has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
      if (id === undefined) return { status: 201, body: await resource.create(deps.db, ctx, req.body) };
      const version = expectedVersion(req.headers);
      if (req.method === "DELETE") {
        await resource.remove!(deps.db, ctx, id, version);
        return { status: 204, body: undefined };
      }
      return { status: 200, body: await resource.update(deps.db, ctx, id, version, req.body) };
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
        res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
  });
}
