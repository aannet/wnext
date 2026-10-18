/**
 * Agrégation du flux d'événements §5 vers les entrées du Superviseur (SupervisorInput) : une seule source de vérité.
 * Pas d'horloge : `now` est fourni à chaque appel. Conventions de `detail` lues ici (émises par L9.3 / le Core) :
 *   llm.call    : prompt_hash (série d'appels quasi identiques)
 *   git.commit  : diff_hash, diff_simhash?, lines_changed, "file_hash:<chemin>"
 *   ci.result   : status ok|error, tests_green, error_signature (test + message normalisé)
 *   tool.exec   : (compté seulement)
 *   kill.triggered émis PAR un agent = violation de permission ; supervisor.interrupt / loop.detected émis par le Core.
 */
import type { BudgetMeter, LineLog } from "../ports";
import type {
  Agent, AgentState, DiffRecord, FactoryEvent, LineId, ModelId, Phase, PhaseSignals, ReceivedVerdict, SupervisorConfig, SupervisorInput,
} from "../types";
import { simhashSimilarity } from "./fingerprint";
import type { LineMachine } from "./line-machine";

const HOUR = 3_600_000;
const MAX_DIFFS = 5;
const MAX_CI_ERRORS = 10;
const MAX_LINE_EVENTS = 5000;
/** Actions qui comptent comme « changement d'état » d'un agent (§4.8 niveau 1). */
const STATE_CHANGE = new Set(["ci.result", "review.verdict", "git.commit", "retry.start", "pipeline.step", "escalate.model"]);

export interface AgentInfo { instance_id: string; line: LineId; role: Agent; model: ModelId; pid: number | null; pgid: number | null }

interface PhaseWindows {
  interruptions: number[];
  looping: Map<LineId, number>;
  ci: boolean[]; // true = échec, N derniers
  cost: { at: number; usd: number }[];
  permission_violation: boolean;
}

export class EventAggregator {
  private lines = new Map<LineId, LineMachine>();
  private agents = new Map<string, AgentState>();
  private lastPrompt = new Map<string, string>();
  private lastSimhash = new Map<LineId, string>();
  private linesChanged = new Map<LineId, number>();
  private journals = new Map<LineId, FactoryEvent[]>();
  private phases = new Map<Phase, PhaseWindows>();

  constructor(private readonly deps: { budget: BudgetMeter; config: SupervisorConfig }) {}

  registerLine(m: LineMachine): void { this.lines.set(m.state.line, m); }

  agentStarted(a: AgentInfo, now: number): AgentState {
    const st: AgentState = {
      instance_id: a.instance_id, line: a.line, role: a.role, model: a.model, started_at_ms: now,
      last_event: null, last_event_at_ms: null, tool_calls_since_commit: 0,
      last_commit_at_ms: this.lines.get(a.line)?.state.last_commit_at_ms ?? null,
      last_state_change_at_ms: now, identical_llm_call_streak: 0, warn_since_ms: null, pid: a.pid, pgid: a.pgid,
    };
    this.agents.set(a.instance_id, st);
    return st;
  }
  agentEnded(instance_id: string): void { this.agents.delete(instance_id); this.lastPrompt.delete(instance_id); }
  agent(instance_id: string): AgentState | undefined { return this.agents.get(instance_id); }
  eventsOf(line: LineId): readonly FactoryEvent[] { return this.journals.get(line) ?? []; }

  private win(p: Phase): PhaseWindows {
    let w = this.phases.get(p);
    if (!w) this.phases.set(p, (w = { interruptions: [], looping: new Map(), ci: [], cost: [], permission_violation: false }));
    return w;
  }

  /** Ingère un événement (agent ou Core). */
  observe(e: FactoryEvent, now: number): void {
    const j = this.journals.get(e.line) ?? [];
    j.push(e); if (j.length > MAX_LINE_EVENTS) j.shift();
    this.journals.set(e.line, j);

    const w = this.win(e.phase);
    if (e.cost > 0) w.cost.push({ at: now, usd: e.cost });
    const m = this.lines.get(e.line);
    const ag = e.instance_id ? this.agents.get(e.instance_id) : undefined;
    if (ag) { ag.last_event = e; ag.last_event_at_ms = now; if (STATE_CHANGE.has(e.action)) ag.last_state_change_at_ms = now; }

    switch (e.action) {
      case "tool.exec":
        if (ag) ag.tool_calls_since_commit++;
        break;
      case "llm.call":
        if (ag) {
          const h = e.detail?.prompt_hash;
          const hash = typeof h === "string" ? h : null;
          const prev = this.lastPrompt.get(ag.instance_id);
          ag.identical_llm_call_streak = hash !== null && hash === prev ? ag.identical_llm_call_streak + 1 : 1;
          if (hash !== null) this.lastPrompt.set(ag.instance_id, hash); else this.lastPrompt.delete(ag.instance_id);
        }
        break;
      case "git.commit":
        if (m) this.onCommit(m, e, now);
        break;
      case "ci.result": {
        const failed = e.status !== "ok";
        w.ci.push(failed);
        const n = this.deps.config.kill.ci_failure_window_lines;
        while (w.ci.length > Math.max(n, 1)) w.ci.shift();
        if (m) {
          const sig = e.detail?.error_signature;
          if (failed && typeof sig === "string") { m.state.recent_ci_errors.push({ signature: sig, at_ms: now }); while (m.state.recent_ci_errors.length > MAX_CI_ERRORS) m.state.recent_ci_errors.shift(); }
          const g = e.detail?.tests_green;
          if (typeof g === "number" && g > m.state.green_tests) { m.state.green_tests = g; m.state.tokens.used_at_last_green_gain = this.deps.budget.line(m.state.line).used; }
        }
        break;
      }
      case "supervisor.interrupt": w.interruptions.push(now); break;
      case "loop.detected": w.looping.set(e.line, now); break;
      case "kill.triggered": if (e.agent !== "superviseur" && e.agent !== "orchestrateur") w.permission_violation = true; break;
      default: break;
    }
  }

