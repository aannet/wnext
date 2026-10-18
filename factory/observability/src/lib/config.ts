import fs from "node:fs";
import path from "node:path";
import { PHASES, type BudgetConfig, type Phase } from "./types";

export function loadBudgets(file = process.env.OBS_BUDGETS_PATH ?? "config/budgets.json"): BudgetConfig {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  for (const p of PHASES) {
    if (typeof raw.phases?.[p] !== "number" || raw.phases[p] <= 0) throw new Error(`budgets: phase ${p} invalide`);
  }
  return {
    alert_ratio: raw.alert_ratio ?? 0.8,
    hard_ceiling_factor: raw.hard_ceiling_factor ?? 1.3,
    phases: raw.phases as Record<Phase, number>,
  };
}
