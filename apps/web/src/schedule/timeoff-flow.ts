// Saisie des congés dans l'écran Schedule, sans React : avertissement BR-04 et report assisté, puis exécution des écritures
// et enregistrement d'UNE action d'annulation (BR-40).
//  * timeoffConflicts : jours et allocations touchés par un congé (moteur detectTimeoffConflicts sur l'état chargé, le
//    congé modifié retiré de « ses autres congés »), temps saisi signalé, propositions de proposeResolution. L'assistant
//    n'est proposé que pour un congé approuvé (BR-29) ; un congé en attente avertit seulement.
//  * planResolution : choix par allocation (reporter, réduire, garder) -> écritures (resolutionWrites du moteur). « Garder »
//    n'écrit rien : la surcharge reste, signalée (BR-01), jamais bloquée. Les séries ne sont jamais modifiées (garder).
//  * runTimeoffAction : écrit le congé, puis les allocations dans l'ordre (mise à jour par le chemin des gestes, créations,
//    suppression en dernier) ; s'arrête au premier refus. Ce qui a été écrit est enregistré comme une seule action, annulée
//    en bloc dans l'ordre inverse : rien n'est jamais laissé sans moyen de revenir en arrière.
import type { ScheduleResponse } from "@wnext/contracts";
import {
  detectTimeoffConflicts, proposeResolution, resolutionWrites, scheduleToEngineInput,
  type Action, type ConflictDay, type DayResolution, type LoggedTimeInput, type Op, type ResolutionChoice, type ResolutionWrites, type TimeoffInput,
} from "@wnext/engine";
import type { TimeoffCreate, TimeoffPatch } from "../api/client.gen";
import type { EditError, ScheduleEditor } from "../data/allocation-edits";
import { allocationCreateOf, timeoffCreateOf, type RecordEditor, type Timeoff } from "../data/record-edits";

export type Choice = ResolutionChoice | "keep";

export interface TimeoffConflictReport {
  days: ConflictDay[];
  /** Vrai pour un congé approuvé avec au moins un jour en conflit (assistant proposé). */
  assistant: boolean;
  resolutions: DayResolution[];
}

/** Congé tel qu'il sera écrit (création, ou état après modification). */
export type TimeoffDraft = Omit<Timeoff, "version" | "id"> & { id: string | null };

export function timeoffConflicts(s: ScheduleResponse, draft: TimeoffDraft, logged: readonly LoggedTimeInput[] = []): TimeoffConflictReport {
  const none: TimeoffConflictReport = { days: [], assistant: false, resolutions: [] };
  const type = s.timeoffTypes.find((t) => t.id === draft.typeId);
  const person = s.people.find((p) => p.id === draft.personId);
  if (!type || !person) return none;
  const projects = new Set(s.projects.map((p) => p.id));
  const types = new Set(s.timeoffTypes.map((t) => t.id));
  const input = scheduleToEngineInput({
    ...s, people: [person], allocations: s.allocations.filter((a) => a.personId === person.id && projects.has(a.projectId)),
    timeoffs: s.timeoffs.filter((t) => t.personId === person.id && t.id !== draft.id && types.has(t.typeId)),
  });
  const timeoff: TimeoffInput = {
    personId: draft.personId, startDate: draft.startDate, endDate: draft.endDate, scope: draft.scope, startHalf: draft.startHalf,
    endHalf: draft.endHalf, hoursPerDay: draft.hoursPerDay, deducted: type.deducted, approvalStatus: draft.approvalStatus,
  };
  const base = { person: input.people[0]!, timeoff, timeoffs: input.timeoffs, holidays: input.holidays, allocations: input.allocations };
  const c = detectTimeoffConflicts({ ...base, logged });
  return { days: c.days, assistant: c.requiresAssistant, resolutions: c.days.length ? proposeResolution({ ...base, conflicts: c.days }) : [] };
}

/** Écritures du report pour chaque allocation dont le choix n'est pas « garder ». */
export function planResolution(s: ScheduleResponse, personId: string, resolutions: readonly DayResolution[], choices: Readonly<Record<string, Choice>>): ResolutionWrites[] {
  const person = s.people.find((p) => p.id === personId);
  if (!person) return [];
  const input = scheduleToEngineInput({ ...s, people: [person], allocations: s.allocations.filter((a) => a.personId === personId && s.projects.some((p) => p.id === a.projectId)), timeoffs: [] });
  const out: ResolutionWrites[] = [];
  for (const a of input.allocations) {
    const choice = choices[a.id];
    if (!choice || choice === "keep") continue;
    const w = resolutionWrites({ allocation: a, workDaysHours: person.workDaysHours, ...(person.workSchedule && { workSchedule: person.workSchedule }), resolutions, choice });
    if (w) out.push(w);
  }
  return out;
}

