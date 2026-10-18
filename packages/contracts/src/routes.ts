import type { z } from "zod";
import { AllocationCreate, AllocationPatch, AllocationPathParams, IfMatchHeader, PersonAllocationList, PersonAllocationListQuery, ProjectAllocationList, ProjectAllocationListQuery, ProjectPathParams } from "./allocations";
import {
  ProjectBudgetLine, ProjectBudgetLineCreate, ProjectBudgetLineList, ProjectBudgetLineListQuery, ProjectBudgetLinePatch,
  ProjectExpense, ProjectExpenseCreate, ProjectExpenseList, ProjectExpenseListQuery, ProjectExpensePatch,
} from "./budget";
import { ApiError } from "./errors";
import { HealthResponse } from "./health";
import { REALTIME_TICKET_PATH, REALTIME_TICKET_TTL_SECONDS, RealtimeTicket } from "./realtime";
import { TeamBatchAdd, TeamBatchResult, TeamMemberList, TeamMembership, TeamPathParams, TeamProjectPathParams, TeamRemovalRequest, TeamRemovalResult, TeamRemovalSummary } from "./team";
import { PersonCreate, PersonList, PersonListQuery, PersonPatch, PersonPathParams, PersonProjectList, PersonProjectListQuery } from "./people";
import { ScheduleDepartment, ScheduleHoliday, SchedulePerson, ScheduleAllocation, ScheduleRole, ScheduleTimeoffType, ScheduleQuery, ScheduleResponse, ScheduleTimeoff } from "./schedule";
import {
  DepartmentCreate, DepartmentList, DepartmentPatch, HolidayCreate, HolidayList, HolidayListQuery, HolidayPatch, ProjectCreate, ProjectDetail,
  ProjectList, ProjectListQuery, ProjectPatch, ReferenceListQuery, ReferencePathParams, RoleCreate, RoleList, RolePatch, TimeoffTypeCreate,
  TimeoffTypeList, TimeoffTypePatch,
} from "./reference";
import {
  Client, ClientCreate, ClientList, ClientPatch, Milestone, MilestoneCreate, MilestoneList, MilestoneListQuery, MilestonePatch, Phase, PhaseCreate, PhaseList, PhaseListQuery, PhasePatch, ProjectTask, ProjectTaskCreate,
  ProjectTaskList, ProjectTaskListQuery, ProjectTaskPatch,
} from "./project-structure";
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

