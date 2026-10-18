import type { z } from "zod";
import { ApiError } from "./errors";
import { HealthResponse } from "./health";

// Table des routes : donnees pures (zod uniquement). La spec OpenAPI en est derivee
// hors serveur par packages/contracts-tools.
export interface RouteContract {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  responses: Record<number, { description: string; schema: z.ZodType }>;
}

export const routes: RouteContract[] = [
  {
    method: "get",
    path: "/api/v1/health",
    operationId: "getHealth",
    summary: "Etat du service",
    responses: {
      200: { description: "Service operationnel", schema: HealthResponse },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
];
