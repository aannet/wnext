import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUPERVISION_PATH, SupervisionConfigError, loadSupervisionConfig, parseSupervisionConfig } from "../src/config";

const text = readFileSync(DEFAULT_SUPERVISION_PATH, "utf8");
const withLine = (from: string, to: string) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};

describe("supervision.yaml : valeurs par défaut conformes à strategy.md", () => {
  const c = loadSupervisionConfig();
  it("§4.8 signaler / évaluer / interrompre / relancer", () => {
    expect(c.supervisor).toEqual({ tick_s: 30, heartbeat_alert_s: 120 });
    expect(c.warn).toEqual({ idle_without_commit_min: 15, tool_calls_without_commit: 20, identical_llm_calls: 2 });
    expect(c.assess).toEqual({ persistence_min: 10, mute_agent_min: 5 });
    expect(c.interrupt.no_progress_min).toBe(45);
    expect(c.relaunch).toEqual({ max_per_agent_and_line: 1, max_f_escalations_per_line: 1, block_at_interruption: 2 });
  });
  it("§4.3 retries bornés", () => {
    expect(c.retries).toMatchObject({ max_cycles_total: 5, max_cycles_per_model: 2, max_review_returns: 2, max_wall_clock_min: 180, line_budget_factor: 3 });
  });
  it("§4.4 détection de boucle", () => {
    expect(c.loop).toEqual({
      diff_repeat_consecutive: 2, diff_similarity: 0.9, error_signature_repeats: 3, oscillation_enabled: true,
      tool_calls_without_commit: 40, tokens_per_changed_line_ratio: 5, budget_fraction_without_green_gain: 0.5,
    });
  });
  it("§4.5 et §1 kill-switch automatique", () => {
    expect(c.kill).toMatchObject({
      stop_deadline_s: 30, phase_budget_alert_ratio: 0.8, phase_budget_ceiling_factor: 1.3,
      looping_lines_per_hour_max: 3, interruptions_per_hour_max: 3, ci_failure_rate_max: 0.6, ci_failure_window_lines: 20,
    });
    expect(c.kill.cost_per_hour_usd_max).toBeNull();
  });
  it("chaque seuil est commenté et cite un § / ADR (sur sa ligne ou l'en-tête de sa section)", () => {
    let header = "";
    const bad: string[] = [];
    for (const l of text.split("\n")) {
      if (/^[a-z_]+:\s*(#.*)?$/.test(l)) header = l;
      else if (/^ {2}[a-z_]+: /.test(l)) {
        if (!/#/.test(l) || !/§|ADR-00/.test(l + header)) bad.push(l.trim());
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("validation", () => {
  it("refuse une clé inconnue (racine et imbriquée)", () => {
    expect(() => parseSupervisionConfig(text + "\nsurprise: 1\n")).toThrow(SupervisionConfigError);
    expect(() => parseSupervisionConfig(withLine("  tick_s: 30 ", "  tick_s: 30\n  inconnue: 1 "))).toThrow(/inconnue|Unrecognized/i);
  });
  it("refuse un nombre négatif", () => {
    expect(() => parseSupervisionConfig(withLine("no_progress_min: 45", "no_progress_min: -1"))).toThrow(SupervisionConfigError);
    expect(() => parseSupervisionConfig(withLine("cost_per_hour_usd_max: null", "cost_per_hour_usd_max: -5"))).toThrow(SupervisionConfigError);
  });
  it("refuse un type invalide, un ratio > 1, une clé manquante, un YAML cassé", () => {
    expect(() => parseSupervisionConfig(withLine("diff_similarity: 0.9", "diff_similarity: 1.5"))).toThrow(SupervisionConfigError);
    expect(() => parseSupervisionConfig(withLine("tick_s: 30", "tick_s: abc"))).toThrow(SupervisionConfigError);
    expect(() => parseSupervisionConfig(withLine("  tick_s: 30", "  #"))).toThrow(/tick_s/);
    expect(() => parseSupervisionConfig("a: [")).toThrow(SupervisionConfigError);
  });
  it("accepte un seuil de coût chiffré", () => {
    expect(parseSupervisionConfig(withLine("cost_per_hour_usd_max: null", "cost_per_hour_usd_max: 40")).kill.cost_per_hour_usd_max).toBe(40);
  });
});
