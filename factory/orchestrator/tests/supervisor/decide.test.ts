import { describe, expect, it } from "vitest";
import { decide } from "../../src/supervisor";
import type { SupervisorAction } from "../../src/types";
import { MIN, NOW, agent, config, deepFreeze, diff, idle, mk, verdict, type Over } from "./fixtures";

const types = (a: SupervisorAction[]) => a.map((x) => x.type);
const kinds = (a: SupervisorAction[]) => a.map((x) => x.signal.kind);
const run = (o: Over) => decide(mk(o));

describe("état sain", () => {
  it("aucune action", () => expect(run({})).toEqual([]));
  it("ligne blocked/killed/done : rien", () => {
    for (const status of ["blocked", "killed", "done"] as const) expect(run({ ...idle(60 * MIN), line: { ...idle(60 * MIN).line, status } })).toEqual([]);
  });
});

describe("niveau 1 : signaler (§4.8), seuils stricts > sauf appels identiques", () => {
  const cases: [string, Over, Over, string][] = [
    ["idle 15 min", idle(15 * MIN), idle(15 * MIN + 1), "idle_without_commit"],
    ["20 appels d'outils", { agent: { tool_calls_since_commit: 20 } }, { agent: { tool_calls_since_commit: 21 } }, "tool_calls_without_commit"],
    ["2 appels identiques", { agent: { identical_llm_call_streak: 1 } }, { agent: { identical_llm_call_streak: 2 } }, "identical_llm_calls"],
  ];
  for (const [name, below, above, kind] of cases) {
    it(`${name} : juste en dessous = rien`, () => expect(run(below)).toEqual([]));
    it(`${name} : juste au-dessus = warn`, () => {
      const a = run(above);
      expect(types(a)).toEqual(["warn"]);
      expect(kinds(a)).toEqual([kind]);
      expect(a[0]).toMatchObject({ line: "P1-017", instance_id: "impl-1", role: "implementeur" });
    });
  }
  it("pas de nouveau warn tant que warn_since_ms est posé", () => {
    expect(run({ agent: { tool_calls_since_commit: 25, warn_since_ms: NOW - MIN } })).toEqual([]);
  });
});

describe("niveau 2 : évaluer (§4.8, ADR-006)", () => {
  it("warn persistant : 10 min pile = assess, 10 min - 1 ms = rien", () => {
    const o = (ms: number): Over => ({ agent: { tool_calls_since_commit: 25, warn_since_ms: NOW - ms } });
    expect(kinds(run(o(10 * MIN)))).toEqual(["warn_persisted"]);
    expect(types(run(o(10 * MIN))).at(0)).toBe("assess_request");
    expect(run(o(10 * MIN - 1))).toEqual([]);
  });
  it("warn_since posé mais signal disparu : pas d'évaluation", () => {
    expect(run({ agent: { warn_since_ms: NOW - 30 * MIN } })).toEqual([]);
  });
  it("agent muet : 5 min pile = assess, 5 min - 1 ms = rien", () => {
    expect(kinds(run({ agent: { last_event_at_ms: NOW - 5 * MIN } }))).toEqual(["mute_agent"]);
    expect(run({ agent: { last_event_at_ms: NOW - 5 * MIN + 1 } })).toEqual([]);
  });
  it("agent muet sans aucun événement : mesuré depuis son démarrage", () => {
    expect(kinds(run({ agent: { last_event_at_ms: null, started_at_ms: NOW - 5 * MIN } }))).toEqual(["mute_agent"]);
    expect(run({ agent: { last_event_at_ms: null, started_at_ms: NOW - 5 * MIN + 1 } })).toEqual([]);
  });
});

