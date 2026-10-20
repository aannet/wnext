// Retrait d'une personne d'un projet (BR-10) : récapitulatif puis retrait confirmé (contrat packages/contracts/src/team.ts).
// Jamais optimiste : la suppression est irréversible et confirmée, l'écran attend la réponse. Un refus porte le récapitulatif
// courant dans `params` (état changé, temps verrouillés) : il est rendu pour être re-présenté. La règle (récapitulatif,
// confirmation périmée, refus si temps verrouillés) vient du moteur (planTeamRemoval), comme côté API ; la démo s'en sert.
import type { TeamRemovalSummary } from "@wnext/contracts";
import { planTeamRemoval, type RemovalConfirmation } from "@wnext/engine";
import type { Allocation, EditError } from "./allocation-edits";

export type RemovalSummary = TeamRemovalSummary;
export type { RemovalConfirmation };
export type SummaryOutcome = { ok: true; summary: RemovalSummary } | { ok: false; error: EditError };
export type RemovalOutcome =
  | { ok: true; removedAllocations: number; removedLogs: number; removedLogHours: number }
  | { ok: false; error: EditError; summary?: RemovalSummary };

export interface TeamRemovalEditor {
  teamRemovalSummary(projectId: string, personId: string): Promise<SummaryOutcome>;
  /** `confirmation` : ce que l'utilisateur a vu (confirmationOf du récapitulatif affiché). */
  removeFromTeam(projectId: string, personId: string, confirmation: RemovalConfirmation): Promise<RemovalOutcome>;
}

export const confirmationOf = (s: RemovalSummary): RemovalConfirmation => ({ allocationCount: s.allocationCount, logCount: s.logCount, logHours: s.logHours });

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const dateOrNull = (v: unknown) => (typeof v === "string" ? v : null);

/** Récapitulatif porté par les params d'un refus (les dates absentes y sont omises) ; undefined si incomplet. */
export function summaryFromParams(params: unknown): RemovalSummary | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const counts = [p.allocationCount, p.logCount, p.logHours, p.lockedLogCount];
  if (!counts.every(isCount) || typeof p.canRemove !== "boolean" || typeof p.inTeam !== "boolean") return undefined;
  return {
    inTeam: p.inTeam, allocationCount: p.allocationCount as number, firstAllocation: dateOrNull(p.firstAllocation), lastAllocation: dateOrNull(p.lastAllocation),
    logCount: p.logCount as number, logHours: p.logHours as number, lockedLogCount: p.lockedLogCount as number, canRemove: p.canRemove,
  };
}

const REFUSALS = { LOCKED_LOGS: "TEAM_REMOVAL_LOCKED_LOGS", CONFIRMATION_REQUIRED: "TEAM_REMOVAL_CONFIRMATION_REQUIRED", STALE_CONFIRMATION: "TEAM_REMOVAL_STALE_CONFIRMATION" } as const;

/**
 * Retrait sur des allocations locales (démo : ni temps saisi ni équipe connus). Rend le résultat et les ids à supprimer.
 * Sans confirmation : récapitulatif seul (`plan` absent).
 */
export function localRemoval(allocations: Iterable<Allocation>, projectId: string, personId: string, confirmation?: RemovalConfirmation):
  { outcome: RemovalOutcome; summary: RemovalSummary; deleteIds: string[] } {
  const plan = planTeamRemoval({
    projectId, personId, logged: [], confirmation,
    allocations: [...allocations].map((a) => ({ id: a.id, projectId: a.projectId, personId: a.personId, startDate: a.startDate, endDate: a.endDate, repeatEndDate: a.repeatEndDate })),
  });
  const summary: RemovalSummary = { inTeam: false, ...plan.summary };
  if (!plan.ok) return { outcome: { ok: false, error: REFUSALS[plan.reason], summary }, summary, deleteIds: [] };
  return {
    outcome: { ok: true, removedAllocations: plan.deleteAllocationIds.length, removedLogs: 0, removedLogHours: 0 },
    summary, deleteIds: plan.deleteAllocationIds,
  };
}
