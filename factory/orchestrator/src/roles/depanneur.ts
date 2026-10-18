/**
 * Dépanneur déterministe (L9.4, strategy.md §2, §4.3, §4.8 niveau 2 ; ADR-006). Sans LLM : chaque verdict vient
 * d'une règle nommée (DEP-xx), appliquée dans l'ordre ci-dessous ; la première règle qui s'applique gagne.
 * Lecture seule : `report` écrit uniquement un rapport Markdown dans `reportDir`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSupervisionConfig } from "../config";
import type { Depanneur, LineLog } from "../ports";
import type { AssessVerdict, AssessVerdictKind, FactoryEvent, SignalKind, SupervisorConfig } from "../types";

/** Fenêtre de progrès récent (§4.8 : persistance 10 min, supervision.yaml assess.persistence_min). */
const RECENT_PROGRESS_MIN = 10;
/** Similarité au-delà de laquelle un diff est une répétition (§4.4, supervision.yaml loop.diff_similarity). */
const DIFF_SIMILARITY = 0.9;

const KILL_SIGNALS: readonly SignalKind[] = ["permission_violation", "kill_switch_file", "phase_budget_ceiling"];
const CEILING_SIGNALS: readonly SignalKind[] = ["wall_clock", "line_budget_ceiling"];
const TOOL_LOOP_SIGNALS: readonly SignalKind[] = ["loop_tool_calls", "loop_token_ratio", "loop_budget_no_progress", "identical_llm_calls"];
const DIFF_LOOP_SIGNALS: readonly SignalKind[] = ["loop_diff_repeat", "loop_oscillation"];
const CI_LOOP_SIGNALS: readonly SignalKind[] = ["loop_error_signature"];

export interface DepanneurRule {
  id: "DEP-01" | "DEP-02" | "DEP-03" | "DEP-04" | "DEP-05" | "DEP-06" | "DEP-07" | "DEP-08";
  verdict: AssessVerdictKind;
  /** Effet en clair, repris dans la cause du verdict. */
  effect: string;
}

/** Règles actives, dans l'ordre d'évaluation (la première qui s'applique gagne). */
export const DEPANNEUR_RULES: readonly DepanneurRule[] = [
  { id: "DEP-01", verdict: "stop", effect: "kill.triggered dans le journal, violation de permission, kill-switch ou plafond de phase : arrêt, aucune relance (§4.5)" },
  { id: "DEP-02", verdict: "stop", effect: "durée murale de 3 h ou plafond de budget de ligne atteint : relancer ne sert à rien (§4.3)" },
  { id: "DEP-03", verdict: "escalate", effect: "modèle déjà escaladé (montée d'un agent ou f_escalations) et aucun progrès depuis la montée : escalade (§4.8 niveau 5)" },
  { id: "DEP-04", verdict: "restart", effect: "diff identique (hash) ou similarité > 90 % répété : relance avec changement (§4.4)" },
  { id: "DEP-05", verdict: "restart", effect: "même signature d'erreur CI N fois de suite (loop.error_signature_repeats) : relance avec changement (§4.4)" },
  { id: "DEP-06", verdict: "restart", effect: "boucle d'outils, de tokens ou d'appels modèle identiques : relance avec changement (§4.4)" },
  { id: "DEP-07", verdict: "continue", effect: "progrès (commit, tests verts, review approuvée, merge) moins de 10 min avant la fin du journal, sans boucle : on laisse travailler" },
  { id: "DEP-08", verdict: "restart", effect: "ni progrès récent ni boucle identifiée : repli, une relance avec réduction de contexte (§4.8 niveau 4)" },
];

export interface DepanneurOptions {
  /** Répertoire des rapports de ligne bloquée (écriture confinée à ce répertoire). */
  reportDir: string;
  /** Seuils de supervision.yaml ; par défaut le fichier versionné. */
  config?: SupervisorConfig;
}

/** Progrès au sens §4.8 : commit, tests verts, review approuvée ou merge. Jamais le temps ni les tokens. */
export function isProgress(e: FactoryEvent): boolean {
  if (e.action === "git.commit" || e.action === "merge.done") return true;
  if (e.action === "ci.result" && e.detail?.tests_green === true) return true;
  return e.action === "review.verdict" && e.detail?.verdict === "approve";
}

interface Evidence {
  escalatedAt: number | null;
  lastProgressAt: number | null;
  diffLoop: boolean;
  ciLoop: boolean;
}

/** Index (dans `events`) de la première montée de modèle d'un agent, ou null. */
function escalationIndex(events: readonly FactoryEvent[]): number | null {
  const first = new Map<string, string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.action !== "llm.call") continue;
    const seen = first.get(e.agent);
    if (seen === undefined) first.set(e.agent, e.model);
    else if (seen !== e.model) return i;
  }
  return null;
}

function evidence(log: LineLog, cfg: SupervisorConfig): Evidence {
  const ev = log.events;
  let lastProgressAt: number | null = null;
  for (let i = 0; i < ev.length; i++) if (isProgress(ev[i]!)) lastProgressAt = i;

  const switchAt = escalationIndex(ev);
  const escalatedAt = switchAt ?? (log.state.f_escalations > 0 ? 0 : null);

  const diffs = log.state.recent_diffs;
  const lastDiff = diffs[diffs.length - 1];
  const prevDiff = diffs[diffs.length - 2];
  const similar = lastDiff?.similarity_to_previous != null && lastDiff.similarity_to_previous > DIFF_SIMILARITY;
  const sameHash = lastDiff !== undefined && prevDiff !== undefined && lastDiff.hash === prevDiff.hash;
  const diffLoop = DIFF_LOOP_SIGNALS.includes(log.trigger.kind) || similar || sameHash;

  const errs = log.state.recent_ci_errors;
  const n = cfg.loop.error_signature_repeats;
  const tail = errs.slice(-n);
  const lastSig = tail[tail.length - 1]?.signature;
  const ciLoop = CI_LOOP_SIGNALS.includes(log.trigger.kind) ||
    (tail.length === n && lastSig !== undefined && tail.every((x) => x.signature === lastSig));

  return { escalatedAt, lastProgressAt, diffLoop, ciLoop };
}