describe("signaux de boucle §4.4 -> assess_request", () => {
  const A = (n: string) => ({ signature: n, at_ms: NOW - MIN });
  const cases: [string, Over, Over, string][] = [
    ["même hash 2 fois de suite", { line: { recent_diffs: [diff("a"), diff("b")] } }, { line: { recent_diffs: [diff("x"), diff("a"), diff("a")] } }, "loop_diff_repeat"],
    ["similarité 0.9 (pas >)", { line: { recent_diffs: [diff("a"), diff("b", { similarity_to_previous: 0.9 })] } }, { line: { recent_diffs: [diff("a"), diff("b", { similarity_to_previous: 0.91 })] } }, "loop_diff_repeat"],
    ["même hash non consécutif", { line: { recent_diffs: [diff("a"), diff("b"), diff("c")] } }, { line: { recent_diffs: [diff("a"), diff("b"), diff("b")] } }, "loop_diff_repeat"],
    ["signature d'erreur 3 fois", { line: { recent_ci_errors: [A("e"), A("e")] } }, { line: { recent_ci_errors: [A("z"), A("e"), A("e"), A("e")] } }, "loop_error_signature"],
    ["signature 3 fois mais coupée", { line: { recent_ci_errors: [A("e"), A("f"), A("e")] } }, { line: { recent_ci_errors: [A("e"), A("e"), A("e")] } }, "loop_error_signature"],
    ["oscillation A->B->A", { line: { recent_diffs: [diff("1", { file_hashes: { "f.ts": "A" } }), diff("2", { file_hashes: { "f.ts": "B" } }), diff("3", { file_hashes: { "f.ts": "C" } })] } },
      { line: { recent_diffs: [diff("1", { file_hashes: { "f.ts": "A" } }), diff("2", { file_hashes: { "f.ts": "B" } }), diff("3", { file_hashes: { "f.ts": "A" } })] } }, "loop_oscillation"],
    ["40 appels d'outils sans commit", { agent: { tool_calls_since_commit: 40, warn_since_ms: NOW - MIN } }, { agent: { tool_calls_since_commit: 41, warn_since_ms: NOW - MIN } }, "loop_tool_calls"],
    ["ratio tokens/ligne 5x", { line: { tokens: { used: 5000, budget: 1e6, used_at_last_green_gain: 5000 }, recent_diffs: [diff("a", { lines_changed: 100 })] }, phase: { median_tokens_per_changed_line: 10 } },
      { line: { tokens: { used: 5100, budget: 1e6, used_at_last_green_gain: 5100 }, recent_diffs: [diff("a", { lines_changed: 100 })] }, phase: { median_tokens_per_changed_line: 10 } }, "loop_token_ratio"],
    ["50 % du budget sans tests verts", { line: { tokens: { used: 51_000, budget: 100_000, used_at_last_green_gain: 1000 } } }, { line: { tokens: { used: 51_001, budget: 100_000, used_at_last_green_gain: 1000 } } }, "loop_budget_no_progress"],
  ];
  for (const [name, below, above, kind] of cases) {
    it(`${name} : en dessous = pas d'assess`, () => expect(types(run(below))).not.toContain("assess_request"));
    it(`${name} : au-dessus = assess_request`, () => {
      const a = run(above);
      expect(types(a)).toEqual(["assess_request"]);
      expect(kinds(a)).toEqual([kind]);
    });
  }
  it("oscillation désactivée par la config", () => {
    const o = { line: { recent_diffs: [diff("1", { file_hashes: { f: "A" } }), diff("2", { file_hashes: { f: "B" } }), diff("3", { file_hashes: { f: "A" } })] } };
    const cfg = { ...config, loop: { ...config.loop, oscillation_enabled: false } };
    expect(run({ ...o, config: cfg })).toEqual([]);
  });
  it("ratio : sans médiane de référence, pas de signal", () => {
    expect(run({ line: { tokens: { used: 9e5, budget: 1e7, used_at_last_green_gain: 9e5 }, recent_diffs: [diff("a", { lines_changed: 1 })] } })).toEqual([]);
  });
});

