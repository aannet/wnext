import { loadSupervisionConfig } from "../../src/config";
import type { AgentState, DiffRecord, LineState, PhaseSignals, ReceivedVerdict, SupervisorInput } from "../../src/types";

export const MIN = 60_000;
export const NOW = 1_800_000_000_000;
export const config = loadSupervisionConfig();

export function diff(hash: string, over: Partial<DiffRecord> = {}): DiffRecord {
  return { hash, at_ms: NOW - MIN, similarity_to_previous: 0.1, file_hashes: {}, lines_changed: 10, ...over };
}

export function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    instance_id: "impl-1", line: "P1-017", role: "implementeur", model: "claude-sonnet-x",
    started_at_ms: NOW - 10 * MIN, last_event: null, last_event_at_ms: NOW - 10_000,
    tool_calls_since_commit: 0, last_commit_at_ms: NOW - MIN, last_state_change_at_ms: NOW - MIN,
    identical_llm_call_streak: 1, warn_since_ms: null, pid: 100, pgid: 100, ...over,
  };
}

export function line(over: Partial<LineState> = {}): LineState {
  return {
    line: "P1-017", phase: "P1", run_id: "run-1", status: "running", step: "impl",
    cycles: { total: 1, by_model: {} }, review_returns: 0,
    tokens: { used: 1000, budget: 100_000, used_at_last_green_gain: 1000 },
    started_at_ms: NOW - 20 * MIN, last_commit_at_ms: NOW - MIN, last_step_change_at_ms: NOW - MIN,
    green_tests: 3, recent_diffs: [], recent_ci_errors: [], interruptions: 0,
    relaunches_by_agent: {}, f_escalations: 0, sensitive_path: false, ...over,
  };
}

export function phase(over: Partial<PhaseSignals> = {}): PhaseSignals {
  return {
    phase: "P1", median_tokens_per_changed_line: null, interruptions_last_hour: 0, looping_lines_last_hour: 0,
    ci_failures_in_window: 0, ci_runs_in_window: 0, tokens_used: 1000, tokens_budget: 1_000_000,
    cost_last_hour_usd: 0, permission_violation: false, ...over,
  };
}

export interface Over {
  line?: Partial<LineState>; agent?: Partial<AgentState> | null; agents?: AgentState[];
  phase?: Partial<PhaseSignals>; kill?: boolean; verdicts?: ReceivedVerdict[]; now?: number;
  config?: SupervisorInput["config"];
}

export function mk(o: Over = {}): SupervisorInput {
  return {
    now_ms: o.now ?? NOW, config: o.config ?? config, line: line(o.line),
    agents: o.agents ?? (o.agent === null ? [] : [agent(o.agent)]),
    phase: phase(o.phase), kill_switch_active: o.kill ?? false, verdicts: o.verdicts ?? [],
  };
}

/** Agent sans aucun progrès depuis `ms` (commit, état, étape, démarrage). */
export function idle(ms: number): Over {
  const t = NOW - ms;
  return {
    agent: { started_at_ms: t, last_commit_at_ms: t, last_state_change_at_ms: t },
    line: { started_at_ms: t, last_commit_at_ms: t, last_step_change_at_ms: t },
  };
}

export function verdict(v: ReceivedVerdict["verdict"]): ReceivedVerdict {
  return { verdict: v, cause: "c", instance_id: "impl-1", received_at_ms: NOW - 1000 };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
