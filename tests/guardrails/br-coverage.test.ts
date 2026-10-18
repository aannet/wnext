import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { checkBrCoverage } from "../../scripts/guardrails/br-coverage.mjs";
import { cleanup, tmpDir } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(repoRoot, "scripts", "guardrails", "br-coverage.mjs");
const SCOPE = "scripts/guardrails/br-scope.json";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanup));
const mk = (scope: string[], files: Record<string, string>) => {
  const d = tmpDir({ [SCOPE]: JSON.stringify(scope), ...files });
  dirs.push(d);
  return d;
};

describe("br-coverage", () => {
  it("le br-scope.json livre est un tableau non vide et passe sur le repo", () => {
    const scope = JSON.parse(readFileSync(join(repoRoot, SCOPE), "utf8"));
    expect(Array.isArray(scope) && scope.length > 0).toBe(true);
    expect(checkBrCoverage({ root: repoRoot }).ok).toBe(true);
  });
  it("echoue : BR listee sans aucun test", () => {
    const r = checkBrCoverage({ root: mk(["BR-01", "BR-02"], { "tests/a.test.ts": "// @BR-01\nit('x',()=>{});\n" }) });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["BR-02"]);
  });
  it("passe : marqueur en commentaire (tests/)", () => {
    expect(checkBrCoverage({ root: mk(["BR-01"], { "tests/a.test.ts": "// @BR-01\n" }) }).ok).toBe(true);
  });
  it("passe : marqueur dans le nom du test (packages/**/*.test.ts)", () => {
    const root = mk(["BR-10"], { "packages/rules/src/deep/r.test.ts": "it('@BR-10 supprime', () => {});\n" });
    expect(checkBrCoverage({ root }).ok).toBe(true);
  });
  it("passe : marqueur dans un test d'application (apps/**/*.test.ts)", () => {
    expect(checkBrCoverage({ root: mk(["BR-33"], { "apps/api/test/a.test.ts": "// @BR-33\n" }) }).ok).toBe(true);
  });
  it("ignore un marqueur hors fichier de test dans apps/", () => {
    expect(checkBrCoverage({ root: mk(["BR-33"], { "apps/api/src/a.ts": "// @BR-33\n" }) }).ok).toBe(false);
  });
  it("BR-1 ne couvre pas BR-10 et inversement (frontiere de mot)", () => {
    const root = mk(["BR-1"], { "tests/a.test.ts": "// @BR-10\n" });
    expect(checkBrCoverage({ root }).missing).toEqual(["BR-1"]);
  });
  it("un marqueur hors tests (code applicatif, node_modules) ne compte pas", () => {
    const root = mk(["BR-01"], {
      "packages/rules/src/r.ts": "// @BR-01\n",
      "node_modules/x/a.test.ts": "// @BR-01\n",
      "packages/rules/src/notes.md": "@BR-01\n",
    });
    expect(checkBrCoverage({ root }).ok).toBe(false);
  });
  it("un marqueur sans arobase ne compte pas", () => {
    expect(checkBrCoverage({ root: mk(["BR-01"], { "tests/a.test.ts": "// BR-01\n" }) }).ok).toBe(false);
  });
  it("scope vide : OK", () => {
    expect(checkBrCoverage({ root: mk([], {}) }).ok).toBe(true);
  });
  it("scope invalide : erreur", () => {
    const root = mk(["pas-une-br" as string], {});
    expect(() => checkBrCoverage({ root })).toThrow();
  });
  it("CLI : code 1 / 0", () => {
    const bad = mk(["BR-05"], {});
    const good = mk(["BR-05"], { "tests/a.test.ts": "// @BR-05\n" });
    const cli = (root: string) => spawnSync("node", [script, "--root", root], { encoding: "utf8" });
    expect(cli(bad).status).toBe(1);
    expect(cli(good).status).toBe(0);
  });
});
