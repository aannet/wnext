/**
 * Constructeurs de fixtures pour les rôles L9.4 (Dépanneur, Introspecteur). Aucune logique métier ici.
 */
import type { LineLog } from "../../src/ports";
import type { CiErrorSignature, DiffRecord, FactoryEvent, LineState, Signal, SignalKind } from "../../src/types";

export const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
export const MIN = 60_000;

/** Événement à la minute `min` après T0. */
export function ev(min: number, over: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: new Date(T0 + min * MIN).toISOString(), run_id: "run-1", line: "P1-017", phase: "P1",
    agent: "implementeur", model: "claude-haiku-5-5", action: "llm.call", tokens_in: 100, tokens_out: 50,
    cost: 0, duration_ms: 500, status: "ok", ...over,
  };
}

export function diff(hash: string, over: Partial<DiffRecord> = {}): DiffRecord {
  return { hash, at_ms: T0, similarity_to_previous: 0.1, file_hashes: {}, lines_changed: 10, ...over };
}

export function ciErr(signature: string, min = 0): CiErrorSignature {
  return { signature, at_ms: T0 + min * MIN };
}

export function lineState(over: Partial<LineState> = {}): LineState {
  return {
    line: "P1-017", phase: "P1", run_id: "run-1", status: "running", step: "impl",
    cycles: { total: 1, by_model: { "claude-haiku-5-5": 1 } }, review_returns: 0,
    tokens: { used: 1000, budget: 100_000, used_at_last_green_gain: 0 },
    started_at_ms: T0, last_commit_at_ms: null, last_step_change_at_ms: T0, green_tests: 0,
    recent_diffs: [], recent_ci_errors: [], interruptions: 0, relaunches_by_agent: {},
    f_escalations: 0, sensitive_path: false, ...over,
  };
}

export function signal(kind: SignalKind, over: Partial<Signal> = {}): Signal {
  return { kind, ...over };
}

export function logOf(
  events: FactoryEvent[],
  opts: { trigger?: SignalKind; state?: Partial<LineState>; line?: string } = {},
): LineLog {
  const line = opts.line ?? "P1-017";
  return {
    line, run_id: "run-1", state: lineState({ line, ...opts.state }), events,
    trigger: signal(opts.trigger ?? "warn_persisted"),
  };
}
