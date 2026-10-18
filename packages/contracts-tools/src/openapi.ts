import "./zod-setup";
import { OpenApiGeneratorV31, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ApiError, HealthResponse, routes } from "@wnext/contracts";

export const API_VERSION = "1.0.0";

export function buildSpec(): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  registry.register("ApiError", ApiError);
  registry.register("HealthResponse", HealthResponse);
  for (const r of routes) {
    registry.registerPath({
      method: r.method,
      path: r.path,
      operationId: r.operationId,
      summary: r.summary,
      request: r.query || r.params || r.headers || r.body
        ? {
            ...(r.params && { params: r.params }),
            ...(r.query && { query: r.query }),
            ...(r.headers && { headers: r.headers }),
            ...(r.body && { body: { required: true, content: { "application/json": { schema: r.body } } } }),
          }
        : undefined,
      responses: Object.fromEntries(
        Object.entries(r.responses).map(([code, v]) => [
          code,
          { description: v.description, content: { "application/json": { schema: v.schema } } },
        ]),
      ),
    });
  }
  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "WNEXT API interne", version: API_VERSION },
  });
  return doc as unknown as Record<string, unknown>;
}