describe("niveau 3 : interrompre", () => {
  it("45 min sans progrès : > strict", () => {
    const warned = (ms: number): Over => ({ ...idle(ms), agent: { ...idle(ms).agent, warn_since_ms: NOW - 1 * MIN } });
    expect(types(run(warned(45 * MIN)))).not.toContain("interrupt");
    const a = run(warned(45 * MIN + 1));
    expect(types(a)).toEqual(["interrupt", "relaunch"]);
    expect(kinds(a)[0]).toBe("no_progress");
  });
  it("le progrès est un commit, une hausse de tests verts ou un changement d'étape, jamais le temps/tokens", () => {
    // un changement d'étape récent remet le compteur à zéro même sans commit
    const o = idle(60 * MIN);
    expect(run({ ...o, line: { ...o.line, last_step_change_at_ms: NOW - MIN } })).toEqual([]);
    // des tokens consommés ne comptent pas comme progrès
    expect(types(run({ ...o, line: { ...o.line, tokens: { used: 90_000, budget: 1e6, used_at_last_green_gain: 0 } } }))).toContain("interrupt");
  });
  it("durée murale ligne > 180 min : interrupt puis block, sans relance", () => {
    const at = (ms: number): Over => ({ line: { started_at_ms: NOW - ms } });
    expect(types(run(at(180 * MIN)))).toEqual([]);
    const a = run(at(180 * MIN + 1));
    expect(types(a)).toEqual(["interrupt", "block"]);
    expect(kinds(a)).toEqual(["wall_clock", "wall_clock"]);
  });
  it("verdict continue : rien", () => expect(run({ verdicts: [verdict("continue")], agent: { tool_calls_since_commit: 41 } })).toEqual([]));
  it("verdict restart/stop : interrupt + relaunch reduce_context", () => {
    for (const v of ["restart", "stop"] as const) {
      const a = run({ verdicts: [verdict(v)] });
      expect(types(a)).toEqual(["interrupt", "relaunch"]);
      expect(a[1]).toMatchObject({ type: "relaunch", change: { kind: "reduce_context" }, instance_id: "impl-1" });
      expect(kinds(a)).toEqual(["assess_verdict", "assess_verdict"]);
    }
  });
  it("verdict escalate : interrupt + block", () => {
    expect(types(run({ verdicts: [verdict("escalate")] }))).toEqual(["interrupt", "block"]);
  });
  it("verdict d'une autre instance : ignoré", () => {
    expect(run({ verdicts: [{ ...verdict("stop"), instance_id: "zzz" }] })).toEqual([]);
  });
  it("boucle active + verdict restart : changement de stratégie §4.4 (modèle supérieur, puis respec si F consommée)", () => {
    const loop = { recent_ci_errors: ["e", "e", "e"].map((s) => ({ signature: s, at_ms: NOW - MIN })) };
    expect(run({ verdicts: [verdict("restart")], line: loop })[1]).toMatchObject({ change: { kind: "upgrade_model" } });
    expect(run({ verdicts: [verdict("restart")], line: { ...loop, f_escalations: 1 } })[1]).toMatchObject({ change: { kind: "respec" } });
  });
});

describe("niveaux 4-5 : relance unique, escalade", () => {
  it("relance déjà consommée pour ce rôle : block (relaunch_exhausted)", () => {
    const a = run({ verdicts: [verdict("restart")], line: { relaunches_by_agent: { implementeur: 1 } } });
    expect(types(a)).toEqual(["interrupt", "block"]);
    expect(a[1]!.signal.kind).toBe("relaunch_exhausted");
  });
  it("une relance d'un autre rôle ne compte pas pour ce rôle", () => {
    expect(types(run({ verdicts: [verdict("restart")], line: { relaunches_by_agent: { testeur: 1 } } }))).toEqual(["interrupt", "relaunch"]);
  });
  it("seconde interruption : block (second_interruption)", () => {
    const a = run({ verdicts: [verdict("restart")], line: { interruptions: 1 } });
    expect(types(a)).toEqual(["interrupt", "block"]);
    expect(a[1]!.signal.kind).toBe("second_interruption");
  });
  it("un seul block par ligne même avec plusieurs agents", () => {
    const a = run({
      agents: [agent(), agent({ instance_id: "t-1", role: "testeur" })],
      verdicts: [verdict("escalate"), { ...verdict("escalate"), instance_id: "t-1" }],
    });
    expect(types(a)).toEqual(["interrupt", "interrupt", "block"]);
  });
});

