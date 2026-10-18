import type { z } from "zod";
import { ApiError } from "./errors";
import { HealthResponse } from "./health";
import { ScheduleQuery, ScheduleResponse } from "./schedule";

// Table des routes : donnees pures (zod uniquement). La spec OpenAPI en est derivee
// hors serveur par packages/contracts-tools.
export interface RouteContract {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  /** Parametres de requete (valeurs scalaires ou tableaux de scalaires). */
  query?: z.ZodObject;
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
  {
    method: "get",
    path: "/api/v1/schedule",
    operationId: "getSchedule",
    summary: "Fenetre du Schedule (personnes, allocations, conges, feries, projets)",
    query: ScheduleQuery,
    responses: {
      200: { description: "Fenetre demandee", schema: ScheduleResponse },
      400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_RANGE_INVALID, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
];