export type TimeoffAction =
  | { kind: "create"; body: TimeoffCreate; writes?: readonly ResolutionWrites[] }
  | { kind: "update"; id: string; patch: TimeoffPatch; writes?: readonly ResolutionWrites[] }
  | { kind: "delete"; id: string };

export type ActionOutcome =
  | { ok: true; timeoffId: string | null }
  | { ok: false; error: EditError; /** Quelque chose a été écrit avant le refus (enregistré, annulable). */ partial: boolean };

export interface FlowDeps {
  /** Écritures brutes (source) : ne s'enregistrent pas elles-mêmes dans l'historique. */
  editor: ScheduleEditor & RecordEditor;
  data(): ScheduleResponse;
  record?(a: Omit<Action, "at">): void;
}

export const actionLabel = (a: TimeoffAction): string =>
  a.kind === "delete" ? "timeoff.delete" : a.writes?.length ? "timeoff.reschedule" : `timeoff.${a.kind}`;

export async function runTimeoffAction(deps: FlowDeps, action: TimeoffAction): Promise<ActionOutcome> {
  const ops: Op[] = [];
  const done = (out: ActionOutcome): ActionOutcome => {
    if (ops.length) deps.record?.({ label: actionLabel(action), ops });
    return out.ok ? out : { ...out, partial: ops.length > 0 };
  };
  const failed = (error: EditError): ActionOutcome => done({ ok: false, error, partial: false });

  let timeoffId: string | null = null;
  if (action.kind === "delete") {
    const t = deps.data().timeoffs.find((x) => x.id === action.id);
    if (!t) return failed("NOT_FOUND");
    const out = await deps.editor.deleteTimeoff(action.id);
    if (!out.ok) return failed(out.error);
    ops.push({ kind: "delete", entity: "timeoffs", id: t.id, before: { ...timeoffCreateOf(t) } });
    return done({ ok: true, timeoffId: null });
  }
  if (action.kind === "create") {
    const out = await deps.editor.createTimeoff(action.body);
    if (!out.ok) return failed(out.error);
    timeoffId = out.id;
    ops.push({ kind: "create", entity: "timeoffs", id: out.id, after: { ...action.body } });
  } else {
    const t = deps.data().timeoffs.find((x) => x.id === action.id);
    if (!t) return failed("NOT_FOUND");
    const out = await deps.editor.updateTimeoff(action.id, action.patch);
    if (!out.ok) return failed(out.error);
    timeoffId = action.id;
    const before = Object.fromEntries(Object.keys(action.patch).map((k) => [k, t[k as keyof Timeoff] ?? null]));
    ops.push({ kind: "update", entity: "timeoffs", id: action.id, before, after: { ...action.patch } });
  }

  for (const w of action.writes ?? []) {
    const a = deps.data().allocations.find((x) => x.id === w.allocationId);
    if (!a) return failed("NOT_FOUND");
    if (w.update) {
      const after: Record<string, unknown> = { startDate: w.update.startDate, endDate: w.update.endDate };
      if (w.update.hoursPerDay !== undefined) after.hoursPerDay = w.update.hoursPerDay;
      const before = Object.fromEntries(Object.keys(after).map((k) => [k, a[k as keyof typeof a]]));
      const out = await deps.editor.updateAllocation(a.id, after);
      if (!out.ok) return failed(out.error);
      ops.push({ kind: "update", entity: "allocations", id: a.id, before, after });
    }
    for (const c of w.creates) {
      const body = allocationCreateOf({ ...a, startDate: c.startDate, endDate: c.endDate, repeatState: "none", repeatEndDate: null });
      if (c.hoursPerDay !== null) body.load = { mode: "hours", hoursPerDay: c.hoursPerDay };
      const out = await deps.editor.createAllocation(body);
      if (!out.ok) return failed(out.error);
      ops.push({ kind: "create", entity: "allocations", id: out.id, after: { ...body } });
    }
    if (!w.update) {
      const out = await deps.editor.deleteAllocation(a.id);
      if (!out.ok) return failed(out.error);
      ops.push({ kind: "delete", entity: "allocations", id: a.id, before: { ...allocationCreateOf(a) } });
    }
  }
  return done({ ok: true, timeoffId });
}

/** Exécution des opérations d'annulation hors mise à jour d'allocation (historique, `execute`). */
export function executeRecordOp(editor: RecordEditor): (op: Op) => Promise<{ ok: true; id?: string } | { ok: false; error: EditError }> {
  return async (op) => {
    if (op.entity === "timeoffs") {
      if (op.kind === "create") return editor.createTimeoff(op.after as unknown as TimeoffCreate);
      if (op.kind === "delete") return editor.deleteTimeoff(op.id);
      return editor.updateTimeoff(op.id, op.after as TimeoffPatch);
    }
    if (op.entity === "allocations" && op.kind === "create") return editor.createAllocation(op.after as never);
    if (op.entity === "allocations" && op.kind === "delete") return editor.deleteAllocation(op.id);
    return { ok: false, error: "UNSUPPORTED" };
  };
}
