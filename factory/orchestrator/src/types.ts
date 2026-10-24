/**
 * Contrats de l'orchestrateur et du Superviseur (L9.0). AUCUNE logique ici.
 * Sources : docs/00-factory/strategy.md §2, §4.1, §4.3, §4.4, §4.5, §4.8, §5 ; ADR-006, ADR-007.
 *
 * Conventions (contraignantes pour L9.1-L9.4) :
 *  - temps en millisecondes epoch (`*_ms`) lus via `Clock`, jamais `Date.now()` ;
 *  - un événement est TOUJOURS un `FactoryEvent` (observability/src/lib/types.ts, schéma event.json) : on ne le redéfinit pas ;
 *  - aucun contenu sensible (prompts, code) dans les types qui alimentent les événements (§5.3).
 */
import type { Agent, FactoryEvent, Phase } from "../../observability/src/lib/types";

export type { Agent, FactoryEvent, Phase };

/** Identifiant de ligne de production, p. ex. `P1-017` (event.json : `^P[0-5]-\d{3}$`). */
export type LineId = string;
/** ID exact de modèle (`claude-opus-5-5`, ...) ; jamais en dur, vient de factory/models.yaml (§3 règle 6). */
export type ModelId = string;

export interface Clock {
  /** Epoch ms. */
  now(): number;
  /** Attend `ms` ; se résout aussitôt (sans erreur) si `signal` est annulé. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Étapes du flux de la ligne, §4.1. La Sentinelle s'exécute dans l'étape `ci`. */
export const PIPELINE_STEPS = ["spec", "tests", "impl", "local_check", "ci", "review", "merge"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const LINE_STATUSES = ["running", "blocked", "looping", "killed", "done"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

/** Diff produit par un cycle d'implémentation (détection de boucle §4.4). Contient des empreintes, jamais le diff. */
export interface DiffRecord {
  hash: string;
  at_ms: number;
  /** Similarité [0,1] avec le diff précédent de la ligne, calculée par L9.2 ; null si premier diff. */
  similarity_to_previous: number | null;
  /** Empreinte du contenu de chaque fichier touché après ce diff (oscillation A -> B -> A). */
  file_hashes: Record<string, string>;
  lines_changed: number;
}

export interface CiErrorSignature {
  /** Test + message normalisé (§4.4). */
  signature: string;
  at_ms: number;
}

/** État d'une ligne, maintenu par L9.2 (noyau) et lu tel quel par le Superviseur pur. */
export interface LineState {
  line: LineId;
  phase: Phase;
  run_id: string;
  status: LineStatus;
  step: PipelineStep;
  /** Cycles impl->CI consommés (§4.3 : max 5 au total, 2 par modèle). */
  cycles: { total: number; by_model: Record<ModelId, number> };
  /** Retours de review (§4.3 : max 2). */
  review_returns: number;
  tokens: {
    used: number;
    /** Plafond dur de la ligne = 3 x estimation du Router (§4.3). */
    budget: number;
    /** Valeur de `used` lors de la dernière hausse de `green_tests` (§4.4 : > 50 % sans progrès). */
    used_at_last_green_gain: number;
  };
  started_at_ms: number;
  last_commit_at_ms: number | null;
  last_step_change_at_ms: number;
  green_tests: number;
  /** Diffs récents, du plus ancien au plus récent (fenêtre définie par L9.2, >= 3). */
  recent_diffs: DiffRecord[];
  /** Signatures d'erreur CI récentes, de la plus ancienne à la plus récente. */
  recent_ci_errors: CiErrorSignature[];
  /** Compteurs de supervision (ADR-006). */
  interruptions: number;
  relaunches_by_agent: Partial<Record<Agent, number>>;
  /** Montées vers F consommées (max 1 par ligne, §3 règle 1). */
  f_escalations: number;
  /** Chemin sensible touché (auth/, rls, rules/, migrations) : le modèle ne descend jamais sous O. */
  sensitive_path: boolean;
}

/** Instance d'agent vivante (une session `claude -p`, §2 / ADR-007). */
export interface AgentState {
  instance_id: string;
  line: LineId;
  role: Agent;
  model: ModelId;
  started_at_ms: number;
  /** Dernier événement émis par l'instance (null si aucun). */
  last_event: FactoryEvent | null;
  last_event_at_ms: number | null;
  /** Appels d'outils depuis le dernier commit de la ligne (§4.4 : 40, §4.8 : 20). */
  tool_calls_since_commit: number;
  last_commit_at_ms: number | null;
  last_state_change_at_ms: number;
  /** Nombre d'`llm.call` consécutifs au contenu quasi identique (même hash), >= 1 dès le premier appel. */
  identical_llm_call_streak: number;
  /** Début du signal de niveau 1 toujours actif (persistance 10 min, §4.8) ; null si aucun. */
  warn_since_ms: number | null;
  pid: number | null;
  pgid: number | null;
}

/** Taxonomie des signaux sources d'une action (un par seuil de supervision.yaml). */
export type SignalKind =
  // niveau 1 (§4.8)
  | "idle_without_commit" | "tool_calls_without_commit" | "identical_llm_calls"
  // niveau 2 (§4.8, ADR-006)
  | "warn_persisted" | "mute_agent"
  // boucle (§4.4)
  | "loop_diff_repeat" | "loop_error_signature" | "loop_oscillation" | "loop_tool_calls"
  | "loop_token_ratio" | "loop_budget_no_progress"
  // niveau 3 / 5 (§4.8, §4.3)
  | "assess_verdict" | "no_progress" | "wall_clock" | "cycles_exhausted" | "review_returns_exhausted"
  | "line_budget_ceiling" | "second_interruption" | "relaunch_exhausted"
  // système (§4.5, §4.8)
  | "interruptions_per_hour" | "looping_lines_per_hour" | "ci_failure_rate" | "phase_budget_ceiling"
  | "cost_per_hour" | "permission_violation" | "kill_switch_file";

export interface Signal {
  kind: SignalKind;
  /** Valeur observée et seuil franchi, pour l'événement `detail` (scalaires seulement, §5). */
  value?: number;
  threshold?: number;
}

interface ActionBase {
  line: LineId;
  /** Une phrase, sans contenu sensible. */
  cause: string;
  signal: Signal;
}
interface AgentActionBase extends ActionBase { instance_id: string; role: Agent }

export type RelaunchChange =
  /** Contexte réduit au diff + spec. */
  | { kind: "reduce_context" }
  /** Modèle supérieur ; L9.2 résout l'ID (models.yaml, chemins sensibles >= O, une seule montée vers F). */
  | { kind: "upgrade_model" }
  /** Re-spécification par le Spécifieur. */
  | { kind: "respec" };

export type SupervisorAction =
  /** Niveau 1 -> événement `supervisor.warn`. */
  | ({ type: "warn" } & AgentActionBase)
  /** Niveau 2 : appeler le Dépanneur ; le verdict revient ensuite dans `SupervisorInput.verdicts` -> événement `supervisor.assess`. */
  | ({ type: "assess_request" } & AgentActionBase)
  /** Niveau 3 : arrêt de l'agent + snapshot contexte et worktree -> `supervisor.interrupt`. */
  | ({ type: "interrupt" } & AgentActionBase)
  /** Niveau 4 : relance avec changement obligatoire (jamais à l'identique) -> `supervisor.restart`. */
  | ({ type: "relaunch"; change: RelaunchChange } & AgentActionBase)
  /** Niveau 5 : ligne `blocked` + rapport du Dépanneur au prochain gate -> `status=blocked`. */
  | ({ type: "block" } & ActionBase)
  /** Arrêt système (§4.5) : `kill.triggered`, seul un humain lève. */
  | ({ type: "system_kill"; scope: "phase" | "global" } & ActionBase);

/** Mapping action -> champ `action` de l'événement §5 (ADR-006 §3). Constante de contrat, sans logique. */
export const SUPERVISOR_EVENT_ACTION = {
  warn: "supervisor.warn",
  assess_request: "supervisor.assess",
  interrupt: "supervisor.interrupt",
  relaunch: "supervisor.restart",
  block: "status.blocked",
  system_kill: "kill.triggered",
} as const satisfies Record<SupervisorAction["type"], string>;

export const ASSESS_VERDICTS = ["continue", "restart", "escalate", "stop"] as const;
export type AssessVerdictKind = (typeof ASSESS_VERDICTS)[number];

/** Verdict du Dépanneur (O) sur le journal de la ligne (§4.8 niveau 2). */
export interface AssessVerdict {
  verdict: AssessVerdictKind;
  /** Cause en une phrase. */
  cause: string;
}

/** Verdict reçu, rattaché à l'instance évaluée. */
export interface ReceivedVerdict extends AssessVerdict {
  instance_id: string;
  received_at_ms: number;
}

/** Signaux d'échelle de phase, agrégés par L9.2 depuis le flux §5 (une seule source de vérité). */
export interface PhaseSignals {
  phase: Phase;
  /** Médiane de tokens par ligne modifiée dans la phase (§4.4 : ratio > 5 x) ; null si pas encore de référence. */
  median_tokens_per_changed_line: number | null;
  interruptions_last_hour: number;
  looping_lines_last_hour: number;
  /** CI sur les N dernières lignes (N = `kill.ci_failure_window_lines`). */
  ci_failures_in_window: number;
  ci_runs_in_window: number;
  tokens_used: number;
  /** Budget indicatif de phase (§1) ; plafond dur = budget x factor. */
  tokens_budget: number;
  cost_last_hour_usd: number;
  /** Tentative de violation de permission observée (§4.5). */
  permission_violation: boolean;
}

export interface SupervisorInput {
  now_ms: number;
  config: SupervisorConfig;
  line: LineState;
  /** Instances vivantes de la ligne. */
  agents: AgentState[];
  phase: PhaseSignals;
  /** `factory/KILL` présent (§4.5) : prioritaire sur tout. */
  kill_switch_active: boolean;
  /** Verdicts du Dépanneur non encore consommés. */
  verdicts: ReceivedVerdict[];
}

/** Fonction PURE (aucun I/O, aucune horloge : `now_ms` fourni). Un appel par tick (§4.8) et par ligne. L9.1 l'implémente. */
export type SupervisorDecide = (input: SupervisorInput) => SupervisorAction[];
export interface Supervisor { decide: SupervisorDecide }

/**
 * Seuils de factory/supervision.yaml. Unités dans le nom (`_s`, `_min`). Convention : `*_max` = déclenche quand la
 * valeur observée est STRICTEMENT supérieure ; `max_cycles_*`/`max_review_returns` = plafond atteint quand compteur >= valeur.
 * Validation : src/config.ts (clé inconnue ou nombre négatif refusés).
 */
export interface SupervisorConfig {
  version: 1;
  supervisor: {
    /** §4.8 : tick du Superviseur. */
    tick_s: number;
    /** §4.8 : absence de `supervisor.tick` pendant ce délai = alerte humaine. */
    heartbeat_alert_s: number;
  };
  warn: {
    idle_without_commit_min: number;
    tool_calls_without_commit: number;
    identical_llm_calls: number;
  };
  assess: {
    persistence_min: number;
    mute_agent_min: number;
  };
  interrupt: {
    no_progress_min: number;
  };
  relaunch: {
    max_per_agent_and_line: number;
    max_f_escalations_per_line: number;
    /** 2e interruption de la même ligne => `blocked` (§4.8 niveau 5). */
    block_at_interruption: number;
  };
  retries: {
    max_cycles_total: number;
    max_cycles_per_model: number;
    max_review_returns: number;
    max_wall_clock_min: number;
    line_budget_factor: number;
    api_backoff_max_attempts: number;
  };
  loop: {
    diff_repeat_consecutive: number;
    diff_similarity: number;
    error_signature_repeats: number;
    oscillation_enabled: boolean;
    tool_calls_without_commit: number;
    tokens_per_changed_line_ratio: number;
    budget_fraction_without_green_gain: number;
  };
  kill: {
    stop_deadline_s: number;
    phase_budget_alert_ratio: number;
    phase_budget_ceiling_factor: number;
    looping_lines_per_hour_max: number;
    interruptions_per_hour_max: number;
    ci_failure_rate_max: number;
    ci_failure_window_lines: number;
    /** §4.5 cite un « seuil » non chiffré : null = désactivé tant qu'un humain ne le fixe pas. */
    cost_per_hour_usd_max: number | null;
  };
}
