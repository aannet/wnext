/**
 * Machine à états d'une ligne (§4.1) et compteurs de retries bornés (§4.3). Pure : aucune horloge, le temps est un argument.
 * Détient le `LineState` lu tel quel par le Superviseur. Les champs d'observation (diffs, erreurs CI, tokens...) sont
 * alimentés par l'`EventAggregator`, les champs de décision (cycles, statut, relances) par la machine et le `Core`.
 */
import type { SupervisorConfig } from "../types";
import type { LineId, LineState, ModelId, Phase, PipelineStep } from "../types";

export class InvalidTransitionError extends Error {
  constructor(msg: string) { super(msg); this.name = "InvalidTransitionError"; }
}

export type TransitionOutcome =
  | { kind: "ok" }
  /** Épuisement §4.3 : la machine est déjà passée en `blocked`. */
  | { kind: "blocked"; reason: string }
  /** 2 cycles déjà consommés sur le modèle courant : l'appelant doit `switchModel` (ou bloquer) puis réessayer ; rien n'a été muté. */
  | { kind: "model_change" };

const NEXT: Record<PipelineStep, PipelineStep[]> = {
  spec: ["tests"],
  tests: ["impl"],
  impl: ["local_check", "ci"],
  local_check: ["ci", "impl"],
  ci: ["impl", "review"],
  review: ["impl", "merge"],
  merge: [],
};

export interface LineInit {
  line: LineId; phase: Phase; run_id: string;
  /** Plafond dur de tokens de la ligne (3 x estimation). */
  token_budget: number;
  now_ms: number;
  model: ModelId;
  sensitive_path?: boolean;
}

export class LineMachine {
  readonly state: LineState;
  blockReason: string | null = null;
  private current: ModelId;

  constructor(init: LineInit, private readonly retries: SupervisorConfig["retries"]) {
    this.current = init.model;
    this.state = {
      line: init.line, phase: init.phase, run_id: init.run_id, status: "running", step: "spec",
      cycles: { total: 0, by_model: {} }, review_returns: 0,
      tokens: { used: 0, budget: init.token_budget, used_at_last_green_gain: 0 },
      started_at_ms: init.now_ms, last_commit_at_ms: null, last_step_change_at_ms: init.now_ms,
      green_tests: 0, recent_diffs: [], recent_ci_errors: [], interruptions: 0, relaunches_by_agent: {},
      f_escalations: 0, sensitive_path: !!init.sensitive_path,
    };
  }

  get model(): ModelId { return this.current; }
  get terminal(): boolean { return this.state.status === "done" || this.state.status === "killed" || this.state.status === "blocked"; }

  switchModel(m: ModelId): void { this.current = m; }

  canTransition(to: PipelineStep): boolean { return this.state.status === "running" && NEXT[this.state.step].includes(to); }

  advance(to: PipelineStep, now_ms: number): TransitionOutcome {
    const from = this.state.step;
    if (!this.canTransition(to)) throw new InvalidTransitionError(`transition invalide ${from} -> ${to} (statut ${this.state.status})`);
    if (to === "impl" && (from === "ci" || from === "review")) {
      if (from === "review" && this.state.review_returns >= this.retries.max_review_returns) return this.exhaust("review_returns_exhausted", now_ms);
      if (this.state.cycles.total >= this.retries.max_cycles_total) return this.exhaust("cycles_exhausted", now_ms);
      if ((this.state.cycles.by_model[this.current] ?? 0) >= this.retries.max_cycles_per_model) return { kind: "model_change" };
      if (from === "review") this.state.review_returns++;
    }
    if (to === "ci") {
      this.state.cycles.total++;
      this.state.cycles.by_model[this.current] = (this.state.cycles.by_model[this.current] ?? 0) + 1;
    }
    this.state.step = to;
    this.state.last_step_change_at_ms = now_ms;
    return { kind: "ok" };
  }

  private exhaust(reason: string, now_ms: number): TransitionOutcome {
    this.block(reason, now_ms);
    return { kind: "blocked", reason };
  }

  /** merge -> done. */
  complete(now_ms: number): void {
    if (this.state.status !== "running" || this.state.step !== "merge") throw new InvalidTransitionError("complete() exige l'étape merge");
    this.state.status = "done";
    this.state.last_step_change_at_ms = now_ms;
  }

  /** Retour à la spécification (relance `respec`). Compteurs conservés. */
  respec(now_ms: number): void {
    if (this.state.status !== "running" && this.state.status !== "looping") throw new InvalidTransitionError("respec : ligne terminale");
    if (this.state.step === "merge") throw new InvalidTransitionError("respec impossible depuis merge");
    this.state.status = "running";
    this.state.step = "spec";
    this.state.last_step_change_at_ms = now_ms;
  }

  /** Idempotent : conserve la première cause. */
  block(reason: string, _now_ms: number): void {
    if (this.state.status === "done" || this.state.status === "killed") return;
    if (this.state.status !== "blocked") this.blockReason = reason;
    this.state.status = "blocked";
  }

  markLooping(_now_ms: number): void {
    if (this.state.status !== "running") throw new InvalidTransitionError(`looping depuis ${this.state.status}`);
    this.state.status = "looping";
  }

  /** looping -> running (relance avec changement). */
  resume(): void {
    if (this.state.status !== "looping") throw new InvalidTransitionError(`resume depuis ${this.state.status}`);
    this.state.status = "running";
  }

  kill(_now_ms: number): void {
    if (this.state.status === "done") return;
    this.state.status = "killed";
  }

  /** Durée murale max atteinte (>= ; les retards de backoff comptent car la mesure part de `started_at_ms`). */
  wallExceeded(now_ms: number): boolean { return now_ms - this.state.started_at_ms >= this.retries.max_wall_clock_min * 60_000; }
}
