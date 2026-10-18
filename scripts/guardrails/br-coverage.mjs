#!/usr/bin/env node
// Garde-fou : matrice BR (strategy.md §4.6 pt 1). Echec si une BR de br-scope.json n'a aucun
// marqueur `@BR-xx` (commentaire ou nom de test) dans tests/, packages/**/*.test.ts ou apps/**/*.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isMain, parseArgs } from "./lib.mjs";

const SCOPE_FILE = join("scripts", "guardrails", "br-scope.json");
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const TESTS_EXT = /\.(?:[cm]?[jt]sx?|sql)$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walk(p);
    } else yield p;
  }
}

function isTestFile(rel) {
  const r = rel.split(sep).join("/");
  // tests/guardrails/ contient des marqueurs factices : exclu du decompte.
  if (r.startsWith("tests/guardrails/")) return false;
  if (r.startsWith("tests/")) return TESTS_EXT.test(r);
  return (r.startsWith("packages/") || r.startsWith("apps/")) && /\.test\.[cm]?tsx?$/.test(r);
}

export function readScope(root) {
  const scope = JSON.parse(readFileSync(join(root, SCOPE_FILE), "utf8"));
  if (!Array.isArray(scope) || !scope.every((x) => typeof x === "string" && /^BR-\d+$/.test(x))) {
    throw new Error(`${SCOPE_FILE} doit etre un tableau d'identifiants "BR-nn"`);
  }
  return scope;
}

export function checkBrCoverage({ root = process.cwd() } = {}) {
  const scope = readScope(root);
  const covered = new Set();
  if (scope.length) {
    for (const base of ["tests", "packages", "apps"]) {
      for (const file of walk(join(root, base))) {
        if (!isTestFile(relative(root, file))) continue;
        for (const m of readFileSync(file, "utf8").matchAll(/@(BR-\d+)(?!\d)/g)) covered.add(m[1]);
      }
    }
  }
  const missing = scope.filter((br) => !covered.has(br));
  return { ok: missing.length === 0, scope, missing };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = checkBrCoverage({ root: args.root ?? process.cwd() });
  if (r.ok) console.log(`br-coverage : ${r.scope.length} BR du perimetre couvertes, OK`);
  else {
    console.error(`br-coverage : BR sans test @BR-xx : ${r.missing.join(", ")}`);
    process.exit(1);
  }
}
