/** Chargement et validation de factory/supervision.yaml (schéma strict : clé inconnue ou nombre négatif refusé). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { SupervisorConfig } from "./types";

const n = z.number().finite().nonnegative();
const int = z.number().int().nonnegative();
const pos = z.number().finite().positive();
const ratio = z.number().finite().min(0).max(1);

const schema: z.ZodType<SupervisorConfig, unknown> = z.strictObject({
  version: z.literal(1),
  supervisor: z.strictObject({ tick_s: pos, heartbeat_alert_s: pos }),
  warn: z.strictObject({ idle_without_commit_min: n, tool_calls_without_commit: int, identical_llm_calls: int }),
  assess: z.strictObject({ persistence_min: n, mute_agent_min: n }),
  interrupt: z.strictObject({ no_progress_min: n }),
  relaunch: z.strictObject({ max_per_agent_and_line: int, max_f_escalations_per_line: int, block_at_interruption: int }),
  retries: z.strictObject({
    max_cycles_total: int, max_cycles_per_model: int, max_review_returns: int,
    max_wall_clock_min: n, line_budget_factor: n, api_backoff_max_attempts: int,
  }),
  loop: z.strictObject({
    diff_repeat_consecutive: int, diff_similarity: ratio, error_signature_repeats: int,
    oscillation_enabled: z.boolean(), tool_calls_without_commit: int,
    tokens_per_changed_line_ratio: n, budget_fraction_without_green_gain: ratio,
  }),
  kill: z.strictObject({
    stop_deadline_s: n, phase_budget_alert_ratio: ratio, phase_budget_ceiling_factor: n,
    looping_lines_per_hour_max: int, interruptions_per_hour_max: int,
    ci_failure_rate_max: ratio, ci_failure_window_lines: int,
    cost_per_hour_usd_max: n.nullable(),
  }),
});

export class SupervisionConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`supervision.yaml invalide :\n- ${issues.join("\n- ")}`);
    this.name = "SupervisionConfigError";
  }
}

export const DEFAULT_SUPERVISION_PATH = fileURLToPath(new URL("../../supervision.yaml", import.meta.url));

/** Parse et valide le texte YAML. Lève `SupervisionConfigError` (liste des problèmes avec chemin de clé). */
export function parseSupervisionConfig(text: string): SupervisorConfig {
  let raw: unknown;
  try { raw = parse(text); } catch (e) { throw new SupervisionConfigError([`YAML illisible : ${(e as Error).message}`]); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new SupervisionConfigError(r.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`));
  return r.data;
}

export function loadSupervisionConfig(path: string = DEFAULT_SUPERVISION_PATH): SupervisorConfig {
  return parseSupervisionConfig(readFileSync(path, "utf8"));
}
