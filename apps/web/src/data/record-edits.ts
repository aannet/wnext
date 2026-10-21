// Écritures hors gestes de l'écran Schedule : congés (créer, modifier, supprimer) et allocations créées ou supprimées par le
// report assisté BR-04 (morceaux d'une allocation). Même mécanique que les gestes (allocation-edits) : état optimiste local
// tout de suite, puis l'appel ; succès = réponse du serveur, refus = retour arrière et code stable du contrat.
//  * Une création porte un id temporaire jusqu'à la réponse ; le résultat rend l'id du serveur (historique d'annulation).
//  * Les corps de création se déduisent d'une entité (recréation par l'annulation d'une suppression) et inversement
//    (entité optimiste), avec les défauts du serveur (congé : journée entière am..pm, en attente ; allocation : confirmée,
//    facturable, priorité 0, sans répétition).
//  * Le temps saisi (logged_time) n'est que lu : il est signalé par l'avertissement BR-04, jamais modifié.
import type { ScheduleResponse } from "@wnext/contracts";
import type { LoggedTimeInput } from "@wnext/engine";
import type { AllocationCreate, AllocationGroupCreate, TimeoffCreate, TimeoffPatch } from "../api/client.gen";
import type { Allocation, EditError, EditOutcome } from "./allocation-edits";

export type Timeoff = ScheduleResponse["timeoffs"][number];
export type CreateOutcome = { ok: true; id: string } | { ok: false; error: EditError; reason?: string };

export interface RecordEditor {
  createTimeoff(body: TimeoffCreate): Promise<CreateOutcome>;
  updateTimeoff(id: string, patch: TimeoffPatch): Promise<EditOutcome>;
  deleteTimeoff(id: string): Promise<EditOutcome>;
  createAllocation(body: AllocationCreate): Promise<CreateOutcome>;
  deleteAllocation(id: string): Promise<EditOutcome>;
  /** Temps saisi d'une personne sur une fenêtre (avertissement BR-04) ; null si indisponible (le dialogue le dit). */
  loggedTime(personId: string, from: string, to: string): Promise<LoggedTimeInput[] | null>;
}

/** Congé optimiste tel que le serveur le créera (défauts du contrat). */
export function timeoffFromCreate(b: TimeoffCreate, id: string, version = 0): Timeoff {
  const scope = b.scope ?? "full_day";
  return {
    id, version, personId: b.personId, typeId: b.typeId, startDate: b.startDate, endDate: b.endDate, scope,
    startHalf: b.startHalf ?? "am", endHalf: b.endHalf ?? "pm", hoursPerDay: scope === "partial" ? (b.hoursPerDay ?? null) : null,
    approvalStatus: b.approvalStatus ?? "approved",
  };
}

/** Corps de création d'un congé existant (recréation après annulation d'une suppression). */
export function timeoffCreateOf(t: Timeoff): TimeoffCreate {
  return {
    personId: t.personId, typeId: t.typeId, startDate: t.startDate, endDate: t.endDate, scope: t.scope, startHalf: t.startHalf, endHalf: t.endHalf,
    approvalStatus: t.approvalStatus, ...(t.scope === "partial" ? { hoursPerDay: t.hoursPerDay } : {}),
  };
}

/** Congé après un PATCH (champs absents inchangés). */
export function patchedTimeoff(t: Timeoff, p: TimeoffPatch): Timeoff {
  const { notes: _n, ...rest } = p;
  return { ...t, ...rest, hoursPerDay: (rest.scope ?? t.scope) === "partial" ? (rest.hoursPerDay ?? t.hoursPerDay) : null } as Timeoff;
}

export function allocationFromCreate(b: AllocationCreate, id: string, version = 0): Allocation {
  const base = {
    id, version, personId: b.personId, projectId: b.projectId, phaseId: b.phaseId ?? null, taskId: b.taskId ?? null, groupId: null,
    name: b.name ?? null, notes: b.notes ?? null, startDate: b.startDate, endDate: b.endDate, status: b.status ?? "confirmed",
    billable: b.billable ?? true, priority: b.priority ?? 0, repeatState: b.repeatState ?? "none", repeatEndDate: b.repeatEndDate ?? null,
  };
  return b.load.mode === "hours"
    ? { ...base, mode: "hours", hoursPerDay: b.load.hoursPerDay, percent: null }
    : { ...base, mode: "percentage", hoursPerDay: null, percent: b.load.percent };
}

/** Une création par membre d'un groupe (BR-26) : champs communs, charge du membre ou, à défaut, la charge commune. */
export function groupMembers(b: AllocationGroupCreate): AllocationCreate[] {
  const { members, load, ...common } = b;
  return members.map((m) => ({ ...common, personId: m.personId, load: (m.load ?? load)! }));
}

/** Corps de création reprenant une allocation (copie hors groupe). */
export function allocationCreateOf(a: Allocation): AllocationCreate {
  return {
    personId: a.personId, projectId: a.projectId, phaseId: a.phaseId, taskId: a.taskId, name: a.name, notes: a.notes,
    startDate: a.startDate, endDate: a.endDate, status: a.status, billable: a.billable, priority: a.priority, repeatState: a.repeatState,
    repeatEndDate: a.repeatEndDate,
    load: a.mode === "hours" ? { mode: "hours", hoursPerDay: a.hoursPerDay } : { mode: "percentage", percent: a.percent },
  };
}

/**
 * Même règle que l'API (TIMEOFF_OVERLAP) : deux congés de la même personne ne se chevauchent pas, à la demi-journée près,
 * sauf refusés ou partiels. Utilisée par la démo locale, qui n'a pas de serveur pour la poser.
 */
export function overlapsTimeoff(list: Iterable<Timeoff>, t: Timeoff): boolean {
  const counts = (x: Timeoff) => x.approvalStatus !== "declined" && x.scope !== "partial";
  const halves = (x: Timeoff) => [Date.parse(x.startDate) / 43_200_000 + (x.startHalf === "pm" ? 1 : 0), Date.parse(x.endDate) / 43_200_000 + (x.endHalf === "am" ? 0 : 1)];
  if (!counts(t)) return false;
  const [s, e] = halves(t);
  for (const o of list) {
    if (o.id === t.id || o.personId !== t.personId || !counts(o)) continue;
    const [os, oe] = halves(o);
    if (os! <= e! && s! <= oe!) return true;
  }
  return false;
}
