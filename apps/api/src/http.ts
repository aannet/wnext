import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AllocationCreate, AllocationPatch, IfMatchHeader, ScheduleQuery, PersonCreate, PersonPatch, TimeoffCreate, TimeoffPatch, type ApiError, type HealthResponse, type ScheduleQuery as ScheduleQueryT } from "@wnext/contracts";
import type { Db, RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { createAllocation, deleteAllocation, updateAllocation } from "./allocations";
import { createPerson, updatePerson } from "./people";
import { getSchedule } from "./schedule";
import { createTimeoff, deleteTimeoff, updateTimeoff } from "./timeoffs";
import { API_VERSION } from "./version";

// Couche HTTP sans framework. `dispatch` est pure (requête -> statut + corps) : testable sans socket.
// L'authentification est injectée : le mécanisme (session, JWT de l'IdP) reste à décider ; elle renvoie null si non authentifié.
// Les erreurs portent un code stable, jamais de texte localisé (ADR-003 §4).

export interface HttpDeps {
  db: Db;
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<RequestContext | null>;
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
  TEAM_REMOVAL_CONFIRMATION_REQUIRED: 428,
  TEAM_REMOVAL_STALE_CONFIRMATION: 409,
  TEAM_REMOVAL_LOCKED_LOGS: 409,
};

const fail = (code: ApiError["code"], requestId: string, params: ApiError["params"] = {}): HttpReply =>
  ({ status: STATUS[code], body: { code, params, requestId } satisfies ApiError });

/** Chaîne de requête -> objet typé par le contrat. Clé répétée ou inconnue = VALIDATION_FAILED. */
function parseScheduleQuery(search: URLSearchParams): ScheduleQueryT {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    if (values.length > 1 || !(key in ScheduleQuery.shape)) throw new ApiFailure("VALIDATION_FAILED", { field: key });
    const v = values[0]!;
    if (key === "includeInactive") {
      if (v !== "true" && v !== "false") throw new ApiFailure("VALIDATION_FAILED", { field: key });
      raw[key] = v === "true";
    } else if (key === "limit") {
      raw[key] = v.trim() === "" ? NaN : Number(v);
    } else raw[key] = v;
  }
  const parsed = ScheduleQuery.safeParse(raw);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "query");
    throw new ApiFailure("VALIDATION_FAILED", { field });
  }
  return parsed.data;
}

const MAX_BODY_BYTES = 1_000_000;
const WRITERS = new Set(["owner", "admin", "project_manager"]);

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
  create(db: Db, ctx: RequestContext, raw: string | undefined): Promise<unknown>;
  update(db: Db, ctx: RequestContext, id: string, version: number, raw: string | undefined): Promise<unknown>;
  /** Absent = la ressource n'a pas de DELETE (ex. personnes : on désactive). */
  remove?(db: Db, ctx: RequestContext, id: string, version: number): Promise<void>;
}
function resource<C, P>(def: {
  pattern: RegExp; createSchema: Parser<C>; patchSchema: Parser<P>;
  create(db: Db, ctx: RequestContext, body: C): Promise<unknown>;
  update(db: Db, ctx: RequestContext, id: string, version: number, patch: P): Promise<unknown>;
  remove?(db: Db, ctx: RequestContext, id: string, version: number): Promise<void>;
}): WriteResource {
  return {
    pattern: def.pattern,
    create: (db, ctx, raw) => def.create(db, ctx, parseJsonBody(def.createSchema, raw)),
    update: (db, ctx, id, version, raw) => def.update(db, ctx, id, version, parseJsonBody(def.patchSchema, raw)),
    remove: def.remove,
  };
}
const WRITE_RESOURCES: WriteResource[] = [
  resource({ pattern: /^\/api\/v1\/allocations(?:\/([^/]+))?$/, createSchema: AllocationCreate, patchSchema: AllocationPatch, create: createAllocation, update: updateAllocation, remove: deleteAllocation }),
  resource({ pattern: /^\/api\/v1\/people(?:\/([^/]+))?$/, createSchema: PersonCreate, patchSchema: PersonPatch, create: createPerson, update: updatePerson }),
  resource({ pattern: /^\/api\/v1\/timeoffs(?:\/([^/]+))?$/, createSchema: TimeoffCreate, patchSchema: TimeoffPatch, create: createTimeoff, update: updateTimeoff, remove: deleteTimeoff }),
];

export async function dispatch(deps: HttpDeps, req: HttpRequest): Promise<HttpReply> {
  const requestId = deps.newRequestId?.() ?? randomUUID();
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/health") return { status: 200, body: { status: "ok", version: API_VERSION } satisfies HealthResponse };
    if (req.method === "GET" && url.pathname === "/api/v1/schedule") {
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId); // l'auth passe avant la validation : pas d'oracle pour un anonyme
      return { status: 200, body: await getSchedule(deps.db, ctx, parseScheduleQuery(url.searchParams)) };
    }
    for (const resource of WRITE_RESOURCES) {
      const m = resource.pattern.exec(url.pathname);
      if (!m) continue;
      let id: string | undefined;
      if (m[1] !== undefined) {
        try { id = decodeURIComponent(m[1]); } catch { id = "%"; } // séquence % illisible : identifiant qui ne désigne rien (404)
      }
      const known = id === undefined ? req.method === "POST" : req.method === "PATCH" || (req.method === "DELETE" && resource.remove !== undefined);
      if (!known) break;
      const ctx = await deps.authenticate(req.headers);
      if (!ctx) return fail("UNAUTHENTICATED", requestId);
      if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
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
