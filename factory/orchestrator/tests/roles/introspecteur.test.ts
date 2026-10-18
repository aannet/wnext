import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntrospecteurDeterministe, MAX_ACTIVE_RULES } from "../../src/roles/introspecteur";
import { loadSupervisionConfig } from "../../src/config";
import type { FactoryEvent } from "../../src/types";
import { ev } from "./fixtures";
import { DRY_LINE, DRY_PHASE, dryRunEvents } from "./fixtures/dry-run";

const config = loadSupervisionConfig();
const LINE_CYCLE = (id: string) => ({ kind: "line" as const, id, phase: "P1" as const });

/** Ligne avec 1 échec CI au premier passage, 1 retry, 1 changement de modèle. */
function oneLine(line: string, extra: Partial<FactoryEvent>[] = []): FactoryEvent[] {
  return [
    ev(0, { line, phase: "P1", model: "claude-haiku-5-5" }),
    ev(1, { line, phase: "P1", action: "ci.result", status: "error", detail: { tests_green: false, error_signature: "s" } }),
    ev(2, { line, phase: "P1", action: "retry.start", status: "retry" }),
    ev(3, { line, phase: "P1", model: "claude-sonnet-5-5" }),
    ...extra.map((x, i) => ev(4 + i, { line, phase: "P1", ...x })),
  ];
}

describe("Introspecteur : fichier de sortie et garde-fous d'écriture", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "retro-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("écrit docs/factory/retro/<cycle>.md dans retroDir et retourne son chemin", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config }).run(LINE_CYCLE("P1-017"), oneLine("P1-017"));
    expect(p).toBe(join(dir, "P1-017.md"));
    expect(readdirSync(dir)).toEqual(["P1-017.md"]);
  });

  it.each(["../evil", "P9-001", "P1-17", "P1-017/../../x", ""])("refuse l'identifiant de cycle %j sans rien écrire", async (id) => {
    const intro = new IntrospecteurDeterministe({ retroDir: dir, config });
    await expect(intro.run(LINE_CYCLE(id), [])).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("n'utilise que les événements du cycle : une ligne ne voit pas les autres", async () => {
    const events = [...oneLine("P1-017"), ...oneLine("P1-018")];
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 1_000_000_000 })
      .run(LINE_CYCLE("P1-017"), events);
    expect(readFileSync(p, "utf8")).not.toContain("P1-018");
  });

  it("le budget d'introspection est écrit à 0 token (déterministe)", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config }).run(LINE_CYCLE("P1-017"), oneLine("P1-017"));
    expect(readFileSync(p, "utf8")).toMatch(/Budget d'introspection\s*:\s*0 token/);
  });
});

describe("Introspecteur : seuils de retenue des constats (§4.9)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "retro-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("un constat isolé, sans coût notable, n'est pas retenu : « aucun constat retenu »", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 1_000_000_000 })
      .run(LINE_CYCLE("P1-017"), oneLine("P1-017"));
    const text = readFileSync(p, "utf8");
    expect(text).toContain("aucun constat retenu");
    expect(text).not.toMatch(/^- \*\*C\d+\*\*/m);
    expect(text).not.toMatch(/^### R\d+/m);
  });

  it("un constat répété (échec CI au premier passage sur 2 lignes) est retenu avec sa recommandation", async () => {
    const events = [...oneLine("P1-017"), ...oneLine("P1-018")];
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 1_000_000_000 })
      .run({ kind: "phase", id: "P1", phase: "P1" }, events);
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/^- \*\*C\d+\*\*.*premier passage/m);
    expect(text).toContain("make check");
    expect(text).toContain("CLAUDE.md");
  });

  it("un constat de coût > 5 % du budget de phase est retenu même sans répétition", async () => {
    const big = [ev(0, { line: "P1-017", tokens_in: 60_000, tokens_out: 0 })];
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 1_000_000 })
      .run(LINE_CYCLE("P1-017"), big);
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/^- \*\*C\d+\*\*.*[Cc]oût/m);
    expect(text).toContain("retries.line_budget_factor");
    expect(text).toContain("3 -> 2");
  });

  it("sans budget de phase fourni, le critère de coût est désactivé et le dit", async () => {
    const big = [ev(0, { line: "P1-017", tokens_in: 60_000, tokens_out: 0 })];
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config }).run(LINE_CYCLE("P1-017"), big);
    expect(readFileSync(p, "utf8")).toContain("budget de phase non fourni");
  });
});

describe("Introspecteur : bornes (<= 3 constats, <= 3 recommandations, <= 15 règles actives)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "retro-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Tous les constats possibles se répètent, et le coût dépasse 5 % : plus de 3 candidats. */
  const busy = (): FactoryEvent[] => [
    ...oneLine("P1-017"), ...oneLine("P1-018"),
    ...oneLine("P1-019"),
  ];

  it("au plus 3 constats et 3 recommandations, chacune avec ses 4 champs", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 10_000 })
      .run({ kind: "phase", id: "P1", phase: "P1" }, busy());
    const text = readFileSync(p, "utf8");
    const constats = text.match(/^- \*\*C\d+\*\*/gm) ?? [];
    const recs = text.match(/^### R\d+/gm) ?? [];
    expect(constats.length).toBeGreaterThan(0);
    expect(constats.length).toBeLessThanOrEqual(3);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(3);
    const blocks = text.split(/^### R\d+/m).slice(1);
    for (const b of blocks) {
      expect(b).toContain("Constat source");
      expect(b).toContain("Changement exact");
      expect(b).toContain("Métrique §6.2");
      expect(b).toContain("Retour arrière");
    }
  });

  it("plafond de règles actives : 14 actives laissent 1 recommandation au plus", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 10_000, activeRules: 14 })
      .run({ kind: "phase", id: "P1", phase: "P1" }, busy());
    expect((readFileSync(p, "utf8").match(/^### R\d+/gm) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("plafond atteint (15 règles actives) : aucune recommandation, et le dit", async () => {
    expect(MAX_ACTIVE_RULES).toBe(15);
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 10_000, activeRules: 15 })
      .run({ kind: "phase", id: "P1", phase: "P1" }, busy());
    const text = readFileSync(p, "utf8");
    expect(text).not.toMatch(/^### R\d+/m);
    expect(text).toContain("plafond de 15 règles actives");
  });
});

describe("Introspecteur : rétro du run factice (fixture dry-run)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "retro-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("cycle ligne P0-900 avec budget de phase réel (25 M) : aucun constat retenu", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 25_000_000 })
      .run({ kind: "line", id: DRY_LINE, phase: "P0" }, dryRunEvents());
    expect(p).toBe(join(dir, `${DRY_LINE}.md`));
    const text = readFileSync(p, "utf8");
    expect(text).toContain(`# Rétro ${DRY_LINE}`);
    expect(text).toContain("aucun constat retenu");
  });

  it("cycle phase P0 avec un budget de phase serré : le coût de P0-900 est retenu, la ligne tuée ne l'est pas", async () => {
    const p = await new IntrospecteurDeterministe({ retroDir: dir, config, phaseBudgetTokens: 1_000_000 })
      .run({ kind: "phase", id: DRY_PHASE, phase: "P0" }, dryRunEvents());
    expect(p).toBe(join(dir, `${DRY_PHASE}.md`));
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/^- \*\*C\d+\*\*.*[Cc]oût/m);
    expect(text).toContain("retries.line_budget_factor");
    expect(text).not.toMatch(/^- \*\*C\d+\*\*.*premier passage/m);
    expect(existsSync(join(dir, "P0-901.md"))).toBe(false);
  });
});
