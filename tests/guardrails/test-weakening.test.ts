import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { checkTestWeakening } from "../../scripts/guardrails/test-weakening.mjs";
import { cleanup, makeRepo, type Files } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "scripts", "guardrails", "test-weakening.mjs");

const BASE = `import { it, expect } from "vitest";
it("a", () => {
  expect(add(1, 2)).toBe(3);
  expect(list()).toEqual([1]);
  expect(pi()).toBeCloseTo(3.14159, 5);
});
`;
const T = "tests/a.test.ts";
const repos: string[] = [];
afterEach(() => repos.splice(0).forEach(cleanup));

function run(change: Files, opts: { labels?: string; base?: Files } = {}) {
  const dir = makeRepo({ [T]: BASE, "src/x.ts": "export const x = 1;\n", ...opts.base }, change);
  repos.push(dir);
  return { dir, res: checkTestWeakening({ cwd: dir, base: "main", labels: opts.labels ?? "" }) };
}
const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);

describe("test-weakening : cas fautifs", () => {
  it("assertion expect supprimee", () => {
    const { res } = run({ [T]: BASE.replace("  expect(list()).toEqual([1]);\n", "") });
    expect(res.ok).toBe(false);
    expect(rules(res)).toContain("expect-removed");
  });
  it("fichier de test supprime", () => {
    const { res } = run({ [T]: null });
    expect(rules(res)).toContain("expect-removed");
  });
  it("toBe -> toBeTruthy", () => {
    const { res } = run({ [T]: BASE.replace("toBe(3)", "toBeTruthy()") });
    expect(rules(res)).toContain("matcher-weakened");
  });
  it("toEqual -> toBeDefined", () => {
    const { res } = run({ [T]: BASE.replace("toEqual([1])", "toBeDefined()") });
    expect(rules(res)).toContain("matcher-weakened");
  });
  it("toStrictEqual -> toBeFalsy", () => {
    const { res } = run({ [T]: BASE.replace("toEqual([1])", "toStrictEqual([1])") }, {});
    expect(res.ok).toBe(true);
    const r2 = run(
      { [T]: BASE.replace("toEqual([1])", "toStrictEqual([1])") },
      { base: { [T]: BASE.replace("toEqual([1])", "toStrictEqual([1])") } },
    );
    expect(r2.res.ok).toBe(true);
    const r3 = run(
      { [T]: BASE.replace("toEqual([1])", "toBeFalsy()") },
      { base: { [T]: BASE.replace("toEqual([1])", "toStrictEqual([1])") } },
    );
    expect(rules(r3.res)).toContain("matcher-weakened");
  });
  it.each([
    ['it.skip("b", () => {});', "skip-added"],
    ['it.only("b", () => {});', "skip-added"],
    ['it.todo("b");', "skip-added"],
    ['describe.skip("b", () => {});', "skip-added"],
    ['xit("b", () => {});', "skip-added"],
    ['xdescribe("b", () => {});', "skip-added"],
  ])("marqueur ajoute : %s", (line, rule) => {
    const { res } = run({ [T]: BASE + line + "\n" });
    expect(rules(res)).toContain(rule);
  });
  it("toBeCloseTo avec precision reduite", () => {
    const { res } = run({ [T]: BASE.replace("3.14159, 5", "3.14159, 1") });
    expect(rules(res)).toContain("tolerance-widened");
  });
  it("toBeCloseTo precision par defaut (2) apres precision explicite", () => {
    const { res } = run({ [T]: BASE.replace("3.14159, 5", "3.14159") });
    expect(rules(res)).toContain("tolerance-widened");
  });
  it("fichier snapshot modifie", () => {
    const snap = "tests/__snapshots__/a.test.ts.snap";
    const { res } = run({ [snap]: "exports[`a 1`] = `new`;\n" }, { base: { [snap]: "exports[`a 1`] = `old`;\n" } });
    expect(rules(res)).toContain("snapshot-modified");
  });
  it("snapshot inline modifie", () => {
    const b = BASE + 'it("s", () => { expect(f()).toMatchInlineSnapshot(`"old"`); });\n';
    const { res } = run({ [T]: b.replace('"old"', '"new"') }, { base: { [T]: b } });
    expect(rules(res)).toContain("snapshot-modified");
  });
  it("fonctionne avec une base de type origin/main inexistante : retombe sur main", () => {
    const dir = makeRepo({ [T]: BASE }, { [T]: BASE.replace("toBe(3)", "toBeTruthy()") });
    repos.push(dir);
    const r = checkTestWeakening({ cwd: dir, labels: "" });
    expect(r.ok).toBe(false);
  });
});

describe("test-weakening : cas sains et derogation", () => {
  it("ajout d'assertions et de tests : OK", () => {
    const { res } = run({ [T]: BASE + 'it("b", () => { expect(1).toBe(1); expect(pi()).toBeCloseTo(3.1, 5); });\n' });
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });
  it("renforcement toBeTruthy -> toBe : OK", () => {
    const { res } = run(
      { [T]: BASE },
      { base: { [T]: BASE.replace("toBe(3)", "toBeTruthy()") } },
    );
    expect(res.ok).toBe(true);
  });
  it("modification hors tests/ ignoree", () => {
    const { res } = run({ "src/x.ts": "export const x = 2; // expect(1).toBe(1)\n" });
    expect(res.ok).toBe(true);
  });
  it("reformatage sans effet sur les assertions : OK", () => {
    const { res } = run({ [T]: BASE.replace("expect(add(1, 2)).toBe(3);", "expect(\n add(1, 2),\n).toBe(3);") });
    expect(res.ok).toBe(true);
  });
  it("PR_LABELS contenant test-change-approved leve l'echec", () => {
    const { res } = run({ [T]: BASE.replace("toBe(3)", "toBeTruthy()") }, { labels: "bug, test-change-approved" });
    expect(res.ok).toBe(true);
    expect(res.waived).toBe(true);
    expect(res.violations.length).toBeGreaterThan(0);
  });
  it("un label au nom voisin ne leve pas l'echec", () => {
    const { res } = run({ [T]: BASE.replace("toBe(3)", "toBeTruthy()") }, { labels: "test-change-approved-not" });
    expect(res.ok).toBe(false);
  });
});

describe("test-weakening : CLI", () => {
  it("code 1 sur cas fautif, 0 sur cas sain, 0 avec label", () => {
    const bad = makeRepo({ [T]: BASE }, { [T]: BASE.replace("toBe(3)", "toBeTruthy()") });
    const good = makeRepo({ [T]: BASE }, { [T]: BASE + "\n// ok\n" });
    repos.push(bad, good);
    const cli = (cwd: string, labels = "") =>
      spawnSync("node", [script, "--root", cwd, "--base", "main"], { env: { ...process.env, PR_LABELS: labels }, encoding: "utf8" });
    expect(cli(bad).status).toBe(1);
    expect(cli(good).status).toBe(0);
    expect(cli(bad, "test-change-approved").status).toBe(0);
  });
});
