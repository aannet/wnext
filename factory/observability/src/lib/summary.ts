import type { Store } from "./store";
import { PHASES, type StoredEvent } from "./types";

export type AlertKind = "loop" | "budget_warn" | "budget_over" | "budget_ceiling" | "silent_agent" | "supervisor_warn" | "supervisor_interrupt";
export interface Alert {
  kind: AlertKind;
  severity: "warning" | "serious" | "critical";
  subject: string; // ligne ou phase
  message: string;
}

export interface LineRow {
  line: string; phase: string; run_id: string; last_agent: string; last_action: string; last_status: string; last_ts: string;
  state: "active" | "blocked" | "killed" | "merged";
  events: number; tokens_total: number; cost: number; retries: number; escalations: number; loops: number; max_attempt: number;
  muted: boolean; idle_s: number;
}
export interface CostRow { events: number; tokens_in: number; tokens_out: number; tokens_total: number; cost: number }

export interface Summary {
  generated_at: string;
  last_id: number;
  totals: { events: number; tokens: number; cost: number };
  counters: { events_received_total: number; events_invalid_total: number; events_duplicate_total: number; invalid_rate: number };
  recent_invalid: { received_at: string; reason: string }[];
  by_agent: (CostRow & { agent: string })[];
  by_line: (CostRow & { line: string; phase: string })[];
  by_phase: (CostRow & { phase: string })[];
  by_model: (CostRow & { model: string })[];
  phases: {
    phase: string; budget_tokens: number; ceiling_tokens: number; consumed_tokens: number; cost: number;
    pct_budget: number; pct_ceiling: number; alert_level: string;
    models: { model: string; tokens_total: number; cost: number }[];
  }[];
  lines: LineRow[];
  line_counts: { active: number; blocked: number; killed: number; merged: number; muted: number };
  retries: { total_retries: number; total_escalations: number; total_loops: number; avg_retries_per_line: number };
  alerts: Alert[];
  recent: StoredEvent[];
}

