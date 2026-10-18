import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ScheduleQuery, type ApiError, type HealthResponse, type ScheduleQuery as ScheduleQueryT } from "@wnext/contracts";
import type { Db, RequestContext } from "./db";
import { ApiFailure } from "./failure";
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
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (err) {
    if (err instanceof ApiFailure) return fail(err.code, requestId, err.params);
    deps.onError?.(err, requestId);
    return fail("INTERNAL_ERROR", requestId); // jamais de détail interne vers le client
  }
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((incoming: IncomingMessage, res: ServerResponse) => {
    dispatch(deps, { method: incoming.method ?? "GET", url: incoming.url ?? "/", headers: incoming.headers }).then((reply) => {
      res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(reply.body));
    });
  });
}
