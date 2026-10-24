/**
 * Ports (interfaces) de l'orchestrateur vers ses collaborateurs. Aucune implémentation ici.
 * L9.4 : `Depanneur`, `Introspecteur` (src/roles/). L9.2 : consomme tous les ports ; fournit WorktreeManager/BudgetMeter/EventSink
 * (ou adaptateurs vers observability et factory/lib/kill.mjs).
 * Identifiants ASCII (`Depanneur`) pour éviter les accents dans le code.
 */
import type { AssessVerdict, FactoryEvent, LineId, LineState, Phase, Signal, Agent } from "./types";
import type { TokenUsage } from "./runner";

/** Journal d'une ligne uniquement (§4.8 niveau 2 : le Dépanneur ne lit que ce journal). Événements sans contenu sensible (§5.3). */
export interface LineLog {
  line: LineId;
  run_id: string;
  state: LineState;
  /** Événements de la ligne, ordre chronologique. */
  events: readonly FactoryEvent[];
  /** Signal qui a déclenché l'évaluation. */
  trigger: Signal;
}

/** Dépanneur (O, lecture seule, §2). Appelé uniquement à l'étape « évaluer » et pour le rapport d'une ligne `blocked`. */
export interface Depanneur {
  assess(log: LineLog): Promise<AssessVerdict>;
  /** Rapport de cause + recommandation (§4.3) ; retourne le chemin du fichier écrit. */
  report(log: LineLog): Promise<string>;
}

/** Cycle d'introspection (§4.9) : une ligne terminée (légère, S) ou une phase (complète, O, avant le gate). */
export type Cycle =
  | { kind: "line"; id: LineId; phase: Phase }
  | { kind: "phase"; id: Phase; phase: Phase };

export interface Introspecteur {
  /** Écrit `docs/00-factory/retro/<cycle>.md` et retourne son chemin. Lecture seule hors de ce fichier et des PR de config. */
  run(cycle: Cycle, events: readonly FactoryEvent[]): Promise<string>;
}

export interface WorktreeRef {
  path: string;
  /** `line/<phase>-<id>` (§4.2). */
  branch: string;
  line: LineId;
  agent: Agent;
}

export interface WorktreeManager {
  /** `/work/<run_id>/<line>/<agent>` (§4.2). */
  create(req: { run_id: string; line: LineId; agent: Agent; branch: string }): Promise<WorktreeRef>;
  /** Snapshot du worktree et du contexte avant interruption (§4.8 niveau 3) ; retourne la référence d'artefact (-> `parent_id`). */
  snapshot(wt: WorktreeRef, label: string): Promise<string>;
  /** Détruit le worktree ; `keep: true` le conserve pour analyse (kill-switch, ligne bloquée). */
  remove(wt: WorktreeRef, opts?: { keep?: boolean }): Promise<void>;
}

/** Émission vers le store / JSONL (§5). Non bloquante mais obligatoire ; at-least-once toléré (idempotence côté store). */
export interface EventSink {
  emit(event: FactoryEvent): void;
  /** Attend que tout ce qui a été émis soit persisté (fin de test, arrêt). */
  flush(): Promise<void>;
}

export type BudgetLevel = "ok" | "alert" | "exceeded";

export interface BudgetStatus {
  used: number;
  budget: number;
  /** Plafond dur : ligne = budget fourni ; phase = budget x `phase_budget_ceiling_factor`. */
  hard_ceiling: number;
  ratio: number;
  /** `alert` à `phase_budget_alert_ratio`, `exceeded` au plafond dur. */
  level: BudgetLevel;
}

/** Compte les tokens (source : flux d'événements §5, une seule source de vérité). */
export interface BudgetMeter {
  setLineBudget(line: LineId, tokens: number): void;
  setPhaseBudget(phase: Phase, tokens: number): void;
  record(line: LineId, phase: Phase, usage: TokenUsage): void;
  line(line: LineId): BudgetStatus;
  phase(phase: Phase): BudgetStatus;
}
