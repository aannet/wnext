/**
 * Noyau de l'orchestrateur (L9.2) : pipeline d'une ligne (§4.1), worktrees et verrous (§4.2), retries bornés (§4.3),
 * kill-switch (§4.5), boucle de tick du Superviseur et exécution de ses actions (§4.8), émission des événements §5.
 * Tout passe par des ports injectés ; le temps passe par `Clock` (jamais Date.now() ni timer réel).
 */
import type { BudgetMeter, Depanneur, EventSink, WorktreeManager, WorktreeRef } from "../ports";
import type { AgentHandle, AgentResult, AgentRunner, AgentSpec } from "../runner";
import type {
  Agent, AssessVerdict, Clock, FactoryEvent, LineId, ModelId, Phase, PipelineStep, ReceivedVerdict, Signal, SignalKind, Supervisor,
  SupervisorAction, SupervisorConfig,
} from "../types";
import { EventAggregator } from "./aggregator";
import { backoffDelayMs, isRetryableApiError } from "./backoff";
import { LineMachine, type TransitionOutcome } from "./line-machine";
import type { KillSwitch } from "./kill-port";
import { modelFor, resolveUpgrade, type ModelTable } from "./models";
import { PathLockManager } from "./path-lock";

export interface CoreDeps {
  clock: Clock;
  runner: AgentRunner;
  sink: EventSink;
  worktrees: WorktreeManager;
  budget: BudgetMeter;
  depanneur: Depanneur;
  /** INJECTÉ : L9.1 fournit l'implémentation, les tests un faux. */
  supervisor: Supervisor;
  config: SupervisorConfig;
  models: ModelTable;
  kill: KillSwitch;
  /** Phase courante, pour les événements hors ligne (`supervisor.tick`). */
  phase: Phase;
  /** run_id des événements hors ligne. */
  run_id: string;
  locks?: PathLockManager;
  /** Complète le prompt d'une relance (le changement est obligatoire, §4.8 niveau 4). Défaut : ajoute une consigne datée du changement. */
  adjustPrompt?: (prompt: string, change: Extract<SupervisorAction, { type: "relaunch" }>["change"]) => string;
}

export interface LineSpec {
  line: LineId; phase: Phase; run_id: string;
  /** Estimation du Router ; plafond dur de la ligne = `retries.line_budget_factor` x estimation. */
  token_estimate: number;
  /** Fichiers autorisés (liste blanche de la spec) : verrouillés par la ligne dès le premier agent écrivant. */
  files: string[];
  sensitive_path?: boolean;
  model?: ModelId;
}

export interface StartAgentRequest {
  line: LineId; role: Agent; prompt: string; allowed_tools: string[];
  /** Agent écrivant : worktree propre + verrous de chemin. */
  writing?: boolean;
  system_prompt?: string; model?: ModelId; parent_instance_id?: string;
}

export interface AgentSession {
  spec: AgentSpec;
  handle: AgentHandle;
  worktree: WorktreeRef;
  req: StartAgentRequest;
  /** Résolu à la fin de la session (flux d'événements entièrement ingéré). */
  done: Promise<AgentResult>;
  ended: boolean;
}

type Relaunch = Extract<SupervisorAction, { type: "relaunch" }>;
const SIGNAL_KINDS = new Set<string>(["cycles_exhausted", "review_returns_exhausted", "wall_clock", "line_budget_ceiling", "relaunch_exhausted"]);
const MS_MIN = 60_000;

export class Core {
  private readonly d: CoreDeps;
  private readonly locks: PathLockManager;
  readonly aggregator: EventAggregator;
  private machines = new Map<LineId, LineMachine>();
  private files = new Map<LineId, string[]>();
  private live = new Map<string, AgentSession>();
  private specs = new Map<string, AgentSession>();
  private worktreeOf = new Map<string, WorktreeRef>(); // `${line}/${role}`
  private verdicts = new Map<LineId, ReceivedVerdict[]>();
  private warned = new Map<string, Set<string>>();
  private alerted = new Set<string>();
  private exceeded = new Set<string>();
  private finalized = new Set<LineId>();
  private lockHeld = new Set<LineId>();
  private pending = new Set<Promise<unknown>>();
  private seq = 0;
  private killed = false;
  private readonly stopAc = new AbortController();

