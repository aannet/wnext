/**
 * Détecteurs de signaux du Superviseur : fonctions pures, sans état (strategy.md §4.4, §4.5, §4.8).
 * Convention des seuils : `*_max` et les seuils énoncés « > N » par la stratégie sont STRICTS ; les seuils de
 * persistance/silence (« 10 min », « 5 min ») et « 2 appels identiques d'affilée » sont atteints à >=.
 */
import type { AgentState, LineState, PhaseSignals, Signal, SupervisorConfig } from "../types";

export const MS_PER_MIN = 60_000;

/**
 * Dernier progrès mesurable (§4.8) : commit, changement d'étape, changement d'état de l'agent, ou démarrage de
 * l'instance (une relance repart de zéro). Jamais le temps seul ni les tokens.
 * Limite connue : la hausse des tests verts n'a pas d'horodatage dans LineState.
 */
export function lastProgressMs(line: LineState, agent: AgentState): number {
  return Math.max(
    agent.started_at_ms, agent.last_state_change_at_ms, agent.last_commit_at_ms ?? 0,
    line.last_commit_at_ms ?? 0, line.last_step_change_at_ms,
  );
}

/** Niveau 1 (§4.8) : premier signal actif, ou null. */
export function warnSignal(cfg: SupervisorConfig, now: number, line: LineState, agent: AgentState): Signal | null {
  const idle = (now - lastProgressMs(line, agent)) / MS_PER_MIN;
  if (idle > cfg.warn.idle_without_commit_min) return { kind: "idle_without_commit", value: idle, threshold: cfg.warn.idle_without_commit_min };
  if (agent.tool_calls_since_commit > cfg.warn.tool_calls_without_commit)
    return { kind: "tool_calls_without_commit", value: agent.tool_calls_since_commit, threshold: cfg.warn.tool_calls_without_commit };
  if (agent.identical_llm_call_streak >= cfg.warn.identical_llm_calls)
    return { kind: "identical_llm_calls", value: agent.identical_llm_call_streak, threshold: cfg.warn.identical_llm_calls };
  return null;
}

/** Agent muet : aucun événement depuis `mute_agent_min` (depuis le démarrage si aucun événement). */
export function muteSignal(cfg: SupervisorConfig, now: number, agent: AgentState): Signal | null {
  const silent = (now - (agent.last_event_at_ms ?? agent.started_at_ms)) / MS_PER_MIN;
  return silent >= cfg.assess.mute_agent_min ? { kind: "mute_agent", value: silent, threshold: cfg.assess.mute_agent_min } : null;
}

/** Signaux de boucle §4.4 portés par la ligne (diffs, erreurs CI, budget). */
export function lineLoopSignal(cfg: SupervisorConfig, line: LineState, phase: PhaseSignals): Signal | null {
  const l = cfg.loop;
  const diffs = line.recent_diffs;

  const n = l.diff_repeat_consecutive;
  if (n >= 2 && diffs.length >= n) {
    const last = diffs.slice(-n);
    const repeated = last.every((d, i) => i === 0 || d.hash === last[i - 1]!.hash || (d.similarity_to_previous ?? 0) > l.diff_similarity);
    if (repeated) return { kind: "loop_diff_repeat", value: n, threshold: n };
  }

  const k = l.error_signature_repeats;
  const errs = line.recent_ci_errors;
  if (k >= 1 && errs.length >= k) {
    const last = errs.slice(-k);
    if (last.every((e) => e.signature === last[0]!.signature)) return { kind: "loop_error_signature", value: k, threshold: k };
  }

  if (l.oscillation_enabled && diffs.length >= 3) {
    const files = new Set(diffs.flatMap((d) => Object.keys(d.file_hashes)));
    for (const f of [...files].sort()) {
      const seq = diffs.flatMap((d) => (f in d.file_hashes ? [d.file_hashes[f]!] : []));
      if (seq.length >= 3) {
        const [a, b, c] = seq.slice(-3) as [string, string, string];
        if (a === c && a !== b) return { kind: "loop_oscillation" };
      }
    }
  }

  const changed = diffs.reduce((s, d) => s + d.lines_changed, 0);
  const median = phase.median_tokens_per_changed_line;
  if (median !== null && median > 0 && changed > 0) {
    const ratio = line.tokens.used / changed / median;
    if (ratio > l.tokens_per_changed_line_ratio) return { kind: "loop_token_ratio", value: ratio, threshold: l.tokens_per_changed_line_ratio };
  }

  const { used, budget, used_at_last_green_gain } = line.tokens;
  if (budget > 0) {
    const frac = (used - used_at_last_green_gain) / budget;
    if (frac > l.budget_fraction_without_green_gain) return { kind: "loop_budget_no_progress", value: frac, threshold: l.budget_fraction_without_green_gain };
  }
  return null;
}

/** Signal de boucle propre à l'agent : > 40 appels d'outils sans commit. */
export function agentLoopSignal(cfg: SupervisorConfig, agent: AgentState): Signal | null {
  return agent.tool_calls_since_commit > cfg.loop.tool_calls_without_commit
    ? { kind: "loop_tool_calls", value: agent.tool_calls_since_commit, threshold: cfg.loop.tool_calls_without_commit }
    : null;
}

/** Arrêts automatiques de phase §4.5 (hors kill-switch fichier), par ordre de gravité. */
export function phaseKillSignal(cfg: SupervisorConfig, p: PhaseSignals): Signal | null {
  const k = cfg.kill;
  if (p.permission_violation) return { kind: "permission_violation" };
  const ceiling = p.tokens_budget * k.phase_budget_ceiling_factor;
  if (p.tokens_budget > 0 && p.tokens_used >= ceiling) return { kind: "phase_budget_ceiling", value: p.tokens_used, threshold: ceiling };
  if (p.interruptions_last_hour > k.interruptions_per_hour_max)
    return { kind: "interruptions_per_hour", value: p.interruptions_last_hour, threshold: k.interruptions_per_hour_max };
  if (p.looping_lines_last_hour > k.looping_lines_per_hour_max)
    return { kind: "looping_lines_per_hour", value: p.looping_lines_last_hour, threshold: k.looping_lines_per_hour_max };
  // Fenêtre incomplète (< N lignes) : taux non significatif, pas de kill.
  if (p.ci_runs_in_window >= k.ci_failure_window_lines && p.ci_runs_in_window > 0) {
    const rate = p.ci_failures_in_window / p.ci_runs_in_window;
    if (rate > k.ci_failure_rate_max) return { kind: "ci_failure_rate", value: rate, threshold: k.ci_failure_rate_max };
  }
  if (k.cost_per_hour_usd_max !== null && p.cost_last_hour_usd > k.cost_per_hour_usd_max)
    return { kind: "cost_per_hour", value: p.cost_last_hour_usd, threshold: k.cost_per_hour_usd_max };
  return null;
}