describe("kill automatique §4.5 -> system_kill", () => {
  const kill = (o: Over, kind: string) => {
    const a = run(o);
    expect(types(a)).toEqual(["system_kill"]);
    expect(a[0]).toMatchObject({ scope: "phase", signal: { kind } });
  };
  it("kill switch fichier : global, prioritaire, aucune relance", () => {
    const a = run({ kill: true, verdicts: [verdict("restart")], agent: { tool_calls_since_commit: 99 } });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: "system_kill", scope: "global", signal: { kind: "kill_switch_file" } });
  });
  it("violation de permission", () => kill({ phase: { permission_violation: true } }, "permission_violation"));
  it("plafond de tokens de phase : >= budget x 1.3", () => {
    expect(run({ phase: { tokens_budget: 1000, tokens_used: 1299 } })).toEqual([]);
    kill({ phase: { tokens_budget: 1000, tokens_used: 1300 } }, "phase_budget_ceiling");
  });
  it("interruptions/heure : > 3", () => {
    expect(run({ phase: { interruptions_last_hour: 3 } })).toEqual([]);
    kill({ phase: { interruptions_last_hour: 4 } }, "interruptions_per_hour");
  });
  it("lignes looping/heure : > 3", () => {
    expect(run({ phase: { looping_lines_last_hour: 3 } })).toEqual([]);
    kill({ phase: { looping_lines_last_hour: 4 } }, "looping_lines_per_hour");
  });
  it("taux d'échec CI : > 60 % sur 20 lignes", () => {
    expect(run({ phase: { ci_runs_in_window: 20, ci_failures_in_window: 12 } })).toEqual([]);
    kill({ phase: { ci_runs_in_window: 20, ci_failures_in_window: 13 } }, "ci_failure_rate");
  });
  it("taux d'échec CI : fenêtre incomplète = pas de kill", () => {
    expect(run({ phase: { ci_runs_in_window: 19, ci_failures_in_window: 19 } })).toEqual([]);
  });
  it("coût/heure : désactivé si null, > seuil sinon", () => {
    expect(run({ phase: { cost_last_hour_usd: 1e6 } })).toEqual([]);
    const cfg = { ...config, kill: { ...config.kill, cost_per_hour_usd_max: 10 } };
    expect(run({ config: cfg, phase: { cost_last_hour_usd: 10 } })).toEqual([]);
    kill({ config: cfg, phase: { cost_last_hour_usd: 10.01 } }, "cost_per_hour");
  });
  it("kill de phase prioritaire sur les actions de ligne, même ligne done", () => {
    const a = run({ phase: { permission_violation: true }, verdicts: [verdict("stop")], line: { status: "done" } });
    expect(types(a)).toEqual(["system_kill"]);
  });
});

describe("scénario complet : agent qui boucle", () => {
  it("warn -> assess_request -> interrupt+relaunch -> seconde interruption -> block", () => {
    // t0 : 21 appels d'outils sans commit
    const t0 = decide(mk({ agent: { tool_calls_since_commit: 21 } }));
    expect(types(t0)).toEqual(["warn"]);
    // t0 + 30 s : le warn est connu (warn_since_ms posé), rien de nouveau
    expect(decide(mk({ now: NOW + 30_000, agent: { tool_calls_since_commit: 25, warn_since_ms: NOW } }))).toEqual([]);
    // t0 + 10 min : persistance
    const t1 = decide(mk({ now: NOW + 10 * MIN, agent: { tool_calls_since_commit: 30, warn_since_ms: NOW, last_event_at_ms: NOW + 10 * MIN - 5000 } }));
    expect(types(t1)).toEqual(["assess_request"]);
    // le Dépanneur dit restart
    const t2 = decide(mk({ now: NOW + 11 * MIN, agent: { tool_calls_since_commit: 33, warn_since_ms: NOW, last_event_at_ms: NOW + 11 * MIN - 5000 },
      verdicts: [{ ...verdict("restart"), received_at_ms: NOW + 11 * MIN }] }));
    expect(types(t2)).toEqual(["interrupt", "relaunch"]);
    expect(t2[1]).toMatchObject({ change: { kind: "reduce_context" } });
    // nouvelle instance, compteurs mis à jour par le noyau ; elle reboucle
    const later = NOW + 40 * MIN;
    const second = decide(mk({
      now: later, line: { interruptions: 1, relaunches_by_agent: { implementeur: 1 } },
      agent: { instance_id: "impl-2", tool_calls_since_commit: 30, warn_since_ms: later - 10 * MIN, last_event_at_ms: later - 1000 },
      verdicts: [{ ...verdict("stop"), instance_id: "impl-2" }],
    }));
    expect(types(second)).toEqual(["interrupt", "block"]);
  });
});

describe("pureté", () => {
  const rich = mk({
    agent: { tool_calls_since_commit: 41 },
    line: { recent_diffs: [diff("a"), diff("a")], interruptions: 1 },
    verdicts: [verdict("restart")],
  });
  it("même entrée deux fois = même sortie", () => expect(decide(rich)).toEqual(decide(rich)));
  it("entrée gelée : aucune mutation, aucune exception", () => {
    const frozen = deepFreeze(structuredClone(rich));
    expect(() => decide(frozen)).not.toThrow();
    expect(decide(frozen)).toEqual(decide(rich));
  });
  it("entrée inchangée (comparaison à un clone)", () => {
    const clone = structuredClone(rich);
    decide(rich);
    expect(rich).toEqual(clone);
  });
  it("ne lit pas l'horloge système", () => {
    const base = mk({ ...idle(20 * MIN) });
    const spy = Date.now;
    Date.now = () => { throw new Error("horloge système lue"); };
    try { expect(types(decide(base))).toEqual(["warn"]); } finally { Date.now = spy; }
  });
});
