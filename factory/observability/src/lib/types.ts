export const PHASES = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type Phase = (typeof PHASES)[number];

/** Agents du contrat (strategy.md §5.1), dans l'ordre du pipeline. */
export const AGENTS = [
  "orchestrateur", "architecte", "router", "specifieur", "testeur", "implementeur",
  "sentinelle", "reviseur", "integrateur", "depanneur", "scribe", "superviseur", "introspecteur",
] as const;
export type Agent = (typeof AGENTS)[number];

export interface FactoryEvent {
  schema_version?: string;
  ts: string;
  run_id: string;
  line: string;
  phase: Phase;
  agent: string;
  model: string;
  action: string;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration_ms: number;
  status: string;
  attempt?: number;
  parent_id?: string;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  budget_remaining?: number;
  detail?: Record<string, string | number | boolean | null>;
}

/** Événement tel que relu depuis le store (avec son numéro de séquence). */
export interface StoredEvent extends FactoryEvent {
  id: number;
  schema_version: string;
}

export interface BudgetConfig {
  alert_ratio: number;
  hard_ceiling_factor: number;
  phases: Record<Phase, number>;
}
