/**
 * Introspecteur déterministe (L9.4, strategy.md §2, §4.9 ; ADR-006). Sans LLM, budget 0 token.
 * Lit les événements d'un cycle (ligne ou phase) et écrit `<retroDir>/<cycle>.md` : au plus 3 constats chiffrés,
 * au plus 3 recommandations, chacune avec son constat source, le changement exact (levier existant), la métrique
 * §6.2 visée et un critère de retour arrière. Rien ne s'applique : la PR de configuration est relue (CODEOWNERS).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { loadSupervisionConfig } from "../config";
import type { Introspecteur, Cycle } from "../ports";
import type { FactoryEvent, SupervisorConfig } from "../types";

/** §4.9 : liste de règles actives plafonnée à 15. */
export const MAX_ACTIVE_RULES = 15;
const MAX_FINDINGS = 3;
const MAX_RECOMMENDATIONS = 3;
/** §4.9 : un constat est retenu s'il se répète (>= 2) ou coûte > 5 % du budget de phase. */
const REPEAT_MIN = 2;
const COST_SHARE_MIN = 0.05;

const LINE_ID = /^P[0-5]-\d{3}$/;
const PHASE_ID = /^P[0-5]$/;

export interface IntrospecteurOptions {
  /** Répertoire de sortie (`docs/factory/retro/` en production). Aucune écriture hors de ce répertoire. */
  retroDir: string;
  /** Seuils de supervision.yaml (leviers et valeurs courantes) ; par défaut le fichier versionné. */
  config?: SupervisorConfig;
  /** Budget de tokens de la phase (§1). Sans lui, le critère de coût est désactivé. */
  phaseBudgetTokens?: number;
  /** Règles actives déjà en vigueur (cap 15). */
  activeRules?: number;
}

interface Finding {
  key: "ci" | "retry" | "escalation" | "cost";
  label: string;
  /** Nombre de lignes ou d'occurrences : sert au critère de répétition et au classement. */
  occurrences: number;
  /** Part du budget de phase (coût) ; null sans budget. */
  costShare: number | null;
  evidence: string;
  /** Détail brut réutilisé par la recommandation (modèles observés). */
  detail?: string;
}

interface Recommendation {
  title: string;
  source: string;
  change: string;
  metric: string;
  rollback: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

function validCycle(c: Cycle): boolean {
  return c.kind === "line" ? LINE_ID.test(c.id) : PHASE_ID.test(c.id);
}

function inCycle(c: Cycle, e: FactoryEvent): boolean {
  return c.kind === "line" ? e.line === c.id : e.phase === c.id;
}

const tokensOf = (e: FactoryEvent) => e.tokens_in + e.tokens_out;

/** Constats candidats, calculés sur les événements du cycle, groupés par ligne. */
function findings(events: readonly FactoryEvent[], budget: number | undefined): Finding[] {
  const byLine = new Map<string, FactoryEvent[]>();
  for (const e of events) {
    const list = byLine.get(e.line) ?? [];
    list.push(e);
    byLine.set(e.line, list);
  }
  const out: Finding[] = [];

  const failingFirst = [...byLine].filter(([, es]) => {
    const first = es.find((e) => e.action === "ci.result");
    return first !== undefined && (first.status === "error" || first.detail?.tests_green === false);
  }).map(([l]) => l);
  const ciLines = [...byLine].filter(([, es]) => es.some((e) => e.action === "ci.result")).length;
  out.push({
    key: "ci", label: "Échecs CI au premier passage", occurrences: failingFirst.length, costShare: null,
    evidence: `${failingFirst.length} ligne(s) sur ${ciLines} avec CI en échec au premier passage (${failingFirst.join(", ") || "aucune"})`,
  });

  const retries = events.filter((e) => e.action === "retry.start").length;
  out.push({
    key: "retry", label: "Retries de l'Implémenteur", occurrences: retries, costShare: null,
    evidence: `${retries} retry.start sur ${byLine.size} ligne(s)`,
  });

  const transitions: string[] = [];
  for (const [, es] of byLine) {
    const last = new Map<string, string>();
    for (const e of es) {
      if (e.action !== "llm.call") continue;
      const prev = last.get(e.agent);
      if (prev !== undefined && prev !== e.model) transitions.push(`${prev} -> ${e.model}`);
      last.set(e.agent, e.model);
    }
  }
  const pairs = [...new Set(transitions)];
  out.push({
    key: "escalation", label: "Changements de modèle pour un même agent", occurrences: transitions.length, costShare: null,
    evidence: `${transitions.length} changement(s) de modèle (${pairs.join(", ") || "aucun"})`, detail: pairs.join(", "),
  });

  if (budget !== undefined && budget > 0) {
    for (const [l, es] of byLine) {
      const share = es.reduce((a, e) => a + tokensOf(e), 0) / budget;
      if (share > COST_SHARE_MIN) {
        out.push({
          key: "cost", label: `Coût de la ligne ${l} (budget de phase)`, occurrences: 1, costShare: share,
          evidence: `${l} consomme ${pct(share)} du budget de phase (> 5 %)`,
        });
      }
    }
  }
  return out;
}
function retained(f: Finding): boolean {
  return f.occurrences >= REPEAT_MIN || (f.costShare !== null && f.costShare > COST_SHARE_MIN);
}

function recommendationFor(f: Finding, cfg: SupervisorConfig, i: number): Recommendation {
  const src = `C${i + 1}`;
  switch (f.key) {
    case "ci":
      return {
        title: "Consigne CLAUDE.md : vérification locale avant commit", source: src,
        change: "consigne CLAUDE.md (Implémenteur) : ajouter « lancer `make check` en local avant chaque commit ». PR relue.",
        metric: "Qualité : taux de réussite CI au premier passage (>= 60 % puis 75 %)",
        rollback: "retirer la consigne si le taux de premier passage ne progresse pas après 2 cycles.",
      };
    case "retry": {
      const cur = cfg.retries.max_cycles_total;
      const next = Math.max(2, cur - 1);
      return {
        title: "Plafond de cycles impl->CI plus serré", source: src,
        change: `supervision.yaml \`retries.max_cycles_total\` : ${cur} -> ${next}`,
        metric: "Qualité : retries moyens par ligne (<= 1,5)",
        rollback: `revenir à ${cur} si la part de lignes mergées baisse de plus de 10 points sur 2 cycles.`,
      };
    }
    case "escalation":
      return {
        title: "Routage : modèle de départ de l'Implémenteur", source: src,
        change: `routage (Router) : démarrer sur le modèle de la montée observée (${f.detail ?? "modèle observé"}) pour la classe de ligne concernée`,
        metric: "Qualité : taux d'escalade de modèle (< 15 %)",
        rollback: "revenir au routage précédent si le coût par ligne mergée (p50) augmente de plus de 20 % sur 2 cycles.",
      };
    case "cost": {
      const cur = cfg.retries.line_budget_factor;
      const next = Math.max(1, cur - 1);
      return {
        title: "Budget de ligne plus serré", source: src,
        change: `supervision.yaml \`retries.line_budget_factor\` : ${cur} -> ${next}`,
        metric: "Coût : tokens par phase et par ligne <= budget (dépassement de ligne < 10 %)",
        rollback: `revenir à ${cur} si plus de 10 % des lignes passent \`blocked\` pour budget sur 2 cycles.`,
      };
    }
  }
}

export class IntrospecteurDeterministe implements Introspecteur {
  private readonly cfg: SupervisorConfig;

