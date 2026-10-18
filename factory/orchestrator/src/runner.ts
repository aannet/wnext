/**
 * Contrat d'exécution d'un agent (ADR-007 : une session `claude -p` par rôle et par ligne) + FakeRunner de test.
 * L9.3 fournit l'implémentation réelle (src/runner-claude/) ; ce fichier ne contient que l'interface et le FakeRunner.
 */
import type { Agent, Clock, FactoryEvent, LineId, ModelId, Phase } from "./types";

export interface AgentLimits {
  /** Plafond de tokens de la session (entrée + sortie, cache compris) ; suivi par l'orchestrateur sur le flux (ADR-007). */
  max_tokens: number;
  /** Durée murale max de la session. */
  max_wall_ms: number;
}

export interface AgentSpec {
  instance_id: string;
  run_id: string;
  line: LineId;
  phase: Phase;
  role: Agent;
  model: ModelId;
  /** Prompt de la tâche (jamais recopié dans les événements, §5.3). */
  prompt: string;
  /** Prompt système du rôle (optionnel). */
  system_prompt?: string;
  /** Worktree dédié de l'agent (§4.2). */
  worktree: string;
  /** Outils autorisés (liste blanche du rôle, §2). */
  allowed_tools: string[];
  limits: AgentLimits;
  /** `attempt` à reporter dans les événements (cycle impl->CI). */
  attempt?: number;
  parent_instance_id?: string;
}

/** `soft` : fin propre au prochain point sûr (SIGTERM) ; `hard` : immédiat, groupe de processus entier (SIGKILL). */
export type StopMode = "soft" | "hard";

export type EndReason =
  | "completed"
  | "stopped_soft"
  | "stopped_hard"
  | "limit_tokens"
  | "limit_wall"
  /** Détecté via permission_denials / événement `kill.triggered`, jamais via le code retour (ADR-007). */
  | "kill_switch"
  | "error";

export interface TokenUsage {
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
}

export interface AgentResult {
  instance_id: string;
  end_reason: EndReason;
  usage: TokenUsage;
  num_turns: number;
  duration_ms: number;
  permission_denials: number;
  exit_code: number | null;
  /** Message d'erreur technique court (sans contenu sensible) si `end_reason === "error"`. */
  error?: string;
}

export interface AgentHandle {
  readonly instance_id: string;
  readonly pid: number | null;
  readonly pgid: number | null;
  /**
   * Flux des événements §5 émis par l'agent, dans l'ordre. Consommateur unique.
   * Se termine (done) quand l'agent est terminé ; ne lève jamais (les erreurs sont dans `result`).
   */
  readonly events: AsyncIterable<FactoryEvent>;
  /** Idempotent. Se résout quand l'agent (groupe de processus compris) est arrêté. */
  stop(mode: StopMode): Promise<void>;
  /** Se résout une fois, à la fin de l'agent ; ne rejette jamais. */
  readonly result: Promise<AgentResult>;
}

export interface AgentRunner {
  /** Lance l'agent. Lève si le kill-switch est actif (cf. `launchSession`, factory/lib/kill.mjs). */
  start(spec: AgentSpec): AgentHandle;
}

// ---------------------------------------------------------------------------------------------------------------------
// FakeRunner : script d'événements avec délais simulés par la Clock injectée.
// ---------------------------------------------------------------------------------------------------------------------

/** Événement scripté : champs d'identité (ts, run_id, line, phase, agent, model, instance_id) complétés par le runner. */
export type FakeEventInput = Pick<FactoryEvent, "action" | "status"> & Partial<Omit<FactoryEvent, "action" | "status">>;

export interface FakeStep {
  /** Délai (Clock) avant l'émission de cet événement, depuis l'étape précédente. */
  after_ms: number;
  event: FakeEventInput;
}

export interface FakeScript {
  steps: FakeStep[];
  /**
   * Fin de l'agent après les étapes (délai `after_ms` d'abord). Absent = l'agent ne se termine pas seul
   * (simule un agent qui boucle ou reste muet : seul `stop()` ou une limite le termine).
   */
  end?: { after_ms: number; reason: Exclude<EndReason, "stopped_soft" | "stopped_hard" | "limit_wall" | "limit_tokens">; usage?: Partial<TokenUsage>; error?: string };
}

export type FakeScriptSource = FakeScript | ((spec: AgentSpec) => FakeScript);

const ZERO_USAGE: TokenUsage = { tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 };

