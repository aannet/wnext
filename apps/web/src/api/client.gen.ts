// GENERE par packages/contracts-tools (npm run generate:contract) a partir de
// packages/contracts/openapi.json. Ne pas editer a la main.

export interface ApiError {
  code: ErrorCode;
  params: {
    [key: string]: string | number | boolean;
  };
  requestId: string;
}

export type ErrorCode = "INTERNAL_ERROR" | "VALIDATION_FAILED" | "UNAUTHENTICATED";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
}

export interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
}
export type Fetcher = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export type ApiResult<T, E> = { ok: true; status: number; data: T } | { ok: false; status: number; error: E };

export function createClient(options: { baseUrl: string; fetch: Fetcher }) {
  return {
    /** Etat du service (GET /api/v1/health) */
    async getHealth(): Promise<ApiResult<HealthResponse, ApiError>> {
      const res = await options.fetch(options.baseUrl + "/api/v1/health", { method: "GET", headers: { accept: "application/json" } });
      const body = await res.json();
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, data: body as HealthResponse }
        : { ok: false, status: res.status, error: body as ApiError };
    },
  };
}