  constructor(deps: CoreDeps) {
    this.d = deps;
    this.locks = deps.locks ?? new PathLockManager();
    this.aggregator = new EventAggregator({ budget: deps.budget, config: deps.config });
  }

  // ------------------------------------------------------------------------------------------------ lignes
  registerLine(s: LineSpec): LineMachine {
    const r = this.d.config.retries;
    const model = s.model ?? modelFor(this.d.models, "implementeur", !!s.sensitive_path);
    const budget = s.token_estimate * r.line_budget_factor;
    const m = new LineMachine({ line: s.line, phase: s.phase, run_id: s.run_id, token_budget: budget, now_ms: this.d.clock.now(), model, sensitive_path: s.sensitive_path }, r);
    this.machines.set(s.line, m);
    this.files.set(s.line, s.files);
    this.d.budget.setLineBudget(s.line, budget);
    this.aggregator.registerLine(m);
    return m;
  }
  machine(line: LineId): LineMachine { return this.mustMachine(line); }
  private mustMachine(line: LineId): LineMachine {
    const m = this.machines.get(line);
    if (!m) throw new Error(`ligne inconnue : ${line}`);
    return m;
  }
  /** Attend la fin des tâches de fond (blocages, interruptions budgétaires). */
  async idle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  private track(p: Promise<unknown>): void { this.pending.add(p); void p.finally(() => this.pending.delete(p)).catch(() => {}); p.catch(() => {}); }

