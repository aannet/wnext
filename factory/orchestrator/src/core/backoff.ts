/** Backoff exponentiel sur erreurs API 429/5xx (§4.3) : non compté comme retry de ligne, mais compté au temps (durée murale). */
import type { AgentResult } from "../runner";

export function backoffDelayMs(attempt: number, opts: { baseMs?: number; capMs?: number } = {}): number {
  const base = opts.baseMs ?? 1000, cap = opts.capMs ?? 60_000;
  return Math.min(cap, base * 2 ** attempt);
}

/** Erreur technique d'un agent due à l'API : 429 ou 5xx dans le message court (sans contenu sensible). */
export function isRetryableApiError(r: AgentResult): boolean {
  return r.end_reason === "error" && !!r.error && /(^|\D)(429|5\d\d)(\D|$)/.test(r.error);
}
