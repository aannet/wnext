import { describe, expect, it } from "vitest";
import type { FakeScript } from "../../src/runner";
import type { SupervisorAction, Signal } from "../../src/types";
import { config, ev, lineSpec, makeCore, settle } from "./helpers";

const sig = (kind: Signal["kind"]): Signal => ({ kind });
const base = (line = "P0-001") => ({ line, cause: "c", signal: sig("idle_without_commit") });
const impl = { role: "implementeur" as const, prompt: "implémente", allowed_tools: ["Edit"], writing: true };

async function started(opts: Parameters<typeof makeCore>[0] = {}, spec = lineSpec()) {
  const t = makeCore(opts);
  const machine = t.core.registerLine(spec);
  machine.advance("tests", t.clock.now()); machine.advance("impl", t.clock.now());
  const s = await t.core.startAgent({ line: spec.line, ...impl });
  return { ...t, machine, s: s! };
}

describe("Core : worktrees, verrous, démarrage", () => {
  it("un worktree par ligne et par agent écrivant, branche line/<ligne>, réutilisé pour le même rôle", async () => {
    const { core, worktrees, runner } = await started();
    await core.startAgent({ line: "P0-001", role: "implementeur", prompt: "again", allowed_tools: [], writing: true });
    await core.startAgent({ line: "P0-001", role: "testeur", prompt: "t", allowed_tools: [], writing: true });
    expect(worktrees.created.map((c) => [c.agent, c.branch, c.run_id])).toEqual([
      ["implementeur", "line/P0-001", "RUN1"], ["testeur", "line/P0-001", "RUN1"],
    ]);
    expect(runner.started[0]!.worktree).toBe("/work/RUN1/P0-001/implementeur");
    expect(runner.started[1]!.worktree).toBe(runner.started[0]!.worktree);
  });
  it("limites de session : tokens restants de la ligne (3 x estimation), durée murale restante", async () => {
    const { runner, clock, core } = await started();
    expect(runner.started[0]!.limits).toEqual({ max_tokens: 30_000, max_wall_ms: 180 * 60_000 });
    await clock.advance(60 * 60_000);
    await core.startAgent({ line: "P0-001", role: "reviseur", prompt: "r", allowed_tools: [] });
    expect(runner.started[1]!.limits.max_wall_ms).toBe(120 * 60_000);
  });
  it("deux lignes sur le même fichier sont sérialisées, libérées à la fin de la première", async () => {
    const t = makeCore();
    const a = t.core.registerLine(lineSpec({ line: "P0-001", files: ["src/shared.ts"] }));
    t.core.registerLine(lineSpec({ line: "P0-002", run_id: "RUN2", files: ["src/shared.ts", "src/b.ts"] }));
    a.advance("tests", 0); a.advance("impl", 0);
    await t.core.startAgent({ line: "P0-001", ...impl });
    let second = false;
    const p2 = t.core.startAgent({ line: "P0-002", ...impl }).then(() => { second = true; });
    await settle();
    expect(second).toBe(false);
    expect(t.runner.started.map((s) => s.line)).toEqual(["P0-001"]);
    a.advance("ci", 0); a.advance("review", 0); a.advance("merge", 0);
    await t.core.mergeDone("P0-001");
    await p2;
    expect(t.runner.started.map((s) => s.line)).toEqual(["P0-001", "P0-002"]);
  });
  it("refuse de démarrer quand le kill-switch est actif ; ligne non running refusée", async () => {
    const t = makeCore();
    t.core.registerLine(lineSpec());
    t.kill.active = true;
    await expect(t.core.startAgent({ line: "P0-001", ...impl })).rejects.toThrow(/kill-switch/);
    expect(t.runner.started).toHaveLength(0);
  });
});