  private onCommit(m: LineMachine, e: FactoryEvent, now: number): void {
    const d = e.detail ?? {};
    const hash = typeof d.diff_hash === "string" ? d.diff_hash : `${e.ts}`;
    const sim = typeof d.diff_simhash === "string" ? d.diff_simhash : null;
    const prev = m.state.recent_diffs.at(-1);
    let similarity: number | null = null;
    if (prev) {
      const prevSim = this.lastSimhash.get(m.state.line);
      similarity = prev.hash === hash ? 1 : sim && prevSim ? simhashSimilarity(sim, prevSim) : 0;
    }
    if (sim) this.lastSimhash.set(m.state.line, sim); else this.lastSimhash.delete(m.state.line);
    const file_hashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith("file_hash:") && typeof v === "string") file_hashes[k.slice("file_hash:".length)] = v;
    const lines_changed = typeof d.lines_changed === "number" ? d.lines_changed : 0;
    const rec: DiffRecord = { hash, at_ms: now, similarity_to_previous: similarity, file_hashes, lines_changed };
    m.state.recent_diffs.push(rec);
    while (m.state.recent_diffs.length > MAX_DIFFS) m.state.recent_diffs.shift();
    this.linesChanged.set(m.state.line, (this.linesChanged.get(m.state.line) ?? 0) + lines_changed);
    m.state.last_commit_at_ms = now;
    for (const a of this.agents.values()) {
      if (a.line !== m.state.line) continue;
      a.tool_calls_since_commit = 0; a.last_commit_at_ms = now; a.last_state_change_at_ms = now; a.warn_since_ms = null;
    }
  }

  private phaseSignals(phase: Phase, now: number): PhaseSignals {
    const w = this.win(phase);
    w.interruptions = w.interruptions.filter((t) => now - t < HOUR);
    w.cost = w.cost.filter((c) => now - c.at < HOUR);
    for (const [l, t] of [...w.looping]) if (now - t >= HOUR) w.looping.delete(l);
    const ratios: number[] = [];
    for (const m of this.lines.values()) {
      if (m.state.phase !== phase || m.state.status !== "done") continue;
      const changed = this.linesChanged.get(m.state.line) ?? 0;
      if (changed > 0) ratios.push(this.deps.budget.line(m.state.line).used / changed);
    }
    ratios.sort((a, b) => a - b);
    const mid = ratios.length >> 1;
    const median = ratios.length === 0 ? null : ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
    const pb = this.deps.budget.phase(phase);
    return {
      phase, median_tokens_per_changed_line: median,
      interruptions_last_hour: w.interruptions.length, looping_lines_last_hour: w.looping.size,
      ci_failures_in_window: w.ci.filter(Boolean).length, ci_runs_in_window: w.ci.length,
      tokens_used: pb.used, tokens_budget: pb.budget,
      cost_last_hour_usd: w.cost.reduce((s, c) => s + c.usd, 0), permission_violation: w.permission_violation,
    };
  }

  /** Entrée du Superviseur pour une ligne, à l'instant `now`. Rafraîchit les tokens de la ligne depuis le BudgetMeter. */
  buildInput(line: LineId, ctx: { now: number; verdicts: ReceivedVerdict[]; killActive: boolean }): SupervisorInput {
    const m = this.lines.get(line);
    if (!m) throw new Error(`ligne inconnue : ${line}`);
    const lb = this.deps.budget.line(line);
    m.state.tokens.used = lb.used;
    if (lb.budget > 0) m.state.tokens.budget = lb.budget;
    return {
      now_ms: ctx.now, config: this.deps.config, line: m.state,
      agents: [...this.agents.values()].filter((a) => a.line === line),
      phase: this.phaseSignals(m.state.phase, ctx.now), kill_switch_active: ctx.killActive, verdicts: ctx.verdicts,
    };
  }

  logFor(line: LineId, trigger: LineLog["trigger"]): LineLog {
    const m = this.lines.get(line)!;
    return { line, run_id: m.state.run_id, state: structuredClone(m.state), events: [...this.eventsOf(line)], trigger };
  }
}
