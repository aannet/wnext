import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEPANNEUR_RULES, DepanneurDeterministe } from "../../src/roles/depanneur";
import { ciErr, diff, ev, logOf } from "./fixtures";

const dep = () => new DepanneurDeterministe({ reportDir: "/unused-for-assess" });

describe("DEPANNEUR_RULES", () => {
  it("expose 8 règles aux identifiants uniques DEP-01 à DEP-08, chacune documentée", () => {
    expect(DEPANNEUR_RULES.map((r) => r.id)).toEqual([
      "DEP-01", "DEP-02", "DEP-03", "DEP-04", "DEP-05", "DEP-06", "DEP-07", "DEP-08",
    ]);
    for (const r of DEPANNEUR_RULES) expect(r.effect.length).toBeGreaterThan(10);
  });
});

describe("assess / DEP-01 stop : kill ou violation de permission", () => {
  it("stop si le journal contient un kill.triggered", async () => {
    const v = await dep().assess(logOf([ev(0), ev(1, { action: "kill.triggered", status: "killed" })]));
    expect(v.verdict).toBe("stop");
    expect(v.cause.startsWith("DEP-01")).toBe(true);
  });

  it("stop si le signal déclencheur est une violation de permission", async () => {
    const v = await dep().assess(logOf([ev(0)], { trigger: "permission_violation" }));
    expect(v.verdict).toBe("stop");
    expect(v.cause.startsWith("DEP-01")).toBe(true);
  });
});

describe("assess / DEP-02 stop : plafond de durée ou de budget de ligne", () => {
  it("stop sur wall_clock (3 h, §4.3)", async () => {
    const v = await dep().assess(logOf([ev(0), ev(5, { action: "ci.result", detail: { tests_green: true } })], { trigger: "wall_clock" }));
    expect(v.verdict).toBe("stop");
    expect(v.cause.startsWith("DEP-02")).toBe(true);
  });

  it("stop sur line_budget_ceiling même si la ligne progressait", async () => {
    const v = await dep().assess(logOf([ev(0, { action: "git.commit" })], { trigger: "line_budget_ceiling" }));
    expect(v.verdict).toBe("stop");
    expect(v.cause.startsWith("DEP-02")).toBe(true);
  });
});

describe("assess / DEP-03 escalate : modèle déjà escaladé sans progrès", () => {
  const twoModels = [
    ev(0, { model: "claude-haiku-5-5" }),
    ev(2, { model: "claude-sonnet-5-5" }),
    ev(4, { model: "claude-sonnet-5-5", action: "ci.result", status: "error", detail: { tests_green: false, error_signature: "x" } }),
  ];

  it("escalate après une montée de modèle suivie d'aucun progrès", async () => {
    const v = await dep().assess(logOf(twoModels, { trigger: "loop_tool_calls" }));
    expect(v.verdict).toBe("escalate");
    expect(v.cause.startsWith("DEP-03")).toBe(true);
  });

  it("n'escalade pas si un progrès (tests verts) suit la montée", async () => {
    const withProgress = [...twoModels, ev(6, { action: "ci.result", detail: { tests_green: true } })];
    const v = await dep().assess(logOf(withProgress, { trigger: "warn_persisted" }));
    expect(v.verdict).toBe("continue");
    expect(v.cause.startsWith("DEP-07")).toBe(true);
  });
});

describe("assess / DEP-04 restart : diff identique ou quasi identique répété", () => {
  it("restart sur le signal loop_diff_repeat sans progrès", async () => {
    const v = await dep().assess(logOf([ev(0)], { trigger: "loop_diff_repeat" }));
    expect(v.verdict).toBe("restart");
    expect(v.cause.startsWith("DEP-04")).toBe(true);
  });

  it("restart sur l'évidence du journal : deux derniers diffs de même hash", async () => {
    const v = await dep().assess(logOf([ev(0)], {
      trigger: "warn_persisted",
      state: { recent_diffs: [diff("aaa"), diff("bbb"), diff("bbb")] },
    }));
    expect(v.verdict).toBe("restart");
    expect(v.cause.startsWith("DEP-04")).toBe(true);
  });

  it("une boucle de diff l'emporte sur un progrès récent", async () => {
    const v = await dep().assess(logOf([ev(0, { action: "git.commit" }), ev(1)], {
      trigger: "warn_persisted",
      state: { recent_diffs: [diff("ccc", { similarity_to_previous: 0.95 })] },
    }));
    expect(v.verdict).toBe("restart");
    expect(v.cause.startsWith("DEP-04")).toBe(true);
  });
});