describe("Core : boucle de tick", () => {
  it("émet supervisor.tick à chaque tick et appelle decide une fois par ligne running avec SupervisorInput", async () => {
    const { core, supervisor, sink, clock } = await started();
    core.registerLine(lineSpec({ line: "P0-002", run_id: "RUN2", files: ["z.ts"] }));
    await core.tick(); await clock.advance(30_000); await core.tick();
    expect(sink.of("supervisor.tick")).toHaveLength(2);
    expect(sink.of("supervisor.tick")[0]).toMatchObject({ line: "_global", agent: "superviseur", model: "none", status: "ok" });
    expect(supervisor.inputs).toHaveLength(4);
    const first = supervisor.inputs.find((i) => i.line.line === "P0-001")!;
    expect(first.agents).toHaveLength(1);
    expect(first.config).toBe(config);
    expect(first.kill_switch_active).toBe(false);
  });
  it("run() tique toutes les tick_s secondes sur l'horloge injectée, s'arrête sur signal", async () => {
    const { core, sink, clock } = await started();
    const ac = new AbortController();
    const done = core.run(ac.signal);
    await clock.advance(0); expect(sink.of("supervisor.tick")).toHaveLength(1);
    await clock.advance(30_000); expect(sink.of("supervisor.tick")).toHaveLength(2);
    await clock.advance(60_000); expect(sink.of("supervisor.tick")).toHaveLength(4);
    ac.abort(); await done;
  });
  it("une exception du Superviseur n'arrête pas la boucle (événement d'erreur)", async () => {
    const { core, supervisor, sink } = await started();
    supervisor.fn = () => { throw new Error("bug"); };
    await core.tick();
    expect(sink.of("supervisor.error")).toHaveLength(1);
    await core.tick();
    expect(sink.of("supervisor.tick")).toHaveLength(2);
  });
  it("durée murale 3 h : ligne bloquée au tick (sans attendre le Superviseur), rapport du Dépanneur", async () => {
    const { core, clock, depanneur, sink, machine, runner } = await started();
    await clock.advance(180 * 60_000);
    await core.tick();
    expect(machine.state.status).toBe("blocked");
    expect(machine.blockReason).toBe("wall_clock");
    expect(depanneur.reportLogs).toHaveLength(1);
    expect(runner.stops.length).toBeLessThanOrEqual(1); // la session a pu se terminer seule (limit_wall) juste avant
    expect(sink.of("status.blocked")).toHaveLength(1);
    expect(sink.of("status.blocked")[0]).toMatchObject({ status: "blocked", detail: { reason: "wall_clock", report: "/reports/P0-001.md" } });
  });
  it("ne consulte pas le Superviseur pour une ligne blocked/done/killed", async () => {
    const { core, supervisor, machine } = await started();
    machine.block("x", 0);
    await core.tick();
    expect(supervisor.inputs).toHaveLength(0);
  });
});