  constructor(private readonly opts: IntrospecteurOptions) {
    this.cfg = opts.config ?? loadSupervisionConfig();
  }

  async run(cycle: Cycle, events: readonly FactoryEvent[]): Promise<string> {
    if (!validCycle(cycle)) throw new Error(`identifiant de cycle invalide : ${JSON.stringify(cycle.id)}`);
    const dir = resolve(this.opts.retroDir);
    const path = resolve(join(dir, `${cycle.id}.md`));
    if (!path.startsWith(dir + sep)) throw new Error("chemin de rétro hors du répertoire autorisé");

    const scoped = events.filter((e) => inCycle(cycle, e));
    const budget = this.opts.phaseBudgetTokens;
    const kept = findings(scoped, budget).filter(retained).sort((a, b) => b.occurrences - a.occurrences).slice(0, MAX_FINDINGS);
    const slots = Math.max(0, Math.min(MAX_RECOMMENDATIONS, MAX_ACTIVE_RULES - (this.opts.activeRules ?? 0)));
    const recs = kept.map((f, i) => recommendationFor(f, this.cfg, i)).slice(0, slots);
    const capped = kept.length > 0 && slots === 0;

    const lines = [...new Set(scoped.map((e) => e.line))];
    const md = [
      `# Rétro ${cycle.id}`,
      "",
      `Cycle : ${cycle.kind === "line" ? "ligne" : "phase"} ${cycle.id} (phase ${cycle.phase}) · Événements analysés : ${scoped.length} · Lignes : ${lines.length}`,
      `Budget d'introspection : 0 token (déterministe, sans LLM).`,
      budget === undefined
        ? "Critère de coût : budget de phase non fourni, désactivé pour ce cycle."
        : `Critère de coût : budget de phase ${budget} tokens ; seuil 5 %.`,
      "",
      "## Constats",
      "",
      ...(kept.length === 0
        ? ["Constats : aucun constat retenu (pas de répétition >= 2, coût <= 5 % du budget de phase)."]
        : kept.map((f, i) => `- **C${i + 1}** ${f.label} : ${f.evidence}. Répétition ou coût retenu.`)),
      "",
      "## Recommandations",
      "",
      ...(kept.length === 0
        ? ["Aucune recommandation (aucun constat retenu)."]
        : capped
          ? ["Le plafond de 15 règles actives est atteint : aucune recommandation ajoutée."]
          : recs.flatMap((r, i) => [
            `### R${i + 1} ${r.title}`,
            `- **Constat source** : ${r.source}`,
            `- **Changement exact** : ${r.change}`,
            `- **Métrique §6.2 visée** : ${r.metric}`,
            `- **Retour arrière** : ${r.rollback}`,
            "",
          ])),
      "",
    ].join("\n");

    await mkdir(dir, { recursive: true });
    await writeFile(path, md, "utf8");
    return path;
  }
}
