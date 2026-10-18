// BR-10 : retirer une personne d'un projet supprime ses allocations et ses temps loggés pour ce projet.
// Jamais de suppression silencieuse : récapitulatif -> confirmation explicite -> suppression. Refusé si des logs
// ne sont plus des brouillons (BR-12 verrouillage, BR-31 pas de hard-delete de données de facturation).
// summarizeTeamRemoval est le miroir TS de team_removal_summary() (schema.sql).

export interface TeamAllocation {
  id: string;
  projectId: string;
  personId: string;
  startDate: string;
  endDate: string;
  repeatEndDate: string | null;
}

export interface TeamLog {
  id: string;
  projectId: string;
  personId: string;
  hours: number;
  status: "draft" | "submitted" | "approved" | "locked";
}

export interface TeamRemovalSummary {
  allocationCount: number;
  firstAllocation: string | null;
  /** Fin de série incluse pour les allocations répétées. */
  lastAllocation: string | null;
  logCount: number;
  logHours: number;
  /** Logs qui ne sont plus des brouillons. */
  lockedLogCount: number;
  canRemove: boolean;
}

interface Scope {
  projectId: string;
  personId: string;
  allocations: readonly TeamAllocation[];
  logged: readonly TeamLog[];
}

const scoped = ({ projectId, personId, allocations, logged }: Scope) => ({
  allocations: allocations.filter((a) => a.projectId === projectId && a.personId === personId),
  logged: logged.filter((l) => l.projectId === projectId && l.personId === personId),
});

export function summarizeTeamRemoval(scope: Scope): TeamRemovalSummary {
  const { allocations, logged } = scoped(scope);
  const lockedLogCount = logged.filter((l) => l.status !== "draft").length;
  return {
    allocationCount: allocations.length,
    firstAllocation: allocations.reduce<string | null>((m, a) => (m === null || a.startDate < m ? a.startDate : m), null),
    lastAllocation: allocations.reduce<string | null>((m, a) => {
      const end = a.repeatEndDate ?? a.endDate;
      return m === null || end > m ? end : m;
    }, null),
    logCount: logged.length,
    logHours: logged.reduce((s, l) => s + l.hours, 0),
    lockedLogCount,
    canRemove: lockedLogCount === 0,
  };
}

/** Ce que l'utilisateur a vu et confirmé dans le modal « N allocations, M heures loggées seront supprimées ». */
export interface RemovalConfirmation {
  allocationCount: number;
  logCount: number;
  logHours: number;
}

export type RemovalPlan =
  | { ok: true; summary: TeamRemovalSummary; deleteAllocationIds: string[]; deleteLogIds: string[] }
  | { ok: false; reason: "LOCKED_LOGS" | "CONFIRMATION_REQUIRED" | "STALE_CONFIRMATION"; summary: TeamRemovalSummary };

/**
 * Décide si le retrait peut être exécuté et liste exactement ce qui sera supprimé. Une confirmation qui ne correspond plus
 * à l'état courant (ajout ou modification entre l'affichage et le clic) est périmée : on re-présente le récapitulatif.
 */
export function planTeamRemoval(input: Scope & { confirmation?: RemovalConfirmation }): RemovalPlan {
  const summary = summarizeTeamRemoval(input);
  if (!summary.canRemove) return { ok: false, reason: "LOCKED_LOGS", summary };
  const { allocations, logged } = scoped(input);
  if (summary.allocationCount > 0 || summary.logCount > 0) {
    const c = input.confirmation;
    if (!c) return { ok: false, reason: "CONFIRMATION_REQUIRED", summary };
    if (c.allocationCount !== summary.allocationCount || c.logCount !== summary.logCount || Math.abs(c.logHours - summary.logHours) > 1e-9) {
      return { ok: false, reason: "STALE_CONFIRMATION", summary };
    }
  }
  return { ok: true, summary, deleteAllocationIds: allocations.map((a) => a.id), deleteLogIds: logged.map((l) => l.id) };
}
