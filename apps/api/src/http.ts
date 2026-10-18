import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AllocationCreate, AllocationPatch, IfMatchHeader, ScheduleQuery, type ApiError, type HealthResponse, type ScheduleQuery as ScheduleQueryT } from "@wnext/contracts";
import type { Db, RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { createAllocation, deleteAllocation, updateAllocation } from "./allocations";
import { getSchedule } from "./schedule";
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
    const alloc = /^\/api\/v1\/allocations(?:\/([^/]+))?$/.exec(url.pathname);
    if (alloc) {
      const id = alloc[1] !== undefined ? decodeURIComponent(alloc[1]) : undefined;
      const known = id === undefined ? req.method === "POST" : req.method === "PATCH" || req.method === "DELETE";
      if (known) {
        const ctx = await deps.authenticate(req.headers);
        if (!ctx) return fail("UNAUTHENTICATED", requestId);
        if (!WRITERS.has(ctx.role)) return fail("FORBIDDEN", requestId, { role: ctx.role });
        if (id === undefined) return { status: 201, body: await createAllocation(deps.db, ctx, parseJsonBody(AllocationCreate, req.body)) };
        const version = expectedVersion(req.headers);
        if (req.method === "DELETE") {
          await deleteAllocation(deps.db, ctx, id, version);
          return { status: 204, body: undefined };
        }
        return { status: 200, body: await updateAllocation(deps.db, ctx, id, version, parseJsonBody(AllocationPatch, req.body)) };
      }
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
