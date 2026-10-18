export const MODELS: { id: string; short: string; label: string; color: string }[] = [
  { id: "claude-fable-5-1", short: "F", label: "Fable 5.1", color: "var(--s1)" },
  { id: "claude-opus-5-5", short: "O", label: "Opus 5.5", color: "var(--s2)" },
  { id: "claude-sonnet-5-5", short: "S", label: "Sonnet 5.5", color: "var(--s3)" },
  { id: "claude-haiku-5-5", short: "H", label: "Haiku 5.5", color: "var(--s4)" },
];
export const modelMeta = (id: string) =>
  MODELS.find((m) => m.id === id) ?? { id, short: "·", label: id === "none" ? "code déterministe" : id, color: "var(--s-other)" };

export const STATUS: Record<string, { icon: string; label: string }> = {
  ok: { icon: "✓", label: "ok" }, error: { icon: "✕", label: "erreur" }, retry: { icon: "↻", label: "retry" },
  blocked: { icon: "⏸", label: "bloqué" }, looping: { icon: "∞", label: "boucle" }, killed: { icon: "■", label: "arrêté" },
  escalated: { icon: "▲", label: "escaladé" }, skipped: { icon: "–", label: "ignoré" },
};

export const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));
export const fmtUsd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;
export const fmtAge = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
export const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Libellé court d'un agent pour les en-têtes de colonne. */
export const AGENT_ABBR: Record<string, string> = {
  orchestrateur: "orch", architecte: "archi", router: "rout", specifieur: "spec", testeur: "test", implementeur: "impl",
  sentinelle: "sent", reviseur: "revi", integrateur: "inté", depanneur: "dépa", scribe: "scri", superviseur: "supe", introspecteur: "intr",
};

/**
 * Nature d'un agent (strategy.md §2-§3) :
 * - llm  : raisonne avec un modèle de pointe (F/O/S) ;
 * - light: appel LLM léger (Haiku) à faible enjeu : router, scribe. Affichés avec les agents LLM, marqués « léger » ;
 * - auto : code déterministe (model `none`) : orchestrateur, sentinelle, intégrateur.
 */
export type AgentKind = "llm" | "light" | "auto";
export const AGENT_KIND: Record<string, AgentKind> = {
  architecte: "llm", specifieur: "llm", testeur: "llm", implementeur: "llm", reviseur: "llm", depanneur: "llm",
  router: "light", scribe: "light", introspecteur: "llm",
  orchestrateur: "auto", sentinelle: "auto", integrateur: "auto", superviseur: "auto",
};
export const isAuto = (agent: string) => AGENT_KIND[agent] === "auto";
