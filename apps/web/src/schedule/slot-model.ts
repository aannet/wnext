// Modèle pur de la pop-in du créneau (RT-011, RT-014 à RT-016) : brouillon d'une allocation (édition ou création), contrôles,
// patch d'édition (champs changés seulement, If-Match posé par la source), corps de création (une personne : POST
// /allocations ; plusieurs : groupe BR-26), droits sur les projets (BR-33), recherche dans le référentiel, surcharge (BR-01,
// signalée, jamais bloquante) et clés des erreurs (codes stables traduits, jamais le texte de l'API). Portée d'une écriture
// (RT-042, PO-08) : série ouverte sur une occurrence (« cette occurrence » ou « toute la série ») et ligne d'un groupe
// (« cette ligne » ou « tout le groupe », champs communs seulement).
import type { Me, ProjectDetail } from "@wnext/contracts";
import type { ScheduleResponse } from "@wnext/contracts";
import { AllocationGroupMax } from "@wnext/contracts";
import { addDays, addMonths, dayNumber, DEFAULT_HOURS_PER_DAY, expandOccurrences } from "@wnext/engine";
import type { AllocationCreate, AllocationGroupCreate } from "../api/client.gen";
import { localSplit, type Allocation, type AllocationEdit, type EditError } from "../data/allocation-edits";
import { allocationFromCreate } from "../data/record-edits";
import type { MessageKey } from "../i18n";
import { editWarnings } from "./edit-warnings";

/** Charge d'une création sans quantité précisée (décision 2026-10-19) : une seule source, le moteur (RT-061, D10). */
export const DEFAULT_HOURS = DEFAULT_HOURS_PER_DAY;

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

/** Occurrence d'une série ouverte dans la pop-in : son rang et ses dates (fin tronquée à la fin de série). */
export interface SlotOccurrence { index: number; startDate: string; endDate: string }

/** Occurrence de rang `index` d'une série ; null hors série ou au-delà de la fin de série. */
export function occurrenceOf(a: Allocation, index: number): SlotOccurrence | null {
  if (a.repeatState === "none" || index < 0) return null;
  const start = a.repeatState === "monthly" ? addMonths(a.startDate, index) : addDays(a.startDate, index * (a.repeatState === "daily" ? 1 : 7));
  const o = expandOccurrences(a, start, start).find((x) => x.index === index);
  return o ? { index, startDate: o.startDate, endDate: o.endDate } : null;
}

/** Brouillon d'édition ; ouvert sur une occurrence d'une série, ses dates sont celles de l'occurrence. */
export function editDraft(a: Allocation, occ: SlotOccurrence | null = null): SlotDraft {
  return {
    allocationId: a.id, personIds: [a.personId], projectId: a.projectId, taskId: a.taskId, startDate: occ?.startDate ?? a.startDate, endDate: occ?.endDate ?? a.endDate,
    mode: a.mode, hours: String(a.hoursPerDay ?? DEFAULT_HOURS), percent: String(a.percent ?? 100), status: a.status, notes: a.notes ?? "",
  };
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));

/**
 * Ce qui empêche d'enregistrer (vide : prêt). Une édition porte exactement une personne ; une création, 1 à 50. La fin d'une
 * série peut être dépassée (PO-12) : « toute la série » emporte sa fin de série (scopePlan), « cette occurrence » en sort.
 */