export function buildSummary(store: Store, opts: { now?: Date; muteAfterS?: number; recent?: number } = {}): Summary {
  const now = opts.now ?? new Date();
  const muteAfterS = opts.muteAfterS ?? Number(process.env.OBS_MUTE_AFTER_S ?? 300);
  const q = <T = Record<string, any>>(sql: string) => store.db.prepare(sql).all() as T[];

  const counters = store.counters() as { events_received_total: number; events_invalid_total: number; events_duplicate_total: number };
  const phaseRows = q("SELECT * FROM v_phase_budget ORDER BY phase");
  const pm = q("SELECT * FROM v_cost_by_phase_model ORDER BY phase, tokens_total DESC");
  const phases = phaseRows.map((p) => ({
    phase: p.phase, budget_tokens: p.budget_tokens, ceiling_tokens: p.ceiling_tokens, consumed_tokens: p.consumed_tokens,
    cost: p.cost, pct_budget: p.pct_budget, pct_ceiling: p.pct_ceiling, alert_level: p.alert_level,
    models: pm.filter((m) => m.phase === p.phase).map((m) => ({ model: m.model, tokens_total: m.tokens_total, cost: m.cost })),
  }));

  const lines = q("SELECT * FROM v_line_state ORDER BY last_ts DESC").map((l): LineRow => {
    const idle_s = Math.max(0, Math.round((now.getTime() - Date.parse(l.last_ts)) / 1000));
    return { ...l, idle_s, muted: l.state === "active" && idle_s > muteAfterS } as LineRow;
  });

  const alerts: Alert[] = [];
  for (const l of lines) {
    if (l.state === "merged" || l.state === "killed") {
      if (l.state === "killed" && l.loops > 0) alerts.push({ kind: "loop", severity: "critical", subject: l.line, message: `Ligne ${l.line} : boucle détectée puis arrêtée (kill-switch).` });
      continue;
    }
    if (l.loops > 0) alerts.push({ kind: "loop", severity: "serious", subject: l.line, message: `Ligne ${l.line} : boucle détectée (${l.loops} signal${l.loops > 1 ? "aux" : ""}).` });
    if (l.muted) alerts.push({ kind: "silent_agent", severity: "serious", subject: l.line, message: `Ligne ${l.line} : agent ${l.last_agent} muet depuis ${Math.round(l.idle_s / 60)} min (considéré mort).` });
  }
  // Supervision (ADR-006) : réactions du Superviseur sur les lignes encore ouvertes.
  const open = new Set(lines.filter((l) => l.state === "active" || l.state === "blocked").map((l) => l.line));
  const sup = q<{ line: string; action: string; n: number }>(
    "SELECT line, action, COUNT(*) AS n FROM events WHERE action IN ('supervisor.warn','supervisor.interrupt') GROUP BY line, action");
  for (const s of sup) {
    if (!open.has(s.line)) continue;
    if (s.action === "supervisor.interrupt") alerts.push({ kind: "supervisor_interrupt", severity: "serious", subject: s.line, message: `Ligne ${s.line} : agent interrompu par le Superviseur (${s.n}).` });
    else alerts.push({ kind: "supervisor_warn", severity: "warning", subject: s.line, message: `Ligne ${s.line} : stagnation signalée par le Superviseur (${s.n}).` });
  }
  for (const p of phases) {
    const pct = Math.round(p.pct_budget * 100);
    if (p.alert_level === "ceiling") alerts.push({ kind: "budget_ceiling", severity: "critical", subject: p.phase, message: `Phase ${p.phase} : plafond dur atteint (${pct} % du budget) — arrêt de phase et gate anticipé.` });
    else if (p.alert_level === "over") alerts.push({ kind: "budget_over", severity: "serious", subject: p.phase, message: `Phase ${p.phase} : budget dépassé (${pct} %).` });
    else if (p.alert_level === "warn") alerts.push({ kind: "budget_warn", severity: "warning", subject: p.phase, message: `Phase ${p.phase} : ${pct} % du budget consommé (seuil d'alerte ${Math.round(store.budgets.alert_ratio * 100)} %).` });
  }

  const count = (s: string) => lines.filter((l) => l.state === s).length;
  const totalRetries = lines.reduce((a, l) => a + Number(l.retries), 0);
  const tot = q("SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in+tokens_out+COALESCE(tokens_cache_read,0)+COALESCE(tokens_cache_write,0)),0) AS t, ROUND(COALESCE(SUM(cost),0),6) AS c FROM events")[0];
  const received = counters.events_received_total;

  return {
    generated_at: now.toISOString(),
    last_id: store.lastId(),
    totals: { events: tot.n, tokens: tot.t, cost: tot.c },
    counters: { ...counters, invalid_rate: received ? counters.events_invalid_total / received : 0 },
    recent_invalid: store.recentInvalid(),
    by_agent: q<Summary["by_agent"][number]>("SELECT * FROM v_cost_by_agent ORDER BY tokens_total DESC"),
    by_line: q<Summary["by_line"][number]>("SELECT * FROM v_cost_by_line ORDER BY line"),
    by_phase: q<Summary["by_phase"][number]>("SELECT * FROM v_cost_by_phase ORDER BY phase"),
    by_model: q<Summary["by_model"][number]>("SELECT * FROM v_cost_by_model ORDER BY tokens_total DESC"),
    phases,
    lines,
    line_counts: { active: count("active"), blocked: count("blocked"), killed: count("killed"), merged: count("merged"), muted: lines.filter((l) => l.muted).length },
    retries: {
      total_retries: totalRetries,
      total_escalations: lines.reduce((a, l) => a + Number(l.escalations), 0),
      total_loops: lines.reduce((a, l) => a + Number(l.loops), 0),
      avg_retries_per_line: lines.length ? Math.round((totalRetries / lines.length) * 100) / 100 : 0,
    },
    alerts,
    recent: store.recent(opts.recent ?? 100),
  };
}

export { PHASES };