// Entites de reference : GET (liste paginee, une entite), POST, PATCH (If-Match) et, sauf projets, DELETE (refuse tant que l'entite est referencee).
function referenceRoutes(def: {
  path: string; name: string; label: string; create: z.ZodType; patch: z.ZodType; response: z.ZodType;
  listQuery: z.ZodObject; list: z.ZodType; admin: boolean; remove: boolean; unique?: string; refs: string; restricted?: boolean;
}): RouteContract[] {
  const who = def.admin ? "owner ou admin" : "owner, admin ou project_manager";
  const forbidden = { description: `Role insuffisant, ${who} requis (FORBIDDEN)`, schema: ApiError };
  const exists: Record<number, { description: string; schema: typeof ApiError }> = def.unique ? { 409: { description: `Deja existant (ALREADY_EXISTS) : ${def.unique}`, schema: ApiError } } : {};
  const readForbidden: Record<number, { description: string; schema: typeof ApiError }> = def.restricted ? { 403: forbidden } : {};
  const common = { 401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError }, 403: forbidden };
  const out: RouteContract[] = [
    {
      method: "get", path: def.path, operationId: `list${def.name}s`, summary: `Lister : ${def.label} (pagine, tri par id ; ${def.restricted ? "owner, admin ou project_manager" : "tout membre authentifie"})`, query: def.listQuery,
      responses: {
        200: { description: `Page de ${def.label}s (items, page.nextCursor, page.total)`, schema: def.list },
        400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
        401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
        ...readForbidden,
        500: { description: "Erreur interne", schema: ApiError },
      },
    },
    {
      method: "get", path: `${def.path}/{id}`, operationId: `get${def.name}`, summary: `Lire : ${def.label} (${def.restricted ? "owner, admin ou project_manager" : "tout membre authentifie"})`, params: ReferencePathParams,
      responses: {
        200: { description: `${def.label} (avec sa version courante)`, schema: def.response },
        401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
        ...readForbidden,
        404: { description: "Entite inconnue ou hors compte (NOT_FOUND)", schema: ApiError },
        500: { description: "Erreur interne", schema: ApiError },
      },
    },
    {
      method: "post", path: def.path, operationId: `create${def.name}`, summary: `Creer : ${def.label}`, body: def.create,
      responses: {
        201: { description: `${def.label} cree`, schema: def.response },
        400: { description: "Corps invalide (VALIDATION_FAILED)", schema: ApiError },
        ...common,
        404: { description: `Reference inconnue (NOT_FOUND, params.entity) : ${def.refs}`, schema: ApiError },
        ...exists,
        500: { description: "Erreur interne", schema: ApiError },
      },
    },
    {
      method: "patch", path: `${def.path}/{id}`, operationId: `update${def.name}`, summary: `Modifier : ${def.label} (verrou optimiste If-Match)`,
      params: ReferencePathParams, headers: IfMatchHeader, body: def.patch,
      responses: {
        200: { description: `${def.label} modifie (nouvelle version)`, schema: def.response },
        400: { description: "Corps ou en-tete invalide (VALIDATION_FAILED)", schema: ApiError },
        ...common,
        404: { description: "Entite ou reference inconnue (NOT_FOUND, params.entity)", schema: ApiError },
        409: { description: `Version perimee (VERSION_CONFLICT, params.currentVersion)${def.unique ? ` ou deja existant (ALREADY_EXISTS) : ${def.unique}` : ""}`, schema: ApiError },
        428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
        500: { description: "Erreur interne", schema: ApiError },
      },
    },
  ];
  if (def.remove) out.push({
    method: "delete", path: `${def.path}/{id}`, operationId: `delete${def.name}`, summary: `Supprimer : ${def.label} (verrou optimiste If-Match ; refuse si reference)`,
    params: ReferencePathParams, headers: IfMatchHeader,
    responses: {
      204: { description: "Supprime (journalise dans delete_log, BR-14)" },
      400: { description: "En-tete invalide (VALIDATION_FAILED)", schema: ApiError },
      ...common,
      404: { description: "Entite inconnue (NOT_FOUND)", schema: ApiError },
      409: { description: "Version perimee (VERSION_CONFLICT, params.currentVersion) ou encore referencee (REFERENCE_IN_USE, params = nombre de lignes liees)", schema: ApiError },
      428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  });
  return out;
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
    method: "post",
    path: REALTIME_TICKET_PATH,
    operationId: "createRealtimeTicket",
    summary: `Ticket d'upgrade du temps reel (usage unique, ${REALTIME_TICKET_TTL_SECONDS} s) pour les clients qui ne peuvent pas poser d'en-tete sur un WebSocket ; tout membre authentifie`,
    responses: {
      200: { description: "Ticket a passer dans ?ticket= a l'upgrade", schema: RealtimeTicket },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
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
    method: "get",
    path: "/api/v1/allocations/{id}",
    operationId: "getAllocation",
    summary: "Lire une allocation (avec sa version ; tout membre authentifie)",
    params: AllocationPathParams,
    responses: {
      200: { description: "Allocation", schema: ScheduleAllocation },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      404: { description: "Allocation inconnue ou hors compte (NOT_FOUND)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/api/v1/projects/{projectId}/allocations",
    operationId: "listProjectAllocations",
    summary: "Allocations d'un projet sur une fenetre (chevauchement ; pagine, tri par id ; tout membre authentifie)",
    params: ProjectPathParams,
    query: ProjectAllocationListQuery,
    responses: {
      200: { description: "Page d'allocations (items, page.nextCursor, page.total)", schema: ProjectAllocationList },
      400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_RANGE_INVALID, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      404: { description: "Projet inconnu ou hors compte (NOT_FOUND, params.entity = project)", schema: ApiError },
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
  {
    method: "get",
    path: "/api/v1/people",
    operationId: "listPeople",
    summary: "Lister les personnes (pagine, tri par id ; actives par defaut ; tout membre authentifie)",
    query: PersonListQuery,
    responses: {
      200: { description: "Page de personnes (items, page.nextCursor, page.total)", schema: PersonList },
      400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/api/v1/people/{id}",
    operationId: "getPerson",
    summary: "Lire une personne (desactivee comprise, avec sa version ; tout membre authentifie)",
    params: PersonPathParams,
    responses: {
      200: { description: "Personne", schema: SchedulePerson },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      404: { description: "Personne inconnue ou hors compte (NOT_FOUND)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/api/v1/people/{id}/projects",
    operationId: "listPersonProjects",
    summary: "Projets d'une personne : equipe ou allocations (pagine, tri par id de projet ; archives exclus par defaut ; tout membre authentifie)",
    params: PersonPathParams,
    query: PersonProjectListQuery,
    responses: {
      200: { description: "Page de projets avec inTeam et allocationCount", schema: PersonProjectList },
      400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      404: { description: "Personne inconnue ou hors compte (NOT_FOUND)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/api/v1/people/{id}/allocations",
    operationId: "listPersonAllocations",
    summary: "Allocations d'une personne sur une fenetre (chevauchement ; pagine, tri par id ; tout membre authentifie)",
    params: PersonPathParams,
    query: PersonAllocationListQuery,
    responses: {
      200: { description: "Page d'allocations (items, page.nextCursor, page.total)", schema: PersonAllocationList },
      400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_RANGE_INVALID, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      404: { description: "Personne inconnue ou hors compte (NOT_FOUND, params.entity = person)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "post",
    path: "/api/v1/people",
    operationId: "createPerson",
    summary: "Creer une personne planifiable",
    body: PersonCreate,
    responses: {
      201: { description: "Personne creee", schema: SchedulePerson },
      400: { description: "Corps invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Departement ou role inconnu (NOT_FOUND, params.entity)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "patch",
    path: "/api/v1/people/{id}",
    operationId: "updatePerson",
    summary: "Modifier ou desactiver une personne (verrou optimiste If-Match ; pas de suppression)",
    params: PersonPathParams,
    headers: IfMatchHeader,
    body: PersonPatch,
    responses: {
      200: { description: "Personne modifiee (nouvelle version)", schema: SchedulePerson },
      400: { description: "Corps ou en-tete invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Personne, departement ou role inconnu (NOT_FOUND)", schema: ApiError },
      409: { description: "Version perimee (VERSION_CONFLICT, params.currentVersion)", schema: ApiError },
      428: { description: "If-Match absent (PRECONDITION_REQUIRED)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/api/v1/projects/{projectId}/team/{personId}/removal-summary",
    operationId: "getTeamRemovalSummary",
    summary: "Recapitulatif du retrait d'une personne d'un projet (BR-10) : ce qui serait supprime, sans rien ecrire",
    params: TeamPathParams,
    responses: {
      200: { description: "Recapitulatif a presenter avant confirmation", schema: TeamRemovalSummary },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Projet ou personne inconnu (NOT_FOUND, params.entity)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "post",
    path: "/api/v1/projects/{projectId}/team/{personId}/removal",
    operationId: "removeFromTeam",
    summary: "Retirer une personne d'un projet : supprime ses allocations et ses temps saisis sur ce projet, apres confirmation (BR-10)",
    params: TeamPathParams,
    body: TeamRemovalRequest,
    responses: {
      200: { description: "Retrait execute ; compte de ce qui a ete supprime", schema: TeamRemovalResult },
      400: { description: "Corps invalide (VALIDATION_FAILED)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Projet ou personne inconnu (NOT_FOUND, params.entity)", schema: ApiError },
      409: { description: "Confirmation perimee (TEAM_REMOVAL_STALE_CONFIRMATION, params = nouveau recapitulatif) ou temps verrouilles (TEAM_REMOVAL_LOCKED_LOGS)", schema: ApiError },
      428: { description: "Confirmation absente alors qu'il y a des suppressions (TEAM_REMOVAL_CONFIRMATION_REQUIRED, params = recapitulatif)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/api/v1/projects/{projectId}/team",
    operationId: "listProjectTeam",
    summary: "Equipe d'un projet (pagine, tri par personId ; tout membre authentifie)",
    params: TeamProjectPathParams,
    query: ReferenceListQuery,
    responses: {
      200: { description: "Page de membres (items, page.nextCursor, page.total) ; equipe vide = liste vide", schema: TeamMemberList },
      400: { description: "Requete invalide (VALIDATION_FAILED, SCHEDULE_CURSOR_INVALID)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      404: { description: "Projet inconnu ou hors compte (NOT_FOUND, params.entity = project)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "post",
    path: "/api/v1/projects/{projectId}/team",
    operationId: "addManyToTeam",
    summary: "Ajouter plusieurs personnes a l'equipe d'un projet (une transaction, tout ou rien, idempotent)",
    params: TeamProjectPathParams,
    body: TeamBatchAdd,
    responses: {
      200: { description: "Personnes ajoutees (added) et deja presentes (alreadyInTeam), dans l'ordre du corps", schema: TeamBatchResult },
      400: { description: "Corps invalide : liste vide, plus de 500 personnes ou doublon (VALIDATION_FAILED, field = personIds)", schema: ApiError },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Projet ou personne inconnu : rien n'est ecrit (NOT_FOUND, params.entity, et params.personId pour une personne)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  {
    method: "put",
    path: "/api/v1/projects/{projectId}/team/{personId}",
    operationId: "addToTeam",
    summary: "Ajouter une personne a l'equipe d'un projet (idempotent, sans corps)",
    params: TeamPathParams,
    responses: {
      200: { description: "Personne dans l'equipe ; added=false si elle y etait deja", schema: TeamMembership },
      401: { description: "Non authentifie (UNAUTHENTICATED)", schema: ApiError },
      403: { description: "Role insuffisant (FORBIDDEN)", schema: ApiError },
      404: { description: "Projet ou personne inconnu (NOT_FOUND, params.entity)", schema: ApiError },
      500: { description: "Erreur interne", schema: ApiError },
    },
  },
  ...referenceRoutes({ path: "/api/v1/departments", name: "Department", listQuery: ReferenceListQuery, list: DepartmentList, label: "departement", create: DepartmentCreate, patch: DepartmentPatch, response: ScheduleDepartment, admin: true, remove: true, unique: "nom", refs: "aucune" }),
  ...referenceRoutes({ path: "/api/v1/roles", name: "Role", listQuery: ReferenceListQuery, list: RoleList, label: "role", create: RoleCreate, patch: RolePatch, response: ScheduleRole, admin: true, remove: true, unique: "nom", refs: "aucune" }),
  ...referenceRoutes({ path: "/api/v1/timeoff-types", name: "TimeoffType", listQuery: ReferenceListQuery, list: TimeoffTypeList, label: "type de conge", create: TimeoffTypeCreate, patch: TimeoffTypePatch, response: ScheduleTimeoffType, admin: true, remove: true, unique: "nom", refs: "aucune" }),
  ...referenceRoutes({ path: "/api/v1/holidays", name: "Holiday", listQuery: HolidayListQuery, list: HolidayList, label: "jour ferie", create: HolidayCreate, patch: HolidayPatch, response: ScheduleHoliday, admin: true, remove: true, unique: "date, pays, departement et nom identiques", refs: "department" }),
  ...referenceRoutes({ path: "/api/v1/projects", name: "Project", listQuery: ProjectListQuery, list: ProjectList, label: "projet", create: ProjectCreate, patch: ProjectPatch, response: ProjectDetail, admin: false, remove: false, unique: "code projet (params.field = projectCode)", refs: "person (chef de projet)" }),
  ...referenceRoutes({ path: "/api/v1/clients", name: "Client", listQuery: ReferenceListQuery, list: ClientList, label: "client", create: ClientCreate, patch: ClientPatch, response: Client, admin: false, remove: true, refs: "aucune" }),
  ...referenceRoutes({ path: "/api/v1/phases", name: "Phase", listQuery: PhaseListQuery, list: PhaseList, label: "phase", create: PhaseCreate, patch: PhasePatch, response: Phase, admin: false, remove: true, refs: "project" }),
  ...referenceRoutes({ path: "/api/v1/project-tasks", name: "ProjectTask", listQuery: ProjectTaskListQuery, list: ProjectTaskList, label: "tache de projet", create: ProjectTaskCreate, patch: ProjectTaskPatch, response: ProjectTask, admin: false, remove: true, refs: "project, phase (du meme projet)" }),
  ...referenceRoutes({ path: "/api/v1/milestones", name: "Milestone", listQuery: MilestoneListQuery, list: MilestoneList, label: "jalon", create: MilestoneCreate, patch: MilestonePatch, response: Milestone, admin: false, remove: true, refs: "project, phase (du meme projet)" }),
  ...referenceRoutes({ path: "/api/v1/project-expenses", name: "ProjectExpense", listQuery: ProjectExpenseListQuery, list: ProjectExpenseList, label: "depense de projet", create: ProjectExpenseCreate, patch: ProjectExpensePatch, response: ProjectExpense, admin: false, remove: true, refs: "project", restricted: true }),
  ...referenceRoutes({ path: "/api/v1/project-budget-lines", name: "ProjectBudgetLine", listQuery: ProjectBudgetLineListQuery, list: ProjectBudgetLineList, label: "ligne de budget", create: ProjectBudgetLineCreate, patch: ProjectBudgetLinePatch, response: ProjectBudgetLine, admin: false, remove: true, unique: "une ligne par cible (tache ou personne) et par projet (params.entity = budget_line)", refs: "project, project_task (du meme projet), person", restricted: true }),
];
