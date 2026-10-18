/** BudgetMeter en mémoire : cumule les tokens (entrée + sortie + cache) alimentés depuis le flux d'événements (§5 consommateur 3). */
import type { BudgetLevel, BudgetMeter, BudgetStatus } from "../ports";
import type { TokenUsage } from "../runner";
import type { LineId, Phase } from "../types";

export interface BudgetMeterOptions {
  /** `kill.phase_budget_alert_ratio` (0,8). */
  alert_ratio: number;
  /** `kill.phase_budget_ceiling_factor` (1,3). */
  phase_ceiling_factor: number;
}

export const totalTokens = (u: TokenUsage): number => u.tokens_in + u.tokens_out + u.tokens_cache_read + u.tokens_cache_write;

export class InMemoryBudgetMeter implements BudgetMeter {
  private lineBudget = new Map<LineId, number>();
  private phaseBudget = new Map<Phase, number>();
  private lineUsed = new Map<LineId, number>();
  private phaseUsed = new Map<Phase, number>();
  constructor(private readonly opts: BudgetMeterOptions) {}

  setLineBudget(line: LineId, tokens: number): void { this.lineBudget.set(line, tokens); }
  setPhaseBudget(phase: Phase, tokens: number): void { this.phaseBudget.set(phase, tokens); }

  record(line: LineId, phase: Phase, usage: TokenUsage): void {
    const t = totalTokens(usage);
    this.lineUsed.set(line, (this.lineUsed.get(line) ?? 0) + t);
    this.phaseUsed.set(phase, (this.phaseUsed.get(phase) ?? 0) + t);
  }

  /** Ligne : le budget fourni EST le plafond dur (3 x estimation, §4.3). */
  line(line: LineId): BudgetStatus { return this.status(this.lineUsed.get(line) ?? 0, this.lineBudget.get(line) ?? 0, 1); }
  phase(phase: Phase): BudgetStatus { return this.status(this.phaseUsed.get(phase) ?? 0, this.phaseBudget.get(phase) ?? 0, this.opts.phase_ceiling_factor); }

  private status(used: number, budget: number, factor: number): BudgetStatus {
    const hard_ceiling = budget * factor;
    if (budget <= 0) return { used, budget, hard_ceiling, ratio: 0, level: "ok" };
    const ratio = used / budget;
    const level: BudgetLevel = used >= hard_ceiling ? "exceeded" : ratio >= this.opts.alert_ratio ? "alert" : "ok";
    return { used, budget, hard_ceiling, ratio, level };
  }
}