export function slotIssues(d: SlotDraft): SlotIssue[] {
  const out: SlotIssue[] = [];
  if (d.personIds.length === 0) out.push("person");
  else if (d.allocationId !== null ? d.personIds.length > 1 : d.personIds.length > AllocationGroupMax) out.push("people");
  if (!d.projectId) out.push("project");
  if (!d.startDate || !d.endDate || d.endDate < d.startDate) out.push("dates");
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

export type SlotScope = "occurrence" | "series" | "line" | "group";
/**
 * Choix indisponible : occurrence non découpable (raison du moteur), groupe avec personne / charge changées (per_line),
 * série mensuelle déplacée depuis une autre occurrence que la première (monthly_dates).
 */
export type ScopeBlocker = "overlapping" | "monthly_clamped" | "other" | "per_line" | "monthly_dates";
export interface ScopeOption { scope: SlotScope; blocked: ScopeBlocker | null }
export interface ScopePlan {
  /** Patch de l'allocation : toute la série, la ligne, ou chaque ligne du groupe. */
  patch: AllocationEdit;
  /** Patch de la seule occurrence (série ouverte sur une occurrence), null sinon. */
  occurrencePatch: AllocationEdit | null;
  /** Choix de portée ; vide : pas d'étape, `patch` s'applique à l'allocation. */
  options: ScopeOption[];
}

const PER_LINE = ["personId", "hoursPerDay", "percent", "mode"] as const;

/**
 * Portée d'une édition (RT-042, PO-08). Le brouillon est comparé à ce qu'affichait la pop-in (l'occurrence pour une série) :
 *  * série : « cette occurrence » (découpe, BR-25 ; indisponible si le moteur ne sait pas la découper) ou « toute la série »,
 *    dont les dates bougent d'autant que celles de l'occurrence, fin de série comprise (comme un geste) ; une série
 *    mensuelle ne se déplace que depuis sa première occurrence ;
 *  * ligne d'un groupe (BR-26), si l'éditeur sait écrire un groupe (`group`) et qu'un champ commun change : « cette ligne »
 *    ou « tout le groupe ». Le PATCH de groupe ne porte ni personne ni charge (propres à chaque ligne) : si l'une d'elles
 *    change aussi, « tout le groupe » est indisponible (rien n'est appliqué en partie). Personne ou charge seules : la ligne,
 *    sans étape.
 */
export function scopePlan(a: Allocation, occ: SlotOccurrence | null, d: SlotDraft, group: boolean): ScopePlan {
  const shown = occ ? { ...a, startDate: occ.startDate, endDate: occ.endDate } : a;
  const diff = editPatch(shown, d);
  if (Object.keys(diff).length === 0) return { patch: {}, occurrencePatch: occ && {}, options: [] };
  const patch: AllocationEdit = { ...diff };
  const ds = occ && diff.startDate !== undefined ? dayNumber(diff.startDate) - dayNumber(occ.startDate) : 0;
  const de = occ && diff.endDate !== undefined ? dayNumber(diff.endDate) - dayNumber(occ.endDate) : 0;
  if (ds !== 0) patch.startDate = addDays(a.startDate, ds);
  if (de !== 0) patch.endDate = addDays(a.endDate, de);
  // Comme les gestes (applyGesture) : déplacée, la série emporte sa fin ; étirée, la fin ne suit que si le bloc la dépasse.
  if (occ && a.repeatEndDate !== null && ds !== 0 && ds === de) patch.repeatEndDate = addDays(a.repeatEndDate, ds);
  else if (occ && a.repeatEndDate !== null && patch.endDate !== undefined && patch.endDate > a.repeatEndDate) patch.repeatEndDate = patch.endDate;
  // PO-12 : l'occurrence finit après la fin de série (dernière occurrence tronquée, étirée) : la fin de série la suit jusque-là.
  const seriesEnd = patch.repeatEndDate ?? a.repeatEndDate;
  if (occ && seriesEnd !== null && diff.endDate !== undefined && diff.endDate > seriesEnd) patch.repeatEndDate = diff.endDate;
  // Série mensuelle : un décalage en jours depuis une autre occurrence que la première n'est pas réversible (fins de mois
  // ramenées) ; toute la série ne se déplace que depuis sa première occurrence (dates d'origine, aucun calcul).
  const monthly = occ !== null && a.repeatState === "monthly" && occ.index > 0 && (ds !== 0 || de !== 0);
  const options: ScopeOption[] = [];
  if (occ) {
    const split = localSplit(a, occ.index, diff, (n) => `scope-${n}`);
    const blocked: ScopeBlocker | null = split.ok ? null : split.reason === "overlapping" || split.reason === "monthly_clamped" ? split.reason : "other";
    options.push({ scope: "occurrence", blocked }, { scope: "series", blocked: monthly ? "monthly_dates" : null });
  }
  const common = Object.keys(diff).some((k) => !(PER_LINE as readonly string[]).includes(k));
  if (a.groupId !== null && group && common) {
    if (!occ) options.push({ scope: "line", blocked: null });
    options.push({ scope: "group", blocked: PER_LINE.some((k) => diff[k] !== undefined) ? "per_line" : monthly ? "monthly_dates" : null });
  }
  return { patch, occurrencePatch: occ ? diff : null, options };
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
  if (slotIssues(d).length > 0) return [];
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
