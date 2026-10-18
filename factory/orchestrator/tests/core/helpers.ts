import { ManualClock } from "../../src/clock";
import { loadSupervisionConfig } from "../../src/config";
import type { Depanneur, EventSink, LineLog, WorktreeManager, WorktreeRef } from "../../src/ports";
import { FakeRunner, type FakeScriptSource } from "../../src/runner";
import type { AssessVerdict, FactoryEvent, Supervisor, SupervisorAction, SupervisorInput } from "../../src/types";
import { InMemoryBudgetMeter } from "../../src/core/budget";
import { Core, type LineSpec } from "../../src/core/core";
import type { KillSwitch } from "../../src/core/kill-port";
import type { ModelTable } from "../../src/core/models";

export const config = loadSupervisionConfig();

export const settle = async (n = 200): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

export class MemorySink implements EventSink {
  events: FactoryEvent[] = [];
  emit(e: FactoryEvent): void { this.events.push(e); }
  async flush(): Promise<void> {}
  of(action: string): FactoryEvent[] { return this.events.filter((e) => e.action === action); }
  actions(): string[] { return this.events.map((e) => e.action); }
}

export class FakeWorktrees implements WorktreeManager {
  created: { run_id: string; line: string; agent: string; branch: string }[] = [];
  snapshots: { wt: WorktreeRef; label: string }[] = [];
  removed: { wt: WorktreeRef; keep: boolean }[] = [];
  async create(req: { run_id: string; line: string; agent: string; branch: string }): Promise<WorktreeRef> {
    this.created.push(req);
    return { path: `/work/${req.run_id}/${req.line}/${req.agent}`, branch: req.branch, line: req.line, agent: req.agent as WorktreeRef["agent"] };
  }
  async snapshot(wt: WorktreeRef, label: string): Promise<string> { this.snapshots.push({ wt, label }); return `snap:${wt.line}:${wt.agent}:${label}`; }
  async remove(wt: WorktreeRef, opts?: { keep?: boolean }): Promise<void> { this.removed.push({ wt, keep: !!opts?.keep }); }
}

export class FakeDepanneur implements Depanneur {
  assessLogs: LineLog[] = [];
  reportLogs: LineLog[] = [];
  verdict: AssessVerdict = { verdict: "continue", cause: "rien d'anormal" };
  failAssess = false;
  async assess(log: LineLog): Promise<AssessVerdict> { this.assessLogs.push(log); if (this.failAssess) throw new Error("boom"); return this.verdict; }
  async report(log: LineLog): Promise<string> { this.reportLogs.push(log); return `/reports/${log.line}.md`; }
}

export class FakeKill implements KillSwitch {
  active = false;
  triggers: string[] = [];
  isActive(): boolean { return this.active; }
  async trigger(reason: string): Promise<void> { this.active = true; this.triggers.push(reason); }
}

export class ScriptedSupervisor implements Supervisor {
  inputs: SupervisorInput[] = [];
  fn: (i: SupervisorInput) => SupervisorAction[] = () => [];
  decide = (i: SupervisorInput): SupervisorAction[] => { this.inputs.push(i); return this.fn(i); };
}

export const models: ModelTable = {
  ladder: ["m-sonnet", "m-opus", "m-fable"],
  f_model: "m-fable",
  sensitive_floor: "m-opus",
  role_models: { specifieur: "m-opus", depanneur: "m-opus" },
};

export function makeCore(opts: { scripts?: FakeScriptSource; phase?: "P0" | "P1" } = {}) {
  const clock = new ManualClock();
  const runner = new FakeRunner(clock, opts.scripts ?? { steps: [] });
  const sink = new MemorySink();
  const worktrees = new FakeWorktrees();
  const budget = new InMemoryBudgetMeter({ alert_ratio: config.kill.phase_budget_alert_ratio, phase_ceiling_factor: config.kill.phase_budget_ceiling_factor });
  const depanneur = new FakeDepanneur();
  const supervisor = new ScriptedSupervisor();
  const kill = new FakeKill();
  const core = new Core({ clock, runner, sink, worktrees, budget, depanneur, supervisor, config, models, kill, phase: opts.phase ?? "P0", run_id: "CORE" });
  return { core, clock, runner, sink, worktrees, budget, depanneur, supervisor, kill };
}

export const lineSpec = (over: Partial<LineSpec> = {}): LineSpec => ({
  line: "P0-001", phase: "P0", run_id: "RUN1", token_estimate: 10_000, files: ["src/a.ts"], model: "m-sonnet", ...over,
});

export const ev = (over: Partial<FactoryEvent> & Pick<FactoryEvent, "action">): FactoryEvent => ({
  ts: new Date(Date.parse("2026-10-18T09:00:00.000Z")).toISOString(), run_id: "RUN1", line: "P0-001", phase: "P0",
  agent: "implementeur", model: "m-sonnet", instance_id: "i1", tokens_in: 0, tokens_out: 0, cost: 0, duration_ms: 0, status: "ok", ...over,
});
