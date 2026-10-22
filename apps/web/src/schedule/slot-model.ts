// Modèle pur de la pop-in du créneau (RT-011, RT-014 à RT-016) : brouillon d'une allocation (édition ou création), contrôles,
// patch d'édition (champs changés seulement, If-Match posé par la source), corps de création (une personne : POST
// /allocations ; plusieurs : groupe BR-26), droits sur les projets (BR-33), recherche dans le référentiel, surcharge (BR-01,
// signalée, jamais bloquante) et clés des erreurs (codes stables traduits, jamais le texte de l'API).
import type { Me, ProjectDetail } from "@wnext/contracts";
import type { ScheduleResponse } from "@wnext/contracts";
import { AllocationGroupMax } from "@wnext/contracts";
import type { AllocationCreate, AllocationGroupCreate } from "../api/client.gen";
import type { Allocation, AllocationEdit, EditError } from "../data/allocation-edits";
import { allocationFromCreate } from "../data/record-edits";
import type { MessageKey } from "../i18n";
import { editWarnings } from "./edit-warnings";

/** Charge d'une création sans quantité précisée (décision 2026-10-19). */
export const DEFAULT_HOURS = 8;

export interface SlotDraft {
  /** null : création. */
  allocationId: string | null;
  personIds: string[];
  projectId: string | null;
  taskId: string | null;
  startDate: string;
  endDate: string;
  mode: Allocation["mode"];
  /** Saisies brutes (champs numériques), contrôlées par slotIssues. */
  hours: string;
  percent: string;
  status: Allocation["status"];
  notes: string;
}

export type SlotIssue = "person" | "people" | "project" | "dates" | "hours" | "percent";

export function createDraft(personId: string | null, startDate: string, endDate: string, projectId: string | null = null): SlotDraft {
  return {
    allocationId: null, personIds: personId ? [personId] : [], projectId, taskId: null, startDate, endDate,
    mode: "hours", hours: String(DEFAULT_HOURS), percent: "100", status: "confirmed", notes: "",
  };
}

export function editDraft(a: Allocation): SlotDraft {
  return {
    allocationId: a.id, personIds: [a.personId], projectId: a.projectId, taskId: a.taskId, startDate: a.startDate, endDate: a.endDate,
    mode: a.mode, hours: String(a.hoursPerDay ?? DEFAULT_HOURS), percent: String(a.percent ?? 100), status: a.status, notes: a.notes ?? "",
  };
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));

/** Ce qui empêche d'enregistrer (vide : prêt). Une édition porte exactement une personne ; une création, 1 à 50. */
export function slotIssues(d: SlotDraft, current?: Allocation): SlotIssue[] {
  const out: SlotIssue[] = [];
  if (d.personIds.length === 0) out.push("person");
  else if (d.allocationId !== null ? d.personIds.length > 1 : d.personIds.length > AllocationGroupMax) out.push("people");
  if (!d.projectId) out.push("project");
  const seriesEnd = current && current.repeatState !== "none" ? current.repeatEndDate : null;
  if (!d.startDate || !d.endDate || d.endDate < d.startDate || (seriesEnd !== null && d.endDate > seriesEnd)) out.push("dates");
  const h = num(d.hours);
  const p = num(d.percent);
  if (d.mode === "hours" && !(h > 0 && h <= 24)) out.push("hours");
  if (d.mode === "percentage" && !(p > 0 && p <= 500)) out.push("percent");
  return out;
}

const loadOf = (d: SlotDraft): AllocationCreate["load"] =>
  d.mode === "hours" ? { mode: "hours", hoursPerDay: num(d.hours) } : { mode: "percentage", percent: num(d.percent) };

/** Champs changés par rapport à l'allocation (un brouillon prêt : slotIssues vide). */
export function editPatch(a: Allocation, d: SlotDraft): AllocationEdit {
  const p: AllocationEdit = {};
  const personId = d.personIds[0];
  if (personId && personId !== a.personId) p.personId = personId;
  if (d.projectId && d.projectId !== a.projectId) { p.projectId = d.projectId; p.taskId = d.taskId; }
  else if (d.taskId !== a.taskId) p.taskId = d.taskId;
  if (d.startDate !== a.startDate) p.startDate = d.startDate;
  if (d.endDate !== a.endDate) p.endDate = d.endDate;
  const load = loadOf(d);
  if (load.mode !== a.mode) Object.assign(p, load.mode === "hours" ? { mode: "hours", hoursPerDay: load.hoursPerDay, percent: null } : { mode: "percentage", percent: load.percent, hoursPerDay: null });
  else if (load.mode === "hours" && load.hoursPerDay !== a.hoursPerDay) p.hoursPerDay = load.hoursPerDay;
  else if (load.mode === "percentage" && load.percent !== a.percent) p.percent = load.percent;
  if (d.status !== a.status) p.status = d.status;
  const notes = d.notes.trim() === "" ? null : d.notes;
  if (notes !== (a.notes ?? null)) p.notes = notes;
  return p;
}

