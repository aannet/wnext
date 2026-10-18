#!/usr/bin/env node
// Preuve L6 : les garde-fous ECHOUENT sur de vraies PR fautives (et passent sur les cas legitimes).
// Chaque cas tourne dans un worktree jetable (branche l6/prove-<cas>, base main), supprime a la fin.
// Ne modifie ni la branche courante, ni le repertoire principal, ni main. Aucun commit sur main.
// Usage (depuis la racine du depot) : node tests/guardrails/prove-guardrails.mjs
// Code de sortie : 0 si tous les cas donnent le resultat attendu, 1 sinon.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = mkdtempSync(join(tmpdir(), "wnext-l6-"));
const GIT_ID = ["-c", "user.name=L6 prove", "-c", "user.email=l6-prove@example.invalid", "-c", "commit.gpgsign=false"];
const WAIVER = "test-change-approved";
const created = [];
const rows = [];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function worktree(name) {
  const branch = `l6/prove-${name}`;
  const wt = join(WORK, name);
  try {
    git(ROOT, "branch", "-D", branch);
  } catch {
    // branche absente : rien a nettoyer
  }
  git(ROOT, "worktree", "add", "-q", "-b", branch, wt, "main");
  created.push({ wt, branch });
  // node_modules du depot principal (oxc-parser) ; lien non suivi par git (commit explicite des fichiers).
  symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"), "dir");
  return wt;
}

function commit(wt, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(wt, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  git(wt, "add", "--", ...Object.keys(files));
  git(wt, ...GIT_ID, "commit", "-q", "-m", msg);
  return git(wt, "rev-parse", "HEAD");
}

function run(wt, script, args, env = {}) {
  const r = spawnSync(process.execPath, [join(wt, "scripts/guardrails", script), ...args], {
    cwd: wt,
    encoding: "utf8",
    env: { ...process.env, PR_LABELS: "", ...env },
  });
  return { script, args, env, code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function summary(r) {
  const rules = [...new Set([...r.out.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))];
  if (rules.length) return `violations : ${rules.join(", ")}`;
  return r.out.split("\n")[0] || "(sortie vide)";
}

function check(cas, attendu, r, ok) {
  rows.push({ cas, attendu, obtenu: `code ${r.code} ; ${summary(r)}`, ok, r });
}

const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

const SRC_A = `import { describe, expect, it } from "vitest";

describe("exemple affaiblissement (L6)", () => {
  it("calcule la somme", () => {
    const x = 1 + 2;
    expect(x).toBe(3);
    expect(typeof x).toBe("number");
    expect([x]).toEqual([3]);
  });
});
`;

// Affaiblissement : toBe -> toBeTruthy et suppression d'un expect.
const SRC_B = `import { describe, expect, it } from "vitest";

describe("exemple affaiblissement (L6)", () => {
  it("calcule la somme", () => {
    const x = 1 + 2;
    expect(x).toBeTruthy();
    expect([x]).toEqual([3]);
  });
});
`;

const BR_TEST = `import { expect, it } from "vitest";

it("@BR-99 exemple de couverture (L6)", () => {
  expect(1 + 1).toBe(2);
});
`;

try {
  git(ROOT, "worktree", "prune");

  // Cas 1 : affaiblissement de test, base = commit A (SHA).
  {
    const wt = worktree("affaiblissement");
    const A = commit(wt, { "tests/guardrails/exemple-affaibli.test.ts": SRC_A }, "L6 commit A : base, 3 expect stricts");
    commit(wt, { "tests/guardrails/exemple-affaibli.test.ts": SRC_B }, "L6 commit B : toBe -> toBeTruthy, expect supprime");
    const r1 = run(wt, "test-weakening.mjs", ["--base", A]);
    check("1a affaiblissement, sans label", "code 1", r1, r1.code === 1);
    const r2 = run(wt, "test-weakening.mjs", ["--base", A], { PR_LABELS: WAIVER });
    check(
      `1b idem, PR_LABELS=${WAIVER}`,
      "code 0 + violations listees",
      r2,
      r2.code === 0 && /\[expect-removed\]/.test(r2.out) && /\[matcher-weakened\]/.test(r2.out),
    );
  }

  // Cas 2 : PR > 400 lignes.
  {
    const wt = worktree("taille");
    commit(wt, { "packages/demo/gros.ts": lines(500) }, "L6 : fichier source de 500 lignes");
    const r = run(wt, "pr-size.mjs", ["--base", "main"]);
    check("2a fichier src de 500 lignes (non exclu), --base main", "code 1", r, r.code === 1);
  }
  {
    const wt = worktree("fixture");
    commit(wt, { "tests/guardrails/fixtures/gros.txt": lines(500) }, "L6 : fixture de test de 500 lignes");
    const r = run(wt, "pr-size.mjs", ["--base", "main"]);
    check("2b fixture tests/**/fixtures de 500 lignes, --base main", "code 0 (exclue)", r, r.code === 0);
  }

  // Cas 3 : BR du perimetre sans test @BR-xx. br-coverage lit le perimetre et les tests du worktree
  // (il n'a pas d'option --base : le flag est ignore).
  {
    const wt = worktree("br");
    commit(wt, { "scripts/guardrails/br-scope.json": '["BR-99"]\n' }, "L6 : perimetre BR-99 sans test");
    const r1 = run(wt, "br-coverage.mjs", ["--base", "main"]);
    check("3a BR-99 dans br-scope.json, sans test @BR-99", "code 1 (BR-99 manquante)", r1, r1.code === 1 && /BR-99/.test(r1.out));
    commit(wt, { "tests/br/br99.test.ts": BR_TEST }, "L6 : test portant @BR-99");
    const r2 = run(wt, "br-coverage.mjs", ["--base", "main"]);
    check("3b idem, avec test @BR-99", "code 0", r2, r2.code === 0);
  }
} finally {
  for (const { wt, branch } of created) {
    try {
      git(ROOT, "worktree", "remove", "--force", wt);
    } catch {
      // deja retire
    }
    try {
      git(ROOT, "branch", "-D", branch);
    } catch {
      // deja supprimee
    }
  }
  git(ROOT, "worktree", "prune");
  rmSync(WORK, { recursive: true, force: true });
}

const esc = (s) => s.replace(/\|/g, "\\|");
console.log("| Cas | Attendu | Obtenu | Verdict |");
console.log("|---|---|---|---|");
for (const row of rows) console.log(`| ${esc(row.cas)} | ${esc(row.attendu)} | ${esc(row.obtenu)} | ${row.ok ? "OK" : "ECART"} |`);
console.log("\n--- sorties brutes ---");
for (const row of rows) {
  console.log(`\n### ${row.cas}\n$ node scripts/guardrails/${row.r.script} ${row.r.args.join(" ")}${Object.keys(row.r.env).length ? ` (${Object.entries(row.r.env).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}`);
  console.log(row.r.out || "(sortie vide)");
}
const allOk = rows.every((r) => r.ok);
console.log(`\nResultat : ${allOk ? "tous les cas conformes" : "ECART detecte"}`);
process.exit(allOk ? 0 : 1);