describe("assess / DEP-05 restart : même signature d'erreur CI répétée", () => {
  it("restart après 3 signatures identiques consécutives (supervision.yaml loop.error_signature_repeats)", async () => {
    const v = await dep().assess(logOf([ev(0)], {
      trigger: "warn_persisted",
      state: { recent_ci_errors: [ciErr("unit: expected 3", 1), ciErr("unit: expected 3", 2), ciErr("unit: expected 3", 3)] },
    }));
    expect(v.verdict).toBe("restart");
    expect(v.cause.startsWith("DEP-05")).toBe(true);
  });

  it("2 signatures identiques ne suffisent pas à DEP-05 (le journal progresse)", async () => {
    const v = await dep().assess(logOf([ev(0, { action: "git.commit" }), ev(1)], {
      trigger: "warn_persisted",
      state: { recent_ci_errors: [ciErr("unit: expected 3", 1), ciErr("unit: expected 3", 2)] },
    }));
    expect(v.verdict).toBe("continue");
    expect(v.cause.startsWith("DEP-07")).toBe(true);
  });
});

describe("assess / DEP-06 restart : boucle d'outils, de tokens ou d'appels identiques", () => {
  it.each(["loop_tool_calls", "loop_token_ratio", "loop_budget_no_progress", "identical_llm_calls"] as const)(
    "restart sur %s",
    async (kind) => {
      const v = await dep().assess(logOf([ev(0)], { trigger: kind }));
      expect(v.verdict).toBe("restart");
      expect(v.cause.startsWith("DEP-06")).toBe(true);
    },
  );
});

describe("assess / DEP-07 continue : progrès récent et aucune boucle", () => {
  it("continue si un progrès (commit) date de moins de 10 min du dernier événement", async () => {
    const v = await dep().assess(logOf([ev(0, { action: "git.commit" }), ev(4)], { trigger: "warn_persisted" }));
    expect(v.verdict).toBe("continue");
    expect(v.cause.startsWith("DEP-07")).toBe(true);
  });

  it("ne continue pas si le dernier progrès est ancien (> 10 min)", async () => {
    const v = await dep().assess(logOf([ev(0, { action: "git.commit" }), ev(15)], { trigger: "warn_persisted" }));
    expect(v.verdict).not.toBe("continue");
  });
});

describe("assess / DEP-08 restart : repli sans progrès ni boucle identifiée", () => {
  it("restart avec réduction de contexte pour un agent muet sans progrès", async () => {
    const v = await dep().assess(logOf([ev(0)], { trigger: "mute_agent" }));
    expect(v.verdict).toBe("restart");
    expect(v.cause.startsWith("DEP-08")).toBe(true);
    expect(v.cause).toContain("contexte réduit");
  });
});

describe("report : rapport Markdown de ligne bloquée", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "depanneur-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("écrit <line>-blocked.md dans reportDir et retourne son chemin", async () => {
    const d = new DepanneurDeterministe({ reportDir: dir });
    const p = await d.report(logOf([ev(0)], { state: { status: "blocked" } }));
    expect(p.startsWith(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual(["P1-017-blocked.md"]);
  });

  it("contient cause, dernières erreurs CI, tokens, cycles et recommandation, en français", async () => {
    const d = new DepanneurDeterministe({ reportDir: dir });
    const log = logOf(
      [ev(0), ev(3, { action: "ci.result", status: "error", detail: { tests_green: false, error_signature: "unit: expected 3" } })],
      {
        trigger: "loop_error_signature",
        state: {
          status: "blocked",
          recent_ci_errors: [ciErr("unit: expected 3", 1), ciErr("unit: expected 4", 2), ciErr("unit: expected 4", 3)],
          tokens: { used: 1234, budget: 9999, used_at_last_green_gain: 0 },
          cycles: { total: 3, by_model: { "claude-haiku-5-5": 2, "claude-sonnet-5-5": 1 } },
        },
      },
    );
    const text = readFileSync(await d.report(log), "utf8");
    expect(text).toContain("## Cause");
    expect(text).toContain("DEP-05");
    expect(text).toContain("## Dernières erreurs CI");
    expect(text).toContain("unit: expected 4");
    expect(text).toContain("1234");
    expect(text).toContain("9999");
    expect(text).toContain("3");
    expect(text).toContain("## Recommandation");
  });

  it("ne contient aucun prompt ni diff (contenu sensible exclu, §5.3)", async () => {
    const d = new DepanneurDeterministe({ reportDir: dir });
    const log = logOf([ev(0, { detail: { prompt_hash: "h1" } })], { state: { status: "blocked" } });
    const text = readFileSync(await d.report(log), "utf8");
    expect(text).not.toContain("prompt");
  });
});

