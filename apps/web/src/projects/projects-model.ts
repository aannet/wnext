// Logique pure de l'écran Projets : filtres de la liste, validation du formulaire de création et d'édition, traduction des
// erreurs de l'API en clés de messages, droits d'écriture. Aucune dépendance à React : testable seule.
import type { Client, Me, ProjectDetail, ScheduleResponse } from "@wnext/contracts";
import type { MessageKey } from "../i18n";
import { parseHex } from "../schedule/block-colors";
import type { ProjectInput, ProjectsError, ProjectStatus } from "../data/projects-source";

export const STATUSES: readonly ProjectStatus[] = ["tentative", "planned", "in_progress", "on_hold", "completed", "archived"];
export const STATUS_KEY: Record<ProjectStatus, MessageKey> = {
  tentative: "projects.status.tentative", planned: "projects.status.planned", in_progress: "projects.status.in_progress",
  on_hold: "projects.status.on_hold", completed: "projects.status.completed", archived: "projects.status.archived",
};

/** Création et édition de projets : owner, admin et project_manager ; member et guest lisent. L'API reste seule juge. */
export const canEditProjects = (me: Me) => me.role === "owner" || me.role === "admin" || me.role === "project_manager";

export interface ProjectFilters { search: string; clientId: string; status: "" | ProjectStatus }
export const NO_FILTERS: ProjectFilters = { search: "", clientId: "", status: "" };
/** Valeur du filtre client pour « sans client ». */
export const NO_CLIENT = "none";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** Liste filtrée et triée par nom. Les projets archivés n'apparaissent que si on les demande (filtre statut). */
export function filterProjects(projects: readonly ProjectDetail[], filters: ProjectFilters): ProjectDetail[] {
  const q = fold(filters.search.trim());
  return projects
    .filter((p) => {
      if (filters.status ? p.status !== filters.status : p.status === "archived") return false;
      if (filters.clientId === NO_CLIENT ? p.clientId !== null : filters.clientId && p.clientId !== filters.clientId) return false;
      return !q || fold(p.name).includes(q) || fold(p.projectCode ?? "").includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export const clientName = (clients: readonly Client[], id: string | null) => (id === null ? "" : (clients.find((c) => c.id === id)?.name ?? ""));

// --- Formulaire ---------------------------------------------------------------------------------------------------------
export interface FormValues {
  name: string;
  clientId: string;       // "" = sans client
  newClientName: string;  // non vide : client créé à la volée (prioritaire sur clientId)
  projectCode: string;
  color: string;
  startDate: string;
  endDate: string;
  status: ProjectStatus;
}
export type FormField = "name" | "projectCode" | "color" | "endDate" | "newClientName";
export type FormErrors = Partial<Record<FormField, MessageKey>>;

export function valuesOf(p: ProjectDetail): FormValues {
  return {
    name: p.name, clientId: p.clientId ?? "", newClientName: "", projectCode: p.projectCode ?? "", color: p.color,
    startDate: p.startDate ?? "", endDate: p.endDate ?? "", status: p.status,
  };
}

/** Validation locale, avant tout appel (l'API valide à nouveau et reste juge : code déjà pris par un projet non chargé, par exemple). */
export function validateForm(v: FormValues, others: readonly Pick<ProjectDetail, "projectCode">[], clients: readonly Client[]): FormErrors {
  const e: FormErrors = {};
  if (!v.name.trim()) e.name = "projects.form.error.name";
  const code = v.projectCode.trim();
  if (code && others.some((p) => p.projectCode === code)) e.projectCode = "projects.form.error.code_taken";
  if (!parseHex(v.color) || v.color.trim().length !== 7) e.color = "projects.form.error.color";
  if (v.startDate && v.endDate && v.endDate < v.startDate) e.endDate = "projects.form.error.dates";
  const fresh = v.newClientName.trim();
  if (fresh && clients.some((c) => c.name.toLocaleLowerCase() === fresh.toLocaleLowerCase())) e.newClientName = "projects.form.error.client_exists";
  return e;
}

export function inputOf(v: FormValues, clientId: string | null): ProjectInput {
  return {
    name: v.name.trim(), projectCode: v.projectCode.trim() || null, clientId, color: v.color.trim().toUpperCase(),
    startDate: v.startDate || null, endDate: v.endDate || null, status: v.status,
  };
}

/** Champs modifiés d'un projet (PATCH n'envoie que ce qui change) ; vide si rien n'a bougé. */
export function diffOf(p: ProjectDetail, v: FormValues, clientId: string | null): Partial<ProjectInput> {
  const next = inputOf(v, clientId);
  const out: Partial<ProjectInput> = {};
  if (next.name !== p.name) out.name = next.name;
  if (next.projectCode !== p.projectCode) out.projectCode = next.projectCode;
  if (next.clientId !== p.clientId) out.clientId = next.clientId;
  if (next.color.toUpperCase() !== p.color.toUpperCase()) out.color = next.color;
  if (next.startDate !== p.startDate) out.startDate = next.startDate;
  if (next.endDate !== p.endDate) out.endDate = next.endDate;
  if (next.status !== p.status) out.status = next.status;
  return out;
}

// --- Erreurs de l'API -----------------------------------------------------------------------------------------------------
/** Clé du message d'une erreur d'écriture. Le contexte dit s'il s'agit d'un projet, d'un client ou d'une tâche. */
export function errorKey(error: ProjectsError): MessageKey {
  switch (error.code) {
    case "ALREADY_EXISTS": return error.params.field === "projectCode" ? "projects.error.code_taken" : "projects.error.exists";
    case "FORBIDDEN": return error.params.scope === "project" ? "projects.error.forbidden_project" : "projects.error.forbidden";
    case "VERSION_CONFLICT": return "projects.error.conflict";
    case "VALIDATION_FAILED": return error.params.field === "endDate" ? "projects.form.error.dates" : "projects.error.validation";
    case "NOT_FOUND": return "projects.error.not_found";
    case "REFERENCE_IN_USE": return "projects.error.in_use";
    case "UNAUTHENTICATED": return "projects.error.unauthenticated";
    case "RATE_LIMITED": return "projects.error.rate_limited";
    default: return "projects.error.other";
  }
}

/** Projet du planning (forme de la grille) tiré d'un projet complet : sert à la démo, où le planning n'a pas de temps réel. */
export function scheduleProjectOf(p: ProjectDetail): ScheduleResponse["projects"][number] {
  return {
    id: p.id, version: p.version, name: p.name, projectCode: p.projectCode, color: p.color, status: p.status, nonBillable: p.nonBillable,
    startDate: p.startDate, endDate: p.endDate,
  };
}
