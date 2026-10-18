import type { z } from "zod";
import { AllocationCreate, AllocationPatch, AllocationPathParams, IfMatchHeader } from "./allocations";
import { ApiError } from "./errors";
import { HealthResponse } from "./health";
import { ScheduleAllocation, ScheduleQuery, ScheduleResponse, ScheduleTimeoff } from "./schedule";
import { TimeoffCreate, TimeoffPatch, TimeoffPathParams } from "./timeoffs";

// Table des routes : donnees pures (zod uniquement). La spec OpenAPI en est derivee
// hors serveur par packages/contracts-tools.
export interface RouteContract {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  summary: string;
  /** Parametres de requete (valeurs scalaires ou tableaux de scalaires). */
  query?: z.ZodObject;
  /** Parametres de chemin (`{nom}` dans `path`). */
  params?: z.ZodObject;
  /** En-tetes de requete ; la cle est le nom exact de l'en-tete (ex. "If-Match"). */
  headers?: z.ZodObject;
  /** Corps JSON de la requete (toujours requis). */
  body?: z.ZodType;
  /** `schema` absent = reponse sans corps (204). */
  responses: Record<number, { description: string; schema?: z.ZodType }>;
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
  {
    method: "post",
    path: "/api/v1/allocations",
    operationId: "createAllocation",
    summary: "Creer une allocation (la sur-allocation n'est jamais refusee, BR-01)",
    body: AllocationCreate,
    responses: {
      201: { description: "Allocation creee", schema: ScheduleAllocation },
      400: { description: "Corps invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Personne, projet, phase ou tache inconnue (NOT_FOUND, params.entity)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "patch",
    path: "/api/v1/allocations/{id}",
    operationId: "updateAllocation",
    summary: "Modifier ou deplacer une allocation (verrou optimiste If-Match)",
    params: AllocationPathParams,
    headers: IfMatchHeader,
    body: AllocationPatch,
    responses: {
      200: { description: "Allocation modifiee (nouvelle version)", schema: ScheduleAllocation },
      400: { description: "Corps ou en-tete invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Allocation ou reference inconnue (NOT_FOUND)", schema: ApiError },
      409: { description: "Version perimee (VERSION_CONFLICT, params.currentVersion) : recharger puis rejouer", schema: ApiError },
      428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "delete",
    path: "/api/v1/allocations/{id}",
    operationId: "deleteAllocation",
    summary: "Supprimer une allocation (verrou optimiste If-Match)",
    params: AllocationPathParams,
    headers: IfMatchHeader,
    responses: {
      204: { description: "Supprimee (journalisee dans delete_log, BR-14)" },
      400: { description: "En-tete invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Allocation inconnue (NOT_FOUND)", schema: ApiError },
      409: { description: "Version perimee (VERSION_CONFLICT, params.currentVersion)", schema: ApiError },
      428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "post",
    path: "/api/v1/timeoffs",
    operationId: "createTimeoff",
    summary: "Creer un conge (jamais refuse pour cause d'allocations existantes, BR-04)",
    body: TimeoffCreate,
    responses: {
      201: { description: "Conge cree", schema: ScheduleTimeoff },
      400: { description: "Corps invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Personne ou type de conge inconnu (NOT_FOUND, params.entity)", schema: ApiError },
      409: { description: "Chevauche un autre conge de la personne (TIMEOFF_OVERLAP)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "patch",
    path: "/api/v1/timeoffs/{id}",
    operationId: "updateTimeoff",
    summary: "Modifier un conge (verrou optimiste If-Match)",
    params: TimeoffPathParams,
    headers: IfMatchHeader,
    body: TimeoffPatch,
    responses: {
      200: { description: "Conge modifie (nouvelle version)", schema: ScheduleTimeoff },
      400: { description: "Corps ou en-tete invalide, ou etat resultant incoherent (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Conge ou reference inconnue (NOT_FOUND)", schema: ApiError },
      409: { description: "Version perimee (VERSION_CONFLICT, params.currentVersion) ou chevauchement (TIMEOFF_OVERLAP)", schema: ApiError },
      428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "delete",
    path: "/api/v1/timeoffs/{id}",
    operationId: "deleteTimeoff",
    summary: "Supprimer un conge (verrou optimiste If-Match)",
    params: TimeoffPathParams,
    headers: IfMatchHeader,
    responses: {
      204: { description: "Supprime (journalise dans delete_log, BR-14)" },
      400: { description: "En-tete invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Conge inconnu (NOT_FOUND)", schema: ApiError },
      409: { description: "Version perimee (VERSION_CONFLICT, params.currentVersion)", schema: ApiError },
      428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
];
