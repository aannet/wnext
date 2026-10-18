#!/usr/bin/env node
// Sentinelle anti-affaiblissement (strategy.md §4.6 pt 3). Compare, pour chaque fichier de test
// touche (tests/** et *.test.ts), l'AST de la base et celui de HEAD (oxc-parser).
//
// Derogation : la variable d'env PR_LABELS (liste de labels de la PR, fournie par la CI) contient
// `test-change-approved`. Ce label ne doit etre pose que par un humain (droits de triage requis ;
// la CI ne doit jamais le deduire ni laisser un agent le poser). Les violations sont alors
// affichees mais le code de sortie est 0.
import { parseSync } from "oxc-parser";
import { git, isMain, parseArgs, resolveBase } from "./lib.mjs";

export const WAIVER_LABEL = "test-change-approved";
const STRONG = new Set(["toBe", "toEqual", "toStrictEqual"]);
const WEAK = new Set(["toBeTruthy", "toBeDefined", "toBeFalsy"]);
const SKIPS = new Set(["skip", "only", "todo", "skipIf"]);
const X_FNS = new Set(["xit", "xdescribe", "xtest"]);
const SNAP_MATCHERS = new Set(["toMatchInlineSnapshot", "toMatchSnapshot", "toThrowErrorMatchingInlineSnapshot"]);

const inScope = (f) => f.startsWith("tests/") || /\.test\.[cm]?[jt]sx?$/.test(f);
const isSnap = (f) => f.endsWith(".snap");

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const k of Object.keys(node)) {
    if (k === "parent" || k === "loc") continue;
    const v = node[k];
    if (v && typeof v === "object") walk(v, visit);
  }
}

const name = (n) => (n?.type === "Identifier" ? n.name : n?.type === "Literal" && typeof n.value === "string" ? n.value : null);

// Metriques d'un fichier de test.
export function analyze(file, source) {
  const m = { expects: 0, strong: 0, weak: 0, skips: 0, precisions: [], inlineSnaps: [] };
  if (source == null) return m;
  const { program } = parseSync(file, source);
  walk(program, (n) => {
    if (n.type === "CallExpression") {
      const c = n.callee;
      if (c.type === "Identifier" && c.name === "expect") m.expects++;
      else if (c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "expect" && ["soft", "poll"].includes(name(c.property))) m.expects++;
      if (c.type === "MemberExpression") {
        const p = name(c.property);
        if (STRONG.has(p)) m.strong++;
        if (WEAK.has(p)) m.weak++;
        if (p === "toBeCloseTo") {
          const a = n.arguments[1];
          m.precisions.push(!a ? 2 : a.type === "Literal" && typeof a.value === "number" ? a.value : Infinity);
        }
        if (SNAP_MATCHERS.has(p)) m.inlineSnaps.push(n.arguments.map((a) => source.slice(a.start, a.end)).join(","));
      }
      if (c.type === "Identifier" && X_FNS.has(c.name)) m.skips++;
    }
    if (n.type === "MemberExpression" && SKIPS.has(name(n.property)) && !n.computed) m.skips++;
  });
  m.precisions.sort((a, b) => b - a);
  return m;
}

export function compareFiles(file, oldSrc, newSrc) {
  const v = [];
  const add = (rule, detail) => v.push({ file, rule, detail });
  if (isSnap(file)) {
    if (oldSrc != null && oldSrc !== newSrc) add("snapshot-modified", newSrc == null ? "fichier snapshot supprime" : "fichier snapshot modifie");
    return v;
  }
  const o = analyze(file, oldSrc);
  const n = analyze(file, newSrc);
  if (n.expects < o.expects) add("expect-removed", `${o.expects} -> ${n.expects} assertions expect()`);
  if (n.weak > o.weak && n.strong < o.strong) add("matcher-weakened", `toBe/toEqual/toStrictEqual ${o.strong} -> ${n.strong}, toBeTruthy/Defined/Falsy ${o.weak} -> ${n.weak}`);
  if (n.skips > o.skips) add("skip-added", `skip/only/todo/xit/xdescribe ${o.skips} -> ${n.skips}`);
  for (let i = 0; i < Math.min(o.precisions.length, n.precisions.length); i++) {
    if (n.precisions[i] < o.precisions[i]) {
      add("tolerance-widened", `toBeCloseTo : precision ${o.precisions[i]} -> ${n.precisions[i]}`);
      break;
    }
  }
  if (oldSrc != null && o.inlineSnaps.some((s) => !n.inlineSnaps.includes(s))) add("snapshot-modified", "snapshot inline modifie ou supprime");
  return v;
}

const show = (cwd, ref, file) => {
  try {
    return git(cwd, ["show", `${ref}:${file}`]);
  } catch {
    return null; // absent a cette revision
  }
};

export function checkTestWeakening({ cwd = process.cwd(), base, labels = process.env.PR_LABELS ?? "" } = {}) {
  const from = resolveBase(cwd, base);
  const files = git(cwd, ["diff", "--name-only", "--no-renames", "-z", from, "HEAD"]).split("\0").filter(Boolean).filter(inScope);
  const violations = [];
  for (const f of files) {
    const oldSrc = show(cwd, from, f);
    if (oldSrc == null) continue; // fichier ajoute : rien a affaiblir
    const newSrc = show(cwd, "HEAD", f);
    const isCode = /\.[cm]?[jt]sx?$/.test(f);
    if (!isCode && !isSnap(f)) continue;
    violations.push(...compareFiles(f, oldSrc, newSrc));
  }
  const waived = violations.length > 0 && labels.split(/[\s,]+/).includes(WAIVER_LABEL);
  return { ok: violations.length === 0 || waived, waived, violations };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = checkTestWeakening({ cwd: args.root ?? process.cwd(), base: args.base === true ? undefined : args.base });
  for (const v of r.violations) console.error(`${v.file}: [${v.rule}] ${v.detail}`);
  if (r.waived) console.error(`test-weakening : derogation (label ${WAIVER_LABEL}, pose par un humain)`);
  else if (!r.ok) {
    console.error(`test-weakening : echec. Seul un humain peut poser le label ${WAIVER_LABEL}.`);
    process.exit(1);
  } else console.log("test-weakening : OK");
}