export type CreateRequestBody = { kind: "one"; body: AllocationCreate } | { kind: "group"; body: AllocationGroupCreate };

/** Corps de création : une personne -> une allocation ; plusieurs -> un groupe (BR-26, charge commune). */
export function createBody(d: SlotDraft): CreateRequestBody {
  const common = {
    projectId: d.projectId!, startDate: d.startDate, endDate: d.endDate, status: d.status, load: loadOf(d),
    ...(d.taskId ? { taskId: d.taskId } : {}), ...(d.notes.trim() ? { notes: d.notes } : {}),
  };
  if (d.personIds.length === 1) return { kind: "one", body: { ...common, personId: d.personIds[0]! } };
  return { kind: "group", body: { ...common, members: d.personIds.map((personId) => ({ personId })) } };
}

/** Profil utile aux droits d'écriture ; `user` absent (tests, écran seul) : seule la chefferie de projet compte. */
export type ProjectViewer = Pick<Me, "role" | "person"> & Partial<Pick<Me, "user">>;

/**
 * BR-33 (confort d'affichage, l'API reste juge) : owner et admin écrivent sur tous les projets, un project_manager sur ceux
 * dont il est le chef de projet (projectManagerId = sa personne) ou co-gestionnaire (son user_id dans managerUserIds, table
 * project_managers : PO-06, RT-039), comme assertProjectScope côté API ; member et guest sur aucun.
 * Sans profil connu (tests, écran seul) : tout est proposé.
 */
export function canWriteProject(me: ProjectViewer | undefined, p: Pick<ProjectDetail, "projectManagerId" | "managerUserIds">): boolean {
  if (!me) return true;
  if (me.role === "owner" || me.role === "admin") return true;
  if (me.role !== "project_manager") return false;
  return (p.projectManagerId !== null && p.projectManagerId === me.person?.id) || (me.user !== undefined && p.managerUserIds.includes(me.user.id));
}

export interface ProjectOption { id: string; name: string; color: string | null }

/** Projets proposés : non archivés et autorisés, triés par nom ; le projet courant du bloc reste toujours proposé. */
export function projectOptions(
  list: readonly (Pick<ProjectDetail, "id" | "name" | "status" | "projectManagerId" | "managerUserIds"> & { color?: string })[],
  me: ProjectViewer | undefined, currentId: string | null,
): ProjectOption[] {
  return list
    .filter((p) => p.id === currentId || (p.status !== "archived" && canWriteProject(me, p)))
    .map((p) => ({ id: p.id, name: p.name, color: p.color ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

/** Recherche du référentiel : sous-chaîne, sans casse ni accents ; requête vide : tout. */
export function searchOptions<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const q = fold(query.trim());
  return q === "" ? [...items] : items.filter((i) => fold(i.name).includes(q));
}

/** Personnes du brouillon en surcharge sur la plage (BR-01 : signalé, jamais bloqué), dans l'état chargé. */
export function slotOverloads(s: ScheduleResponse, d: SlotDraft, current?: Allocation): string[] {
  if (slotIssues(d, current).length > 0) return [];
  const { body } = createBody({ ...d, personIds: [d.personIds[0]!] });
  return d.personIds.filter((personId) => {
    const base = allocationFromCreate({ ...(body as AllocationCreate), personId }, current?.id ?? "slot-draft");
    const a = current ? { ...current, ...base, id: current.id, repeatState: current.repeatState, repeatEndDate: current.repeatEndDate } as Allocation : base;
    return editWarnings(s, a).includes("OVERLOAD");
  });
}

const SHOWN = new Set<EditError>(["VERSION_CONFLICT", "NOT_FOUND", "FORBIDDEN", "NETWORK", "BUSY", "VALIDATION_FAILED"]);
/** Clé du message d'une écriture refusée (code stable du contrat). */
export const slotErrorKey = (e: EditError): MessageKey => (SHOWN.has(e) ? `schedule.slot.error.${e as "NETWORK"}` : "schedule.slot.error.other");
