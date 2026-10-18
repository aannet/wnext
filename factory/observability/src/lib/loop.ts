import type { Call } from "./flow";

/** Étapes de la boucle de production d'une ligne (strategy.md §4.1) : l'agent qui tient chaque étape. */
export const LOOP_STEPS = [
  { id: "spec", label: "Spec", agent: "specifieur" },
  { id: "tests", label: "Tests", agent: "testeur" },
  { id: "impl", label: "Implémentation", agent: "implementeur" },
  { id: "ci", label: "CI + garde-fous", agent: "sentinelle" },
  { id: "review", label: "Review", agent: "reviseur" },
  { id: "merge", label: "Merge", agent: "integrateur" },
] as const;

export type StepState = "pending" | "running" | "done" | "failed" | "blocked";

export interface LoopStep {
  id: string; label: string; agent: string;
  state: StepState;
  calls: number; attempts: number; tokens: number;
  /** Modèle dominant (tokens) ; null si l'étape n'a pas commencé. */
  model: string | null;
  last_action: string | null; last_status: string | null;
}
export interface LineLoopView {
  line: string;
  steps: LoopStep[];
  retries: number; escalations: number; loops: number;
  outcome: "merged" | "killed" | "open";
}

const BAD = new Set(["error"]);
const STUCK = new Set(["blocked", "looping"]);

export function buildLineLoop(calls: Call[], line: string): LineLoopView {
  const mine = calls.filter((c) => c.line === line).sort((a, b) => a.id - b.id);
  const merged = mine.some((c) => c.action === "merge.done");
  const killed = !merged && mine.some((c) => c.action.startsWith("kill.") || c.status === "killed");

  const steps: LoopStep[] = LOOP_STEPS.map((def) => {
    const cs = mine.filter((c) => c.agent === def.agent);
    const byModel = new Map<string, number>();
    for (const c of cs) byModel.set(c.model, (byModel.get(c.model) ?? 0) + c.tokens);
    // Le modèle « none » (commit, CI) ne masque pas le modèle LLM de l'étape quand il y en a un.
    const llm = [...byModel.entries()].filter(([m]) => m !== "none").sort((a, b) => b[1] - a[1])[0];
    const last = cs[cs.length - 1];
    return {
      ...def, state: "pending", calls: cs.length,
      attempts: cs.reduce((a, c) => Math.max(a, c.attempt ?? 1), cs.length ? 1 : 0),
      tokens: cs.reduce((a, c) => a + c.tokens, 0),
      model: cs.length ? (llm ? llm[0] : "none") : null,
      last_action: last?.action ?? null, last_status: last?.status ?? null,
    };
  });

  const reached = steps.reduce((a, s, i) => (s.calls ? i : a), -1);
  steps.forEach((s, i) => {
    if (!s.calls) return;
    const st = s.last_status ?? "ok";
    if (STUCK.has(st)) s.state = "blocked";
    else if (st === "killed") s.state = "failed";
    else if (BAD.has(st) && i === reached && !merged) s.state = "failed"; // échec non encore repris par une étape suivante
    else if (i === reached && !merged && !killed) s.state = "running";
    else s.state = "done";
  });
  // Ligne arrêtée (kill-switch / boucle) : l'étape atteinte est en échec si elle n'était pas déjà bloquée.
  if (killed && reached >= 0 && steps[reached].state !== "blocked") steps[reached].state = "failed";

  return {
    line, steps,
    retries: mine.filter((c) => c.action.startsWith("retry.")).length,
    escalations: mine.filter((c) => c.action.startsWith("escalate.")).length,
    loops: mine.filter((c) => c.action === "loop.detected" || c.status === "looping").length,
    outcome: merged ? "merged" : killed ? "killed" : "open",
  };
}

/** Ligne à afficher : celle du filtre, sinon la première ligne tenue par un agent, sinon la plus récente. */
export function pickLoopLine(filterLine: string, heldLines: string[], allLines: string[]): string | null {
  if (filterLine) return filterLine;
  return heldLines[0] ?? allLines[allLines.length - 1] ?? null;
}