describe("Core : exécution des actions", () => {
  it("warn -> supervisor.warn, dédupliqué tant que le signal persiste, warn_since_ms posé", async () => {
    const { core, supervisor, sink, s, clock } = await started();
    supervisor.fn = (i) => i.agents.length ? [{ type: "warn", ...base(), instance_id: s.spec.instance_id, role: "implementeur" }] : [];
    await core.tick(); await core.tick();
    expect(sink.of("supervisor.warn")).toHaveLength(1);
    expect(sink.of("supervisor.warn")[0]).toMatchObject({ line: "P0-001", status: "ok", agent: "superviseur", detail: { signal: "idle_without_commit", instance: s.spec.instance_id } });
    await clock.advance(1000);
    await core.tick();
    expect(supervisor.inputs.at(-1)!.agents[0]!.warn_since_ms).not.toBeNull();
  });
  it("assess_request -> Dépanneur.assess(LineLog), supervisor.assess, verdict livré au tick suivant puis consommé", async () => {
    const { core, supervisor, sink, depanneur, s } = await started();
    depanneur.verdict = { verdict: "restart", cause: "boucle" };
    let n = 0;
    supervisor.fn = () => (n++ === 0 ? [{ type: "assess_request", ...base(), signal: sig("warn_persisted"), instance_id: s.spec.instance_id, role: "implementeur" }] : []);
    await core.tick();
    expect(depanneur.assessLogs).toHaveLength(1);
    expect(depanneur.assessLogs[0]).toMatchObject({ line: "P0-001", run_id: "RUN1", trigger: { kind: "warn_persisted" } });
    expect(sink.of("supervisor.assess")[0]).toMatchObject({ detail: { verdict: "restart", cause: "boucle" } });
    await core.tick();
    expect(supervisor.inputs.at(-1)!.verdicts).toMatchObject([{ verdict: "restart", instance_id: s.spec.instance_id }]);
    await core.tick();
    expect(supervisor.inputs.at(-1)!.verdicts).toEqual([]);
  });
  it("assess : échec du Dépanneur = événement d'erreur, pas de verdict, pas de plantage", async () => {
    const { core, supervisor, sink, depanneur, s } = await started();
    depanneur.failAssess = true;
    supervisor.fn = () => [{ type: "assess_request", ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
    await core.tick();
    expect(sink.of("supervisor.assess")[0]!.status).toBe("error");
  });
  it("interrupt -> stop soft, snapshot, worktree conservé, compteurs", async () => {
    const { core, supervisor, sink, worktrees, runner, s, machine } = await started();
    let once = true;
    supervisor.fn = () => { if (!once) return []; once = false; return [{ type: "interrupt", ...base(), instance_id: s.spec.instance_id, role: "implementeur" }]; };
    await core.tick();
    expect(runner.stops).toEqual([{ instance_id: s.spec.instance_id, mode: "soft" }]);
    expect(worktrees.snapshots).toHaveLength(1);
    expect(worktrees.removed).toEqual([]);
    const e = sink.of("supervisor.interrupt")[0]!;
    expect(e.parent_id).toBe("snap:P0-001:implementeur:interrupt");
    expect(machine.state.interruptions).toBe(1);
    await core.tick();
    expect(supervisor.inputs.at(-1)!.line.interruptions).toBe(1);
    expect(supervisor.inputs.at(-1)!.phase.interruptions_last_hour).toBe(1);
    expect(supervisor.inputs.at(-1)!.agents).toEqual([]);
  });
  it("interrupt d'un signal de boucle : loop.detected + ligne looping, comptée sur 1 h", async () => {
    const { core, supervisor, sink, s, machine } = await started();
    let once = true;
    supervisor.fn = () => { if (!once) return []; once = false; return [{ type: "interrupt", ...base(), signal: sig("loop_diff_repeat"), instance_id: s.spec.instance_id, role: "implementeur" }]; };
    await core.tick();
    expect(machine.state.status).toBe("looping");
    expect(sink.of("loop.detected")[0]).toMatchObject({ status: "looping" });
    await core.tick(); // ligne looping : toujours consultée (le relaunch arrive après le verdict)
    expect(supervisor.inputs.at(-1)!.phase.looping_lines_last_hour).toBe(1);
  });
  it("interrupt : si le stop soft dépasse stop_deadline_s, stop hard", async () => {
    const t = makeCore({ scripts: { steps: [] } });
    const m = t.core.registerLine(lineSpec()); m.advance("tests", 0); m.advance("impl", 0);
    const s = (await t.core.startAgent({ line: "P0-001", ...impl }))!;
    const realStop = s.handle.stop.bind(s.handle);
    let calls: string[] = [];
    (s.handle as { stop: typeof s.handle.stop }).stop = (mode) => { calls.push(mode); return mode === "soft" ? new Promise<void>(() => {}) : realStop("hard"); };
    t.supervisor.fn = () => [{ type: "interrupt", ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
    const tick = t.core.tick();
    await settle();
    expect(calls).toEqual(["soft"]);
    await t.clock.advance(config.kill.stop_deadline_s * 1000);
    await tick;
    expect(calls).toEqual(["soft", "hard"]);
  });
  it("relaunch reduce_context : même modèle, prompt modifié, parent, worktree réutilisé, compteur", async () => {
    const { core, supervisor, sink, runner, worktrees, s, machine } = await started();
    let n = 0;
    supervisor.fn = () => {
      n++;
      if (n === 1) return [{ type: "interrupt", ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
      if (n === 2) return [{ type: "relaunch", change: { kind: "reduce_context" }, ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
      return [];
    };
    await core.tick(); await core.tick();
    expect(runner.started).toHaveLength(2);
    const r = runner.started[1]!;
    expect(r.model).toBe("m-sonnet");
    expect(r.prompt).not.toBe(runner.started[0]!.prompt);
    expect(r.prompt).toContain(runner.started[0]!.prompt);
    expect(r.parent_instance_id).toBe(s.spec.instance_id);
    expect(r.instance_id).not.toBe(s.spec.instance_id);
    expect(r.worktree).toBe(runner.started[0]!.worktree);
    expect(worktrees.created).toHaveLength(1);
    expect(machine.state.relaunches_by_agent).toEqual({ implementeur: 1 });
    expect(sink.of("supervisor.restart")[0]).toMatchObject({ status: "retry", detail: { change: "reduce_context" } });
  });
  it("relaunch upgrade_model : modèle supérieur via la table, escalate.model, une seule montée vers F", async () => {
    const { core, supervisor, sink, runner, s, machine } = await started({}, lineSpec({ model: "m-opus" }));
    machine.state.relaunches_by_agent = {};
    supervisor.fn = () => [{ type: "relaunch", change: { kind: "upgrade_model" }, ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
    await core.tick();
    expect(runner.started[1]!.model).toBe("m-fable");
    expect(machine.model).toBe("m-fable");
    expect(machine.state.f_escalations).toBe(1);
    expect(sink.of("escalate.model")[0]).toMatchObject({ status: "escalated", detail: { from: "m-opus", to: "m-fable" } });
  });
  it("relaunch upgrade_model sans modèle disponible (déjà F) : ligne blocked", async () => {
    const { core, supervisor, s, machine, depanneur } = await started({}, lineSpec({ model: "m-fable" }));
    supervisor.fn = () => [{ type: "relaunch", change: { kind: "upgrade_model" }, ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
    await core.tick();
    expect(machine.state.status).toBe("blocked");
    expect(machine.blockReason).toBe("model_exhausted");
    expect(depanneur.reportLogs).toHaveLength(1);
  });
  it("relaunch : refusé (blocked) si la limite de relances par agent est déjà atteinte", async () => {
    const { core, supervisor, s, machine } = await started();
    machine.state.relaunches_by_agent = { implementeur: config.relaunch.max_per_agent_and_line };
    supervisor.fn = () => [{ type: "relaunch", change: { kind: "reduce_context" }, ...base(), instance_id: s.spec.instance_id, role: "implementeur" }];
    await core.tick();
    expect(machine.blockReason).toBe("relaunch_exhausted");
  });
  it("relaunch respec : retour à l'étape spec, Spécifieur au modèle de la table", async () => {
    const { core, supervisor, runner, s, machine } = await started();
    let n = 0;
    supervisor.fn = () => (n++ === 0 ? [{ type: "relaunch", change: { kind: "respec" }, ...base(), instance_id: s.spec.instance_id, role: "implementeur" }] : []);
    await core.tick();
    expect(machine.state.step).toBe("spec");
    expect(runner.started[1]).toMatchObject({ role: "specifieur", model: "m-opus" });
    expect(machine.state.relaunches_by_agent).toEqual({ implementeur: 1 });
  });
  it("relaunch d'une ligne looping la remet en running", async () => {
    const { core, supervisor, s, machine } = await started();
    let n = 0;
    supervisor.fn = () => {
      n++;
      if (n === 1) return [{ type: "interrupt", ...base(), signal: sig("loop_error_signature"), instance_id: s.spec.instance_id, role: "implementeur" }];
      return [];
    };
    await core.tick();
    expect(machine.state.status).toBe("looping");
    await core.relaunch({ type: "relaunch", change: { kind: "reduce_context" }, ...base(), instance_id: s.spec.instance_id, role: "implementeur" });
    expect(machine.state.status).toBe("running");
  });
  it("block -> blocked, agents arrêtés, rapport Dépanneur, worktrees conservés, verrous libérés", async () => {
    const { core, supervisor, sink, depanneur, worktrees, runner, machine } = await started();
    supervisor.fn = () => [{ type: "block", ...base(), signal: sig("second_interruption") }];
    await core.tick();
    expect(machine.state.status).toBe("blocked");
    expect(runner.stops).toHaveLength(1);
    expect(depanneur.reportLogs[0]!.trigger.kind).toBe("second_interruption");
    expect(worktrees.removed.every((r) => r.keep)).toBe(true);
    expect(sink.of("status.blocked")).toHaveLength(1);
    // verrou libéré : une autre ligne peut prendre le fichier
    const m2 = core.registerLine(lineSpec({ line: "P0-002", run_id: "R2" })); m2.advance("tests", 0); m2.advance("impl", 0);
    await expect(core.startAgent({ line: "P0-002", ...impl })).resolves.not.toBeNull();
  });
  it("system_kill global : crée KILL (port), arrête tout, lignes killed, worktrees conservés, plus de lancement", async () => {
    const { core, supervisor, sink, kill, runner, worktrees, machine } = await started();
    const m2 = core.registerLine(lineSpec({ line: "P0-002", run_id: "R2", files: ["other.ts"] })); m2.advance("tests", 0); m2.advance("impl", 0);
    await core.startAgent({ line: "P0-002", ...impl });
    supervisor.fn = (i) => i.line.line === "P0-001" ? [{ type: "system_kill", scope: "global", ...base(), signal: sig("interruptions_per_hour") }] : [];
    await core.tick();
    expect(kill.triggers).toHaveLength(1);
    expect(runner.stops).toHaveLength(2);
    expect(machine.state.status).toBe("killed");
    expect(m2.state.status).toBe("killed");
    expect(worktrees.removed.every((r) => r.keep)).toBe(true);
    expect(sink.of("kill.triggered")[0]).toMatchObject({ status: "killed", line: "_global", detail: { scope: "global", signal: "interruptions_per_hour" } });
    await expect(core.startAgent({ line: "P0-002", ...impl })).rejects.toThrow();
    const n = supervisor.inputs.length;
    await core.tick();
    expect(supervisor.inputs).toHaveLength(n); // plus aucun appel au Superviseur
  });
  it("system_kill de phase : n'appelle pas le port global, ne tue que les lignes de la phase", async () => {
    const { core, supervisor, kill, machine } = await started();
    const m1 = core.registerLine(lineSpec({ line: "P1-001", phase: "P1", run_id: "R3", files: ["x.ts"] })); m1.advance("tests", 0); m1.advance("impl", 0);
    await core.startAgent({ line: "P1-001", ...impl });
    supervisor.fn = (i) => i.line.line === "P0-001" ? [{ type: "system_kill", scope: "phase", ...base(), signal: sig("phase_budget_ceiling") }] : [];
    await core.tick();
    expect(kill.triggers).toEqual([]);
    expect(machine.state.status).toBe("killed");
    expect(m1.state.status).toBe("running");
  });
  it("factory/KILL déjà présent au tick : arrêt local de tout, un seul événement, pas de decide", async () => {
    const { core, supervisor, kill, runner, sink, machine } = await started();
    kill.active = true;
    await core.tick(); await core.tick();
    expect(kill.triggers).toEqual([]);
    expect(runner.stops).toHaveLength(1);
    expect(machine.state.status).toBe("killed");
    expect(supervisor.inputs).toHaveLength(0);
    expect(sink.of("kill.triggered")).toHaveLength(1);
    expect(sink.of("supervisor.tick")).toHaveLength(2);
  });
});

describe("Core : budget", () => {
  const spend = (tokens: number): FakeScript => ({ steps: [{ after_ms: 10, event: { action: "llm.call", status: "ok", tokens_in: tokens, tokens_out: 0 } }] });
  it("alerte à 80 % du budget de ligne, une seule fois", async () => {
    const t = await started({ scripts: { steps: [
      { after_ms: 10, event: { action: "llm.call", status: "ok", tokens_in: 24_000 } },
      { after_ms: 10, event: { action: "llm.call", status: "ok", tokens_in: 100 } },
    ] } });
    await t.clock.advance(30); await settle();
    expect(t.sink.of("budget.alert")).toHaveLength(1);
    expect(t.sink.of("budget.alert")[0]).toMatchObject({ detail: { scope: "line", ratio: 0.8 } });
  });
  it("plafond dur de ligne : agent interrompu (snapshot), ligne blocked + rapport", async () => {
    const t = await started({ scripts: spend(30_000) }, lineSpec({ token_estimate: 10_000 }));
    // limits.max_tokens du runner coupe aussi : on veut le chemin du BudgetMeter, donc plafond runner large
    await t.clock.advance(20); await settle();
    expect(t.machine.state.status).toBe("blocked");
    expect(t.machine.blockReason).toBe("line_budget_ceiling");
    expect(t.worktrees.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(t.depanneur.reportLogs).toHaveLength(1);
    expect(t.sink.of("budget.exceeded")[0]).toMatchObject({ detail: { scope: "line" } });
  });
  it("plafond dur de phase (1,3 x) : tous les agents de la phase sont interrompus, lignes non bloquées", async () => {
    const t = makeCore({ scripts: spend(5_000) });
    t.budget.setPhaseBudget("P0", 10_000);
    const m1 = t.core.registerLine(lineSpec({ line: "P0-001", token_estimate: 100_000, files: ["a"] })); m1.advance("tests", 0); m1.advance("impl", 0);
    const m2 = t.core.registerLine(lineSpec({ line: "P0-002", run_id: "R2", token_estimate: 100_000, files: ["b"] })); m2.advance("tests", 0); m2.advance("impl", 0);
    await t.core.startAgent({ line: "P0-001", ...impl });
    await t.core.startAgent({ line: "P0-002", ...impl });
    await t.clock.advance(20); await settle();
    // 2 x 5000 = 10000 (alerte) ; on dépasse 13000 avec un 2e tour
    expect(t.sink.of("budget.alert").some((e) => e.detail?.scope === "phase")).toBe(true);
    t.budget.record("P0-001", "P0", { tokens_in: 3_000, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 });
    await t.core.tick();
    expect(t.runner.stops).toHaveLength(2);
    expect(t.sink.of("budget.exceeded").some((e) => e.detail?.scope === "phase")).toBe(true);
    expect(m1.state.status).toBe("running");
  });
});

describe("Core : pipeline §4.1 et retries §4.3", () => {
  it("advance émet pipeline.step ; completeCi(false) -> retry.start et retour à impl", async () => {
    const { core, sink, machine } = await started();
    await core.advance("P0-001", "ci");
    expect(sink.of("pipeline.step").at(-1)).toMatchObject({ detail: { from: "impl", to: "ci" } });
    await core.completeCi("P0-001", false);
    expect(machine.state.step).toBe("impl");
    expect(sink.of("retry.start")[0]).toMatchObject({ status: "retry", attempt: 2, detail: { reason: "ci_failed" } });
  });
  it("2 cycles consommés sur un modèle : escalate.model au retour suivant", async () => {
    const { core, sink, machine } = await started();
    for (let i = 0; i < 2; i++) { await core.advance("P0-001", "ci"); await core.completeCi("P0-001", false); }
    expect(machine.model).toBe("m-opus");
    expect(machine.state.step).toBe("impl");
    expect(sink.of("escalate.model")[0]).toMatchObject({ detail: { from: "m-sonnet", to: "m-opus", reason: "model_cycles" } });
  });
  it("5 cycles épuisés : blocked + rapport Dépanneur", async () => {
    const { core, machine, depanneur, sink } = await started();
    for (let i = 0; i < 5; i++) { await core.advance("P0-001", "ci"); await core.completeCi("P0-001", false); }
    expect(machine.state.status).toBe("blocked");
    expect(machine.blockReason).toBe("cycles_exhausted");
    expect(depanneur.reportLogs).toHaveLength(1);
    expect(sink.of("status.blocked")).toHaveLength(1);
  });
  it("review : 'changes' compte comme retour ; 3e retour -> blocked ; approve -> merge ; mergeDone -> done, worktrees détruits", async () => {
    const t = await started();
    t.machine.switchModel("m-sonnet");
    // 2 retours de review (modèle changé pour ne pas buter sur 2 cycles/modèle)
    await t.core.advance("P0-001", "ci"); await t.core.completeCi("P0-001", true);
    await t.core.reviewVerdict("P0-001", "changes");
    expect(t.machine.state.review_returns).toBe(1);
    await t.core.advance("P0-001", "ci"); await t.core.completeCi("P0-001", true);
    await t.core.reviewVerdict("P0-001", "approve");
    expect(t.machine.state.step).toBe("merge");
    await t.core.mergeDone("P0-001");
    expect(t.machine.state.status).toBe("done");
    expect(t.sink.of("merge.done")).toHaveLength(1);
    expect(t.worktrees.removed.some((r) => !r.keep)).toBe(true);
  });
  it("retours de review épuisés : blocked", async () => {
    const t = await started();
    for (let i = 0; i < 2; i++) {
      await t.core.advance("P0-001", "ci"); await t.core.completeCi("P0-001", true);
      await t.core.reviewVerdict("P0-001", "changes");
      t.machine.switchModel("m-m" + i); // évite la limite par modèle
    }
    await t.core.advance("P0-001", "ci"); await t.core.completeCi("P0-001", true);
    await t.core.reviewVerdict("P0-001", "changes");
    expect(t.machine.blockReason).toBe("review_returns_exhausted");
  });
});

describe("Core : backoff API 429/5xx (§4.3)", () => {
  const flaky = (failures: number): ((spec: unknown) => FakeScript) => {
    let n = 0;
    return () => (n++ < failures
      ? { steps: [], end: { after_ms: 100, reason: "error", error: "HTTP 429 rate limit" } }
      : { steps: [], end: { after_ms: 100, reason: "completed" } });
  };
  it("429 : attend 1 s, 2 s sur l'horloge, relance, sans consommer de cycle", async () => {
    const t = makeCore({ scripts: flaky(2) });
    const m = t.core.registerLine(lineSpec()); m.advance("tests", 0); m.advance("impl", 0);
    const p = t.core.runAgent({ line: "P0-001", ...impl });
    await t.clock.advance(100); // fin du 1er essai
    expect(t.sink.of("retry.start")).toHaveLength(1);
    expect(t.runner.started).toHaveLength(1);
    await t.clock.advance(999); expect(t.runner.started).toHaveLength(1);
    await t.clock.advance(1); expect(t.runner.started).toHaveLength(2);
    await t.clock.advance(100); await t.clock.advance(2000); await t.clock.advance(100);
    const out = await p;
    expect(out.result?.end_reason).toBe("completed");
    expect(out.api_exhausted).toBe(false);
    expect(t.runner.started).toHaveLength(3);
    expect(m.state.cycles.total).toBe(0);
    expect(t.sink.of("retry.start").map((e) => e.detail?.backoff_ms)).toEqual([1000, 2000]);
    expect(t.sink.of("retry.start")[0]).toMatchObject({ status: "retry", detail: { reason: "api_error" } });
  });
  it("le temps passé en backoff compte dans la durée murale", async () => {
    const t = makeCore({ scripts: flaky(2) });
    const m = t.core.registerLine(lineSpec()); m.advance("tests", 0); m.advance("impl", 0);
    void t.core.runAgent({ line: "P0-001", ...impl });
    await t.clock.advance(100 + 1000 + 100 + 2000);
    expect(m.wallExceeded(t.clock.now())).toBe(false);
    expect(t.clock.now() - m.state.started_at_ms).toBe(3200);
  });
  it("3 échecs API de suite : escalade de modèle (une fois) puis nouvelle série ; sans modèle supérieur : blocked", async () => {
    const t = makeCore({ scripts: flaky(99) });
    const m = t.core.registerLine(lineSpec({ model: "m-fable" })); m.advance("tests", 0); m.advance("impl", 0);
    const p = t.core.runAgent({ line: "P0-001", ...impl });
    for (let i = 0; i < 6; i++) await t.clock.advance(5000);
    const out = await p;
    expect(out.api_exhausted).toBe(true);
    expect(m.state.status).toBe("blocked");
    expect(m.blockReason).toBe("api_backoff_exhausted");
    expect(t.runner.started).toHaveLength(config.retries.api_backoff_max_attempts + 1);
  });
});