  // ------------------------------------------------------------------------------------------------ événements
  private emit(line: LineId | null, e: { agent?: string; action: string; status: string; detail?: Record<string, string | number | boolean | undefined | null>; parent_id?: string; attempt?: number; instance_id?: string; scope?: "_phase" }): FactoryEvent {
    const m = line ? this.machines.get(line) : undefined;
    const detail: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(e.detail ?? {})) if (v !== undefined) detail[k] = v;
    const ev: FactoryEvent = {
      ts: new Date(this.d.clock.now()).toISOString(),
      run_id: m ? m.state.run_id : this.d.run_id,
      line: line ?? e.scope ?? "_global",
      phase: m ? m.state.phase : this.d.phase,
      agent: e.agent ?? "orchestrateur", model: "none", action: e.action,
      tokens_in: 0, tokens_out: 0, cost: 0, duration_ms: 0, status: e.status,
      ...(e.attempt !== undefined ? { attempt: e.attempt } : {}),
      ...(e.parent_id ? { parent_id: e.parent_id } : {}),
      ...(e.instance_id ? { instance_id: e.instance_id } : {}),
      ...(Object.keys(detail).length ? { detail } : {}),
    };
    this.ingest(ev);
    return ev;
  }
  private sup(line: LineId | null, e: Omit<Parameters<Core["emit"]>[1], "agent">): FactoryEvent { return this.emit(line, { ...e, agent: "superviseur" }); }

  /** Point d'entrée unique du flux : sink + budget + agrégation (une seule source de vérité). */
  private ingest(e: FactoryEvent): void {
    this.d.sink.emit(e);
    const tokens = e.tokens_in + e.tokens_out + (e.tokens_cache_read ?? 0) + (e.tokens_cache_write ?? 0);
    if (tokens > 0) {
      this.d.budget.record(e.line, e.phase, { tokens_in: e.tokens_in, tokens_out: e.tokens_out, tokens_cache_read: e.tokens_cache_read ?? 0, tokens_cache_write: e.tokens_cache_write ?? 0, cost_usd: e.cost });
    }
    this.aggregator.observe(e, this.d.clock.now());
    if (tokens > 0 && this.machines.has(e.line)) this.checkBudgets(e.line, e.phase);
  }

  // ------------------------------------------------------------------------------------------------ budget (§4.3, §4.5)
  private checkBudgets(line: LineId | null, phase: Phase): void {
    if (line) {
      const lb = this.d.budget.line(line);
      const ratio = Math.round(lb.ratio * 1000) / 1000;
      if (lb.level === "exceeded" && !this.exceeded.has(`line:${line}`)) {
        this.exceeded.add(`line:${line}`);
        this.emit(line, { action: "budget.exceeded", status: "error", detail: { scope: "line", used: lb.used, ceiling: lb.hard_ceiling } });
        this.track(this.onLineBudgetExceeded(line));
      } else if (lb.level === "alert" && !this.alerted.has(`line:${line}`)) {
        this.alerted.add(`line:${line}`);
        this.emit(line, { action: "budget.alert", status: "ok", detail: { scope: "line", ratio, used: lb.used, budget: lb.budget } });
      }
    }
    const pb = this.d.budget.phase(phase);
    const pr = Math.round(pb.ratio * 1000) / 1000;
    if (pb.level === "exceeded" && !this.exceeded.has(`phase:${phase}`)) {
      this.exceeded.add(`phase:${phase}`);
      this.emit(null, { action: "budget.exceeded", status: "error", detail: { scope: "phase", phase, used: pb.used, ceiling: pb.hard_ceiling }, scope: "_phase" });
      this.track(this.onPhaseBudgetExceeded(phase));
    } else if (pb.level === "alert" && !this.alerted.has(`phase:${phase}`)) {
      this.alerted.add(`phase:${phase}`);
      this.emit(null, { action: "budget.alert", status: "ok", detail: { scope: "phase", phase, ratio: pr, used: pb.used, budget: pb.budget }, scope: "_phase" });
    }
  }
  private async onLineBudgetExceeded(line: LineId): Promise<void> {
    for (const s of this.sessionsOf((x) => x.spec.line === line)) await this.interruptSession(s, "plafond de tokens de la ligne atteint", { kind: "line_budget_ceiling" });
    await this.blockLine(line, "line_budget_ceiling", { kind: "line_budget_ceiling" });
  }
  private async onPhaseBudgetExceeded(phase: Phase): Promise<void> {
    for (const s of this.sessionsOf((x) => x.spec.phase === phase)) await this.interruptSession(s, "plafond de tokens de la phase atteint", { kind: "phase_budget_ceiling" });
  }

  // ------------------------------------------------------------------------------------------------ sessions d'agents
  private sessionsOf(pred: (s: AgentSession) => boolean): AgentSession[] { return [...this.live.values()].filter(pred); }

  async startAgent(req: StartAgentRequest): Promise<AgentSession | null> {
    const m = this.mustMachine(req.line);
    this.assertCanLaunch(m);
    const wallLeft = (m.state.started_at_ms + this.d.config.retries.max_wall_clock_min * MS_MIN) - this.d.clock.now();
    const lb = this.d.budget.line(req.line);
    const tokenLeft = lb.budget > 0 ? lb.budget - lb.used : Number.MAX_SAFE_INTEGER;
    if (wallLeft <= 0) { await this.blockLine(req.line, "wall_clock", { kind: "wall_clock" }); return null; }
    if (tokenLeft <= 0) { await this.blockLine(req.line, "line_budget_ceiling", { kind: "line_budget_ceiling" }); return null; }

    if (req.writing) await this.acquireLocks(req.line);
    this.assertCanLaunch(m); // l'attente d'un verrou a pu durer

    const wt = await this.worktreeFor(m, req);
    const model = req.model ?? m.model;
    const spec: AgentSpec = {
      instance_id: `${req.role}-${req.line}-${++this.seq}`, run_id: m.state.run_id, line: req.line, phase: m.state.phase,
      role: req.role, model, prompt: req.prompt, worktree: wt.path, allowed_tools: req.allowed_tools,
      limits: { max_tokens: tokenLeft, max_wall_ms: Math.max(1, m.state.started_at_ms + this.d.config.retries.max_wall_clock_min * MS_MIN - this.d.clock.now()) },
      attempt: m.state.cycles.total + 1,
      ...(req.system_prompt ? { system_prompt: req.system_prompt } : {}),
      ...(req.parent_instance_id ? { parent_instance_id: req.parent_instance_id } : {}),
    };
    const handle = this.d.runner.start(spec);
    const session = { spec, handle, worktree: wt, req, ended: false } as AgentSession;
    this.live.set(spec.instance_id, session);
    this.specs.set(spec.instance_id, session);
    this.aggregator.agentStarted({ instance_id: spec.instance_id, line: spec.line, role: spec.role, model, pid: handle.pid, pgid: handle.pgid }, this.d.clock.now());
    this.emit(req.line, { action: "session.start", status: "ok", attempt: spec.attempt, detail: { instance: spec.instance_id, role: req.role, session_model: model } });
    session.done = this.pump(session);
    session.done.catch(() => {});
    return session;
  }

  private assertCanLaunch(m: LineMachine): void {
    if (this.killed || this.d.kill.isActive()) throw new Error("kill-switch actif : lancement refusé");
    if (m.state.status !== "running") throw new Error(`ligne ${m.state.line} non running (${m.state.status})`);
  }

  private async acquireLocks(line: LineId): Promise<void> {
    if (this.lockHeld.has(line)) return;
    const files = this.files.get(line) ?? [];
    if (!files.length) return;
    if (!this.locks.tryAcquire(line, files)) {
      this.emit(line, { action: "lock.wait", status: "ok", detail: { files: files.length } });
      await this.locks.acquire(line, files, this.stopAc.signal);
    }
    this.lockHeld.add(line);
    this.emit(line, { action: "lock.acquired", status: "ok", detail: { files: files.length } });
  }
  private releaseLocks(line: LineId): void { if (this.lockHeld.delete(line)) this.locks.release(line); }

  private async worktreeFor(m: LineMachine, req: StartAgentRequest): Promise<WorktreeRef> {
    const key = `${req.line}/${req.role}`;
    const known = this.worktreeOf.get(key);
    if (known) return known;
    if (!req.writing) {
      const any = [...this.worktreeOf].find(([k]) => k.startsWith(`${req.line}/`));
      if (any) return any[1];
    }
    const wt = await this.d.worktrees.create({ run_id: m.state.run_id, line: req.line, agent: req.role, branch: `line/${req.line}` });
    this.worktreeOf.set(key, wt);
    return wt;
  }
  private worktreesOf(line: LineId): WorktreeRef[] { return [...this.worktreeOf].filter(([k]) => k.startsWith(`${line}/`)).map(([, v]) => v); }

  private async pump(s: AgentSession): Promise<AgentResult> {
    try { for await (const e of s.handle.events) this.ingest(e); } catch { /* le flux ne lève pas (contrat) */ }
    const r = await s.handle.result;
    this.endSession(s);
    this.emit(s.spec.line, { action: "session.end", status: r.end_reason === "completed" ? "ok" : r.end_reason === "error" ? "error" : "skipped", detail: { instance: s.spec.instance_id, end_reason: r.end_reason } });
    const m = this.machines.get(s.spec.line);
    if (m && (m.state.status === "running" || m.state.status === "looping")) {
      if (r.end_reason === "limit_tokens") await this.blockLine(s.spec.line, "line_budget_ceiling", { kind: "line_budget_ceiling" });
      else if (r.end_reason === "limit_wall") await this.blockLine(s.spec.line, "wall_clock", { kind: "wall_clock" });
    }
    return r;
  }
  private endSession(s: AgentSession): void {
    s.ended = true;
    this.live.delete(s.spec.instance_id);
    this.aggregator.agentEnded(s.spec.instance_id);
  }

  /** Arrêt propre avec échéance `kill.stop_deadline_s` sur l'horloge injectée, puis arrêt dur (§4.5). */
  private async stopSession(s: AgentSession): Promise<void> {
    if (s.ended) return;
    const ac = new AbortController();
    const soft = s.handle.stop("soft").then(() => "ok" as const);
    const timeout = this.d.clock.sleep(this.d.config.kill.stop_deadline_s * 1000, ac.signal).then(() => (ac.signal.aborted ? ("aborted" as const) : ("timeout" as const)));
    const w = await Promise.race([soft, timeout]);
    ac.abort();
    if (w === "timeout") await s.handle.stop("hard");
    this.endSession(s);
  }

  /** Exécute un agent jusqu'à sa fin, avec backoff exponentiel sur 429/5xx (non compté comme retry de ligne, compté au temps). */
  async runAgent(req: StartAgentRequest): Promise<{ result?: AgentResult; api_exhausted: boolean }> {
    let tries = 0;
    let current = req;
    for (;;) {
      const s = await this.startAgent(current);
      if (!s) return { api_exhausted: false };
      const result = await s.done;
      const m = this.mustMachine(req.line);
      if (!isRetryableApiError(result) || m.terminal) return { result, api_exhausted: false };
      if (tries < this.d.config.retries.api_backoff_max_attempts) {
        const ms = backoffDelayMs(tries++);
        this.emit(req.line, { action: "retry.start", status: "retry", attempt: m.state.cycles.total + 1, detail: { reason: "api_error", backoff_ms: ms, try: tries } });
        await this.d.clock.sleep(ms, this.stopAc.signal);
        if (this.killed) return { result, api_exhausted: false };
        continue;
      }
      const up = this.upgrade(req.line, s.spec.model, "api_backoff");
      if (!up) { await this.blockLine(req.line, "api_backoff_exhausted", { kind: "no_progress" }); return { result, api_exhausted: true }; }
      tries = 0;
      current = { ...req, model: up };
    }
  }

  /** Modèle supérieur via la table (une seule montée vers F) ; émet `escalate.model` ; met à jour la ligne. Null si impossible. */
  private upgrade(line: LineId, from: ModelId, reason: string): ModelId | null {
    const m = this.mustMachine(line);
    const to = resolveUpgrade(this.d.models, from, { f_escalations: m.state.f_escalations, max_f_escalations: this.d.config.relaunch.max_f_escalations_per_line });
    if (!to) return null;
    if (to === this.d.models.f_model) m.state.f_escalations++;
    m.switchModel(to);
    this.emit(line, { action: "escalate.model", status: "escalated", detail: { from, to, reason } });
    return to;
  }

  // ------------------------------------------------------------------------------------------------ pipeline (§4.1, §4.3)
  async advance(line: LineId, to: PipelineStep): Promise<TransitionOutcome> {
    const m = this.mustMachine(line);
    const from = m.state.step;
    let out = m.advance(to, this.d.clock.now());
    if (out.kind === "model_change") {
      if (!this.upgrade(line, m.model, "model_cycles")) {
        m.block("model_exhausted", this.d.clock.now());
        out = { kind: "blocked", reason: "model_exhausted" };
      } else out = m.advance(to, this.d.clock.now());
    }
    if (out.kind === "blocked") { await this.blockLine(line, out.reason, { kind: (SIGNAL_KINDS.has(out.reason) ? out.reason : "no_progress") as SignalKind }); return out; }
    this.emit(line, { action: "pipeline.step", status: "ok", detail: { from, to } });
    return out;
  }
  /** Résultat de CI : vert -> review ; rouge -> retour à impl (cycle suivant), `retry.start`. */
  async completeCi(line: LineId, passed: boolean): Promise<TransitionOutcome> {
    if (passed) return this.advance(line, "review");
    const out = await this.advance(line, "impl");
    if (out.kind === "ok") this.emit(line, { action: "retry.start", status: "retry", attempt: this.mustMachine(line).state.cycles.total + 1, detail: { reason: "ci_failed" } });
    return out;
  }
  async reviewVerdict(line: LineId, verdict: "approve" | "changes"): Promise<TransitionOutcome> {
    if (verdict === "approve") return this.advance(line, "merge");
    const out = await this.advance(line, "impl");
    if (out.kind === "ok") this.emit(line, { action: "retry.start", status: "retry", attempt: this.mustMachine(line).state.cycles.total + 1, detail: { reason: "review_changes" } });
    return out;
  }
  async mergeDone(line: LineId): Promise<void> {
    const m = this.mustMachine(line);
    m.complete(this.d.clock.now());
    this.finalized.add(line);
    this.emit(line, { action: "merge.done", status: "ok" });
    for (const s of this.sessionsOf((x) => x.spec.line === line)) await this.stopSession(s);
    for (const wt of this.worktreesOf(line)) await this.d.worktrees.remove(wt);
    this.releaseLocks(line);
  }

  // ------------------------------------------------------------------------------------------------ blocage et kill
  async blockLine(line: LineId, reason: string, signal?: Signal): Promise<void> {
    const m = this.mustMachine(line);
    if (this.finalized.has(line) || m.state.status === "done" || m.state.status === "killed") return;
    this.finalized.add(line);
    m.block(reason, this.d.clock.now());
    for (const s of this.sessionsOf((x) => x.spec.line === line)) {
      await this.stopSession(s);
      await this.d.worktrees.snapshot(s.worktree, "blocked").catch(() => undefined);
    }
    let report: string | undefined;
    try { report = await this.d.depanneur.report(this.aggregator.logFor(line, signal ?? { kind: "no_progress" })); } catch { report = undefined; }
    this.emit(line, { action: "status.blocked", status: "blocked", detail: { reason: m.blockReason ?? reason, report } });
    for (const wt of this.worktreesOf(line)) await this.d.worktrees.remove(wt, { keep: true });
    this.releaseLocks(line);
  }

  private async killAll(scope: "phase" | "global", phase: Phase, reason: string, signal: Signal, trigger: boolean): Promise<void> {
    if (scope === "global") {
      this.killed = true;
      if (trigger) await this.d.kill.trigger(reason);
    }
    const lines = [...this.machines.values()].filter((m) => (scope === "global" || m.state.phase === phase) && m.state.status !== "done" && m.state.status !== "killed");
    const ids = new Set(lines.map((m) => m.state.line));
    await Promise.all(this.sessionsOf((s) => ids.has(s.spec.line)).map((s) => this.stopSession(s)));
    for (const m of lines) {
      m.kill(this.d.clock.now());
      this.finalized.add(m.state.line);
      for (const wt of this.worktreesOf(m.state.line)) await this.d.worktrees.remove(wt, { keep: true });
      this.releaseLocks(m.state.line);
    }
    this.stopAc.abort();
    this.emit(null, { agent: "superviseur", action: "kill.triggered", status: "killed", scope: scope === "phase" ? "_phase" : undefined, detail: { scope, reason, signal: signal.kind, lines: lines.length, ...(scope === "phase" ? { phase } : {}) } });
  }

  // ------------------------------------------------------------------------------------------------ tick (§4.8)
  async tick(): Promise<void> {
    const now = this.d.clock.now();
    if (!this.killed && this.d.kill.isActive()) await this.killAll("global", this.d.phase, "factory/KILL présent", { kind: "kill_switch_file" }, false);
    const active = [...this.machines.values()].filter((m) => !m.terminal).length;
    this.sup(null, { action: "supervisor.tick", status: "ok", detail: { lines: active, agents: this.live.size } });
    if (this.killed) return;
    for (const phase of new Set([...this.machines.values()].map((m) => m.state.phase))) this.checkBudgets(null, phase);
    await this.idle();

    for (const m of [...this.machines.values()]) {
      if (this.killed) break;
      const line = m.state.line;
      if (m.state.status !== "running" && m.state.status !== "looping") continue;
      if (m.wallExceeded(now)) { await this.blockLine(line, "wall_clock", { kind: "wall_clock", value: now - m.state.started_at_ms, threshold: this.d.config.retries.max_wall_clock_min * MS_MIN }); continue; }
      const verdicts = this.verdicts.get(line) ?? [];
      const input = this.aggregator.buildInput(line, { now, verdicts: [...verdicts], killActive: this.d.kill.isActive() });
      let actions: SupervisorAction[];
      try { actions = this.d.supervisor.decide(input); } catch (err) {
        this.sup(line, { action: "supervisor.error", status: "error", detail: { stage: "decide", error: (err as Error).message } });
        continue;
      }
      this.verdicts.set(line, this.verdicts.get(line)?.filter((v) => !verdicts.includes(v)) ?? []);
      for (const a of actions) {
        if (this.killed) break;
        try { await this.execute(a); } catch (err) {
          this.sup(a.line, { action: "supervisor.error", status: "error", detail: { stage: a.type, error: (err as Error).message } });
        }
      }
    }
  }

  /** Boucle de tick toutes les `supervisor.tick_s` secondes (horloge injectée) jusqu'à l'annulation ou au kill. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.killed) {
      await this.tick();
      await this.d.clock.sleep(this.d.config.supervisor.tick_s * 1000, signal);
    }
  }

  async execute(a: SupervisorAction): Promise<void> {
    switch (a.type) {
      case "warn": return this.warn(a);
      case "assess_request": return this.assess(a);
      case "interrupt": {
        const s = this.live.get(a.instance_id);
        if (!s) { this.sup(a.line, { action: "supervisor.interrupt", status: "skipped", detail: { instance: a.instance_id, cause: a.cause } }); return; }
        await this.interruptSession(s, a.cause, a.signal);
        return;
      }
      case "relaunch": return this.relaunch(a);
      case "block": return this.blockLine(a.line, a.signal.kind, a.signal).then(() => undefined);
      case "system_kill": return this.killAll(a.scope, this.mustMachine(a.line).state.phase, a.cause, a.signal, a.scope === "global");
    }
  }

  private sigDetail(signal: Signal, cause: string): Record<string, string | number | undefined> {
    return { signal: signal.kind, value: signal.value, threshold: signal.threshold, cause };
  }

  private warn(a: Extract<SupervisorAction, { type: "warn" }>): void {
    const ag = this.aggregator.agent(a.instance_id);
    if (!ag) return;
    if (ag.warn_since_ms === null) { ag.warn_since_ms = this.d.clock.now(); this.warned.set(a.instance_id, new Set()); }
    const seen = this.warned.get(a.instance_id) ?? new Set<string>();
    this.warned.set(a.instance_id, seen);
    if (seen.has(a.signal.kind)) return;
    seen.add(a.signal.kind);
    this.sup(a.line, { action: "supervisor.warn", status: "ok", detail: { ...this.sigDetail(a.signal, a.cause), instance: a.instance_id, target_role: a.role } });
  }

  private async assess(a: Extract<SupervisorAction, { type: "assess_request" }>): Promise<void> {
    if ((this.verdicts.get(a.line) ?? []).some((v) => v.instance_id === a.instance_id)) return;
    let verdict: AssessVerdict;
    try { verdict = await this.d.depanneur.assess(this.aggregator.logFor(a.line, a.signal)); } catch (err) {
      this.sup(a.line, { action: "supervisor.assess", status: "error", detail: { ...this.sigDetail(a.signal, a.cause), instance: a.instance_id, error: (err as Error).message } });
      return;
    }
    const list = this.verdicts.get(a.line) ?? [];
    list.push({ ...verdict, instance_id: a.instance_id, received_at_ms: this.d.clock.now() });
    this.verdicts.set(a.line, list);
    this.sup(a.line, { action: "supervisor.assess", status: "ok", detail: { ...this.sigDetail(a.signal, a.cause), instance: a.instance_id, verdict: verdict.verdict, cause: verdict.cause } });
  }

  /** Niveau 3 : arrêt de l'agent, snapshot du contexte et du worktree (conservé), compteur d'interruptions. */
  private async interruptSession(s: AgentSession, cause: string, signal: Signal): Promise<void> {
    const line = s.spec.line;
    const m = this.mustMachine(line);
    await this.stopSession(s);
    const ref = await this.d.worktrees.snapshot(s.worktree, "interrupt");
    m.state.interruptions++;
    if (signal.kind.startsWith("loop_") && m.state.status === "running") {
      m.markLooping(this.d.clock.now());
      this.sup(line, { action: "loop.detected", status: "looping", detail: this.sigDetail(signal, cause) });
    }
    this.sup(line, { action: "supervisor.interrupt", status: "ok", parent_id: ref, detail: { ...this.sigDetail(signal, cause), instance: s.spec.instance_id, target_role: s.spec.role } });
  }

  /** Niveau 4 : relance AVEC changement (jamais à l'identique). */
  async relaunch(a: Relaunch): Promise<void> {
    const m = this.mustMachine(a.line);
    const prev = this.specs.get(a.instance_id);
    if (!prev) { this.sup(a.line, { action: "supervisor.restart", status: "skipped", detail: { instance: a.instance_id, cause: "instance inconnue" } }); return; }
    const count = m.state.relaunches_by_agent[a.role] ?? 0;
    if (count >= this.d.config.relaunch.max_per_agent_and_line) { await this.blockLine(a.line, "relaunch_exhausted", { kind: "relaunch_exhausted" }); return; }
    const old = this.live.get(a.instance_id);
    if (old) await this.stopSession(old);

    let role: Agent = prev.spec.role;
    let model: ModelId = prev.spec.model;
    let prompt = this.d.adjustPrompt ? this.d.adjustPrompt(prev.spec.prompt, a.change) : `${prev.spec.prompt}\n[relance: ${a.change.kind}]`;
    if (a.change.kind === "upgrade_model") {
      const up = this.upgrade(a.line, prev.spec.model, "supervisor");
      if (!up) { await this.blockLine(a.line, "model_exhausted", { kind: "relaunch_exhausted" }); return; }
      model = up;
    } else if (a.change.kind === "respec") {
      role = "specifieur";
      model = modelFor(this.d.models, "specifieur", m.state.sensitive_path);
      if (m.state.status === "looping") m.resume();
      m.respec(this.d.clock.now());
    }
    if (m.state.status === "looping") m.resume();
    m.state.relaunches_by_agent[a.role] = count + 1;
    this.sup(a.line, { action: "supervisor.restart", status: "retry", detail: { ...this.sigDetail(a.signal, a.cause), instance: a.instance_id, change: a.change.kind, session_model: model } });
    await this.startAgent({ ...prev.req, role, model, prompt, writing: true, parent_instance_id: a.instance_id });
  }
}
