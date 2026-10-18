import type { Summary, Alert, LineRow } from "./summary";
import type { Production } from "./production";
import type { Call } from "./flow";
import { buildLineLoop, LOOP_STEPS } from "./loop";
import { AGENTS, PHASES } from "./types";

/** Vue « projet d'abord » : tout est dérivé de /api/summary et /api/production, aucune donnée nouvelle. */
export type Health = "ok" | "watch" | "blocked";

export const PHASE_LABEL: Record<string, string> = {
  P0: "Fondations", P1: "Données et règles", P2: "API et temps réel", P3: "Schedule UI", P4: "Congés, vues, permissions", P5: "Release MVP",
};

export interface PhaseCard {
  phase: string; label: string; state: "empty" | "open" | "done";
  lines: number; merged: number; open: number; blocked: number;
  budget_pct: number; cost: number; alert_level: string;
}
export interface ProjectLine {
  line: string; phase: string; state: LineRow["state"]; muted: boolean;
  /** Étape atteinte (0..5 dans LOOP_STEPS) et état de cette étape ; -1 si aucun événement de boucle. */
  step_index: number; step_label: string; step_state: string;
  agent: string; model: string | null; attempts: number; cost: number; retries: number; loops: number;
}
export interface Watch { severity: Alert["severity"]; subject: string; message: string }
export interface ProjectView {
  health: Health; health_reason: string;
  current_phase: string | null;
  phases: PhaseCard[];
  lines: ProjectLine[];
  merged_total: number;
  ci_first_pass: { rate: number | null; passed: number; total: number };
  watch: Watch[];
  agents: { running: number; muted: number; blocked: number; idle: number };
}

const SEV_RANK = { critical: 0, serious: 1, warning: 2 } as const;

export function buildProject(sum: Summary, prod: Production): ProjectView {
  const phases: PhaseCard[] = PHASES.map((p) => {
    const ps = prod.phases.find((x) => x.phase === p);
    const sp = sum.phases.find((x) => x.phase === p);
    const ls = sum.lines.filter((l) => l.phase === p);
    return {
      phase: p, label: PHASE_LABEL[p] ?? p, state: ps?.state ?? "empty",
      lines: ls.length, merged: ls.filter((l) => l.state === "merged").length,
      open: ls.filter((l) => l.state === "active" || l.state === "blocked").length,
      blocked: ls.filter((l) => l.state === "blocked" || l.state === "killed").length,
      budget_pct: sp?.pct_budget ?? 0, cost: sp?.cost ?? 0, alert_level: sp?.alert_level ?? "ok",
    };
  });
  const current = phases.find((p) => p.state === "open") ?? [...phases].reverse().find((p) => p.state === "done") ?? null;

  const lines: ProjectLine[] = sum.lines
    .filter((l) => l.state !== "merged" && (!current || l.phase === current.phase))
    .map((l) => {
      const loop = buildLineLoop(prod.calls, l.line);
      let idx = -1;
      loop.steps.forEach((s, i) => { if (s.calls) idx = i; });
      const step = idx >= 0 ? loop.steps[idx] : null;
      return {
        line: l.line, phase: l.phase, state: l.state, muted: l.muted,
        step_index: idx, step_label: step ? LOOP_STEPS[idx].label : "—", step_state: step?.state ?? "pending",
        agent: step?.agent ?? l.last_agent, model: step?.model ?? null, attempts: step?.attempts ?? 0,
        cost: Number(l.cost), retries: Number(l.retries), loops: Number(l.loops),
      };
    });

  // CI au premier passage : première ci.result de chaque ligne.
  const firstCi = new Map<string, Call>();
  for (const c of [...prod.calls].sort((a, b) => a.id - b.id)) if (c.action === "ci.result" && !firstCi.has(c.line)) firstCi.set(c.line, c);
  const passed = [...firstCi.values()].filter((c) => c.status === "ok").length;
  const ci = { rate: firstCi.size ? passed / firstCi.size : null, passed, total: firstCi.size };

  const watch: Watch[] = sum.alerts.map((a) => ({ severity: a.severity, subject: a.subject, message: a.message }));
  for (const l of sum.lines) {
    if (l.state === "blocked" && l.loops === 0 && !l.muted) {
      watch.push({ severity: "serious", subject: l.line, message: `Ligne ${l.line} bloquée en attente (${l.last_action}).` });
    }
  }
  watch.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  // Règle de santé (documentée dans le README) : bloqué si critique ; à surveiller si sérieux/attention ou ligne bloquée/muette.
  const crit = watch.find((w) => w.severity === "critical");
  const other = watch[0];
  const health: Health = crit ? "blocked" : other ? "watch" : "ok";
  const health_reason = crit ? crit.message : other ? other.message : "Aucune alerte, aucune ligne bloquée.";

  const act = { running: prod.counts.running, muted: prod.counts.muted, blocked: prod.counts.blocked };
  return {
    health, health_reason, current_phase: current?.phase ?? null, phases, lines,
    merged_total: sum.line_counts.merged, ci_first_pass: ci, watch,
    agents: { ...act, idle: Math.max(0, AGENTS.length - act.running - act.muted - act.blocked) },
  };
}
