// BR-37 : une allocation hors des dates de son projet ou de sa phase, ou une phase hors de son projet, est ACCEPTÉE avec
// un avertissement, jamais bloquée. Codes stables (ADR-003 : pas de chaîne UI), traduits par le client. Une borne absente
// (date NULL dans projects / phases) ne contraint rien. Pour une série répétée, la fin considérée est la fin de série.
import { seriesEnd, type RepeatInput } from "./repeat";

export type DateBoundWarning =
  | "ALLOCATION_STARTS_BEFORE_PROJECT"
  | "ALLOCATION_ENDS_AFTER_PROJECT"
  | "ALLOCATION_STARTS_BEFORE_PHASE"
  | "ALLOCATION_ENDS_AFTER_PHASE"
  | "PHASE_STARTS_BEFORE_PROJECT"
  | "PHASE_ENDS_AFTER_PROJECT";

export interface DateSpan { startDate: string | null; endDate: string | null }

function outside(start: string, end: string, bounds: DateSpan | null | undefined): { before: boolean; after: boolean } {
  return {
    before: !!bounds?.startDate && start < bounds.startDate,
    after: !!bounds?.endDate && end > bounds.endDate,
  };
}

export function allocationDateWarnings(a: RepeatInput, project: DateSpan | null, phase?: DateSpan | null): DateBoundWarning[] {
  const end = seriesEnd(a);
  const out: DateBoundWarning[] = [];
  const pr = outside(a.startDate, end, project);
  if (pr.before) out.push("ALLOCATION_STARTS_BEFORE_PROJECT");
  if (pr.after) out.push("ALLOCATION_ENDS_AFTER_PROJECT");
  const ph = outside(a.startDate, end, phase);
  if (ph.before) out.push("ALLOCATION_STARTS_BEFORE_PHASE");
  if (ph.after) out.push("ALLOCATION_ENDS_AFTER_PHASE");
  return out;
}

/** Phase hors du projet. Une phase sans date de début (ou de fin) n'est pas comparée de ce côté. */
export function phaseDateWarnings(phase: DateSpan, project: DateSpan | null): DateBoundWarning[] {
  const out: DateBoundWarning[] = [];
  if (phase.startDate && project?.startDate && phase.startDate < project.startDate) out.push("PHASE_STARTS_BEFORE_PROJECT");
  if (phase.endDate && project?.endDate && phase.endDate > project.endDate) out.push("PHASE_ENDS_AFTER_PROJECT");
  return out;
}
