/** Table de modèles configurable (aucun ID en dur, §3 règle 6). `ladder` du plus faible au plus fort. */
import type { Agent, ModelId } from "../types";

export interface ModelTable {
  ladder: ModelId[];
  /** Modèle « F » : une seule montée par ligne (`relaunch.max_f_escalations_per_line`). */
  f_model: ModelId;
  /** Plancher des lignes touchant un chemin sensible (jamais sous O). */
  sensitive_floor: ModelId;
  /** Modèle par défaut d'un rôle ; absent = bas de l'échelle. */
  role_models: Partial<Record<Agent, ModelId>>;
}

/** Modèle d'un rôle, en respectant le plancher des chemins sensibles. */
export function modelFor(t: ModelTable, role: Agent, sensitive: boolean): ModelId {
  const m = t.role_models[role] ?? t.ladder[0]!;
  if (!sensitive) return m;
  return t.ladder.indexOf(m) < t.ladder.indexOf(t.sensitive_floor) ? t.sensitive_floor : m;
}

/** Modèle immédiatement supérieur, ou null (déjà au sommet, modèle inconnu, ou montée vers F déjà consommée). */
export function resolveUpgrade(t: ModelTable, current: ModelId, ctx: { f_escalations: number; max_f_escalations: number }): ModelId | null {
  const i = t.ladder.indexOf(current);
  if (i < 0) return null;
  const next = t.ladder[i + 1];
  if (!next) return null;
  if (next === t.f_model && ctx.f_escalations >= ctx.max_f_escalations) return null;
  return next;
}
