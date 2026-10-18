/**
 * Superviseur pur (L9.1) : échelle §4.8 (signaler, évaluer, interrompre, relancer, escalader), boucle §4.4,
 * kill automatique §4.5, ADR-006. Aucune I/O, aucune horloge (now_ms fourni), aucun hasard, entrée non mutée.
 * Une seule marche de l'échelle par agent et par tick (la plus haute atteinte).
 */
import type { AgentState, RelaunchChange, Signal, SupervisorAction, SupervisorInput } from "../types";
import { MS_PER_MIN, agentLoopSignal, lastProgressMs, lineLoopSignal, muteSignal, phaseKillSignal, warnSignal } from "./signals";

type Out = SupervisorAction[];

export function decide(input: SupervisorInput): SupervisorAction[] {
  const { config: cfg, line, agents, phase, now_ms: now } = input;
  const lineId = line.line;

  // 1. Kill-switch fichier : prioritaire sur tout, aucune relance (§4.5).
  if (input.kill_switch_active) {
    return [{ type: "system_kill", scope: "global", line: lineId, cause: "factory/KILL présent", signal: { kind: "kill_switch_file" } }];
  }
  // 2. Kill automatique de phase (§4.5, §4.8 : > 3 interruptions/h = problème systémique).
  const killSig = phaseKillSignal(cfg, phase);
  if (killSig) {
    return [{ type: "system_kill", scope: "phase", line: lineId, cause: `Arrêt automatique de la phase : ${killSig.kind}`, signal: killSig }];
  }
  // 3. Ligne déjà terminale : rien à superviser.
  if (line.status === "blocked" || line.status === "killed" || line.status === "done") return [];

  const out: Out = [];
  let blockSignal: Signal | null = null;
  const lineLoop = lineLoopSignal(cfg, line, phase);
  const loopTarget = agents.find((a) => a.role === "implementeur") ?? agents[0];
  const wallClockExceeded = (now - line.started_at_ms) / MS_PER_MIN > cfg.retries.max_wall_clock_min;

  /** Niveaux 3 à 5 pour un agent : interrompre, puis relancer avec changement ou escalader. */
  const interruptPath = (a: AgentState, signal: Signal, cause: string, opts: { forceBlock?: Signal }) => {
    const base = { line: lineId, instance_id: a.instance_id, role: a.role };
    out.push({ type: "interrupt", cause, signal, ...base });
    if (opts.forceBlock) { blockSignal ??= opts.forceBlock; return; }
    const relaunches = line.relaunches_by_agent[a.role] ?? 0;
    if (line.interruptions + 1 >= cfg.relaunch.block_at_interruption) {
      blockSignal ??= { kind: "second_interruption", value: line.interruptions + 1, threshold: cfg.relaunch.block_at_interruption };
      return;
    }
    if (relaunches >= cfg.relaunch.max_per_agent_and_line) {
      blockSignal ??= { kind: "relaunch_exhausted", value: relaunches, threshold: cfg.relaunch.max_per_agent_and_line };
      return;
    }
    const loopActive = lineLoop !== null || agentLoopSignal(cfg, a) !== null;
    // §4.4 : boucle = modèle supérieur (une montée vers F par ligne) ou re-spécification ; sinon §4.8 : contexte réduit d'abord.
    const change: RelaunchChange = !loopActive ? { kind: "reduce_context" }
      : line.f_escalations < cfg.relaunch.max_f_escalations_per_line ? { kind: "upgrade_model" } : { kind: "respec" };
    out.push({ type: "relaunch", change, cause: `Relance avec changement (${change.kind})`, signal, ...base });
  };

  for (const a of agents) {
    const base = { line: lineId, instance_id: a.instance_id, role: a.role };
    const verdict = input.verdicts.find((v) => v.instance_id === a.instance_id);

    // Niveau 3 : verdict du Dépanneur.
    if (verdict) {
      if (verdict.verdict === "continue") continue;
      const sig: Signal = { kind: "assess_verdict" };
      const cause = `Verdict du Dépanneur : ${verdict.verdict}`;
      if (verdict.verdict === "escalate") interruptPath(a, sig, cause, { forceBlock: sig });
      else interruptPath(a, sig, cause, {});
      continue;
    }
    // Niveau 3 : durée murale de la ligne, ou > 45 min sans progrès. Repartir pour 3 h serait vain : pas de relance sur la durée murale.
    if (wallClockExceeded) {
      const sig: Signal = { kind: "wall_clock", value: (now - line.started_at_ms) / MS_PER_MIN, threshold: cfg.retries.max_wall_clock_min };
      interruptPath(a, sig, "Durée murale de la ligne dépassée", { forceBlock: sig });
      continue;
    }
    const noProgress = (now - lastProgressMs(line, a)) / MS_PER_MIN;
    if (noProgress > cfg.interrupt.no_progress_min) {
      interruptPath(a, { kind: "no_progress", value: noProgress, threshold: cfg.interrupt.no_progress_min }, "Aucun progrès mesurable", {});
      continue;
    }
    // Niveau 2 : évaluer (boucle §4.4, agent muet, signal de niveau 1 persistant).
    const warn = warnSignal(cfg, now, line, a);
    const loop = agentLoopSignal(cfg, a) ?? (a === loopTarget ? lineLoop : null);
    const persisted = warn !== null && a.warn_since_ms !== null && now - a.warn_since_ms >= cfg.assess.persistence_min * MS_PER_MIN;
    const assessSig = loop ?? muteSignal(cfg, now, a)
      ?? (persisted ? { kind: "warn_persisted", value: (now - a.warn_since_ms!) / MS_PER_MIN, threshold: cfg.assess.persistence_min } as Signal : null);
    if (assessSig) {
      out.push({ type: "assess_request", cause: `Évaluation demandée : ${assessSig.kind}`, signal: assessSig, ...base });
      continue;
    }
    // Niveau 1 : signaler une seule fois (warn_since_ms posé par le noyau tant que le signal dure).
    if (warn && a.warn_since_ms === null) out.push({ type: "warn", cause: `Signal : ${warn.kind}`, signal: warn, ...base });
  }

  if (blockSignal) out.push({ type: "block", line: lineId, cause: `Ligne bloquée : ${(blockSignal as Signal).kind}`, signal: blockSignal });
  return out;
}