/** Verdict et règle appliquée. Fonction pure du journal (aucune horloge : le temps vient des `ts` des événements). */
export function assessLine(log: LineLog, cfg: SupervisorConfig = loadSupervisionConfig()): AssessVerdict & { rule: DepanneurRule["id"] } {
  const ev = log.events;
  const last = ev[ev.length - 1];
  const evd = evidence(log, cfg);
  const kill = ev.some((e) => e.action === "kill.triggered" || e.detail?.permission_violation === true);
  const rule = (id: DepanneurRule["id"], cause: string): AssessVerdict & { rule: DepanneurRule["id"] } => {
    const r = DEPANNEUR_RULES.find((x) => x.id === id);
    if (!r) throw new Error(`règle inconnue ${id}`);
    return { verdict: r.verdict, cause: `${id} : ${cause}`, rule: id };
  };

  if (kill || KILL_SIGNALS.includes(log.trigger.kind)) return rule("DEP-01", "arrêt immédiat, humain requis pour lever le kill-switch.");
  if (CEILING_SIGNALS.includes(log.trigger.kind)) return rule("DEP-02", `plafond atteint (${log.trigger.kind}), relance inutile.`);

  if (evd.escalatedAt !== null && (evd.lastProgressAt === null || evd.lastProgressAt < evd.escalatedAt)) {
    return rule("DEP-03", "modèle déjà escaladé sans progrès depuis la montée ; escalade au prochain gate.");
  }
  if (evd.diffLoop) return rule("DEP-04", "diff identique ou quasi identique répété ; relancer avec contexte réduit au diff + spec.");
  if (evd.ciLoop) return rule("DEP-05", "même signature d'erreur CI répétée ; relancer avec contexte réduit au diff + spec.");
  if (TOOL_LOOP_SIGNALS.includes(log.trigger.kind)) return rule("DEP-06", `boucle détectée (${log.trigger.kind}) ; relancer avec contexte réduit au diff + spec.`);

  if (evd.lastProgressAt !== null && last) {
    const p = ev[evd.lastProgressAt];
    if (p && (Date.parse(last.ts) - Date.parse(p.ts)) / 60_000 <= RECENT_PROGRESS_MIN) {
      return rule("DEP-07", `progrès récent (${p.action}) et aucune boucle ; poursuivre.`);
    }
  }
  return rule("DEP-08", `aucun progrès récent ni boucle identifiée (${log.trigger.kind}) ; relancer une fois avec contexte réduit.`);
}

const RECOMMENDATION: Record<AssessVerdictKind, string> = {
  stop: "Ne pas relancer. Traiter la cause avant toute reprise ; seul un humain lève le kill-switch.",
  escalate: "Escalader : ligne `blocked` au prochain gate ; re-spécification par le Spécifieur si la spec est en cause.",
  restart: "Relancer une fois avec changement : contexte réduit au diff + spec (jamais à l'identique).",
  continue: "Laisser la ligne poursuivre ; réévaluer au prochain signal persistant.",
};

export class DepanneurDeterministe implements Depanneur {
  private readonly cfg: SupervisorConfig;

  constructor(private readonly opts: DepanneurOptions) {
    this.cfg = opts.config ?? loadSupervisionConfig();
  }

  async assess(log: LineLog): Promise<AssessVerdict> {
    const { verdict, cause } = assessLine(log, this.cfg);
    return { verdict, cause };
  }

  async report(log: LineLog): Promise<string> {
    const { verdict, cause } = assessLine(log, this.cfg);
    const errors = errorSignatures(log);
    const byModel = Object.entries(log.state.cycles.by_model).map(([m, c]) => `${m} : ${c}`).join(", ") || "aucun";
    const text = [
      `# Rapport Dépanneur : ${log.line} (ligne bloquée)`,
      "",
      `Run : ${log.run_id} · Phase : ${log.state.phase} · Déclencheur : ${log.trigger.kind}`,
      "",
      "## Cause",
      cause,
      "",
      "## Dernières erreurs CI",
      ...(errors.length ? errors.map((s) => `- \`${s}\``) : ["- Aucune erreur CI enregistrée."]),
      "",
      "## Tokens et cycles",
      `- Tokens : ${log.state.tokens.used} consommés sur ${log.state.tokens.budget} (plafond dur de la ligne).`,
      `- Cycles impl->CI : ${log.state.cycles.total} (par modèle : ${byModel}).`,
      `- Retours de review : ${log.state.review_returns} ; interruptions : ${log.state.interruptions}.`,
      "",
      "## Recommandation",
      `Verdict \`${verdict}\`. ${RECOMMENDATION[verdict]}`,
      "",
    ].join("\n");
    await mkdir(this.opts.reportDir, { recursive: true });
    const path = join(this.opts.reportDir, `${log.line}-blocked.md`);
    await writeFile(path, text, "utf8");
    return path;
  }
}

/** Signatures d'erreur CI : état (3 dernières) à défaut, événements `ci.result` en échec. */
function errorSignatures(log: LineLog): string[] {
  const fromState = log.state.recent_ci_errors.slice(-3).map((x) => x.signature);
  if (fromState.length) return fromState;
  return log.events
    .map((e) => e.detail?.error_signature)
    .filter((s): s is string => typeof s === "string")
    .slice(-3);
}