class EventQueue implements AsyncIterable<FactoryEvent> {
  private buf: FactoryEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  push(e: FactoryEvent): void { if (this.closed) return; this.buf.push(e); this.wake(); }
  close(): void { this.closed = true; this.wake(); }
  private wake(): void { const w = this.waiter; this.waiter = null; w?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<FactoryEvent> {
    for (;;) {
      const e = this.buf.shift();
      if (e) { yield e; continue; }
      if (this.closed) return;
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }
}

export class FakeRunner implements AgentRunner {
  /** Specs reçus, dans l'ordre (assertions des tests des autres lignes). */
  readonly started: AgentSpec[] = [];
  /** Appels à `stop`, dans l'ordre. */
  readonly stops: { instance_id: string; mode: StopMode }[] = [];
  /** Si vrai, `start` lève comme `launchSession` quand `factory/KILL` existe. */
  killSwitchActive = false;
  private nextPid = 40_000;

  constructor(private readonly clock: Clock, private readonly scripts: FakeScriptSource | Partial<Record<Agent, FakeScriptSource>>) {}

  start(spec: AgentSpec): AgentHandle {
    if (this.killSwitchActive) throw new Error("kill-switch actif : lancement refusé");
    const script = this.resolve(spec);
    this.started.push(spec);
    const queue = new EventQueue();
    const abort = new AbortController();
    const ctl: { stopMode: StopMode | null; forced: EndReason | null } = { stopMode: null, forced: null };
    let stopped: Promise<void> | null = null;
    const pid = this.nextPid++;
    const t0 = this.clock.now();
    const usage = { ...ZERO_USAGE };
    let turns = 0;
    let denials = 0;

    const result = (async (): Promise<AgentResult> => {
      let reason: EndReason = "completed";
      let error: string | undefined;
      void this.clock.sleep(spec.limits.max_wall_ms, abort.signal).then(() => { if (!abort.signal.aborted) { ctl.forced = "limit_wall"; abort.abort(); } });
      outer: {
        for (const step of script.steps) {
          await this.clock.sleep(step.after_ms, abort.signal);
          if (abort.signal.aborted) break outer;
          const ev = this.materialize(spec, step.event, step.after_ms);
          usage.tokens_in += ev.tokens_in; usage.tokens_out += ev.tokens_out; usage.cost_usd += ev.cost;
          usage.tokens_cache_read += ev.tokens_cache_read ?? 0; usage.tokens_cache_write += ev.tokens_cache_write ?? 0;
          if (ev.action === "llm.call") turns++;
          if (ev.action === "kill.triggered") { denials++; reason = "kill_switch"; }
          queue.push(ev);
          if (usage.tokens_in + usage.tokens_out > spec.limits.max_tokens) { ctl.forced = "limit_tokens"; break outer; }
        }
        if (script.end) {
          await this.clock.sleep(script.end.after_ms, abort.signal);
          if (abort.signal.aborted) break outer;
          if (reason !== "kill_switch") reason = script.end.reason;
          error = script.end.error;
          Object.assign(usage, script.end.usage);
        } else {
          await new Promise<void>((r) => abort.signal.addEventListener("abort", () => r(), { once: true }));
        }
      }
      if (ctl.forced) reason = ctl.forced;
      else if (ctl.stopMode) reason = ctl.stopMode === "soft" ? "stopped_soft" : "stopped_hard";
      abort.abort();
      queue.close();
      return { instance_id: spec.instance_id, end_reason: reason, usage, num_turns: turns, duration_ms: this.clock.now() - t0, permission_denials: denials, exit_code: reason === "error" ? 1 : 0, ...(error ? { error } : {}) };
    })();

    return {
      instance_id: spec.instance_id,
      pid,
      pgid: pid,
      events: queue,
      result,
      stop: (mode) => {
        this.stops.push({ instance_id: spec.instance_id, mode });
        if (!stopped) {
          ctl.stopMode = mode;
          abort.abort();
          stopped = result.then(() => undefined);
        } else if (mode === "hard") ctl.stopMode = "hard";
        return stopped;
      },
    };
  }

  private resolve(spec: AgentSpec): FakeScript {
    const src = typeof this.scripts === "function" || "steps" in this.scripts ? (this.scripts as FakeScriptSource) : (this.scripts as Partial<Record<Agent, FakeScriptSource>>)[spec.role];
    if (!src) throw new Error(`FakeRunner : aucun script pour le rôle ${spec.role}`);
    return typeof src === "function" ? src(spec) : src;
  }

  private materialize(spec: AgentSpec, e: FakeEventInput, afterMs: number): FactoryEvent {
    return {
      ts: new Date(this.clock.now()).toISOString(),
      run_id: spec.run_id, line: spec.line, phase: spec.phase,
      agent: spec.role, model: spec.model, instance_id: spec.instance_id,
      tokens_in: 0, tokens_out: 0, cost: 0, duration_ms: afterMs,
      ...(spec.attempt ? { attempt: spec.attempt } : {}),
      ...(spec.parent_instance_id ? { parent_instance_id: spec.parent_instance_id } : {}),
      ...e,
    };
  }
}
