#!/usr/bin/env node
// Garde-fou : taille de PR (strategy.md §4.6 pt 9). Echec si ajouts + suppressions > 400 lignes,
// hors lockfiles, fichiers generes (GENERATED, configurable) et fixtures de tests.
import { git, globToRegExp, isMain, parseArgs, resolveBase } from "./lib.mjs";

export const MAX_LINES = 400;
// Fichiers generes exclus du decompte (globs relatifs a la racine du depot). A completer.
export const GENERATED = ["**/*.generated.*", "packages/contracts/openapi.json", "packages/contracts/generated/**"];
// Toujours exclus, non configurable : lockfiles et fixtures de tests.
const ALWAYS_IGNORED = ["**/package-lock.json", "tests/**/fixtures/**"];

export function checkPrSize({ cwd = process.cwd(), base, max = MAX_LINES, generated = GENERATED } = {}) {
  const from = resolveBase(cwd, base);
  const out = git(cwd, ["diff", "--numstat", "--no-renames", from, "HEAD"]);
  const ignored = [...ALWAYS_IGNORED, ...generated].map(globToRegExp);
  let total = 0;
  const files = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (ignored.some((re) => re.test(file))) continue;
    const n = (a === "-" ? 0 : Number(a)) + (d === "-" ? 0 : Number(d)); // binaire : "-"
    total += n;
    files.push({ file, lines: n });
  }
  files.sort((x, y) => y.lines - x.lines);
  return { ok: total <= max, total, max, files };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = checkPrSize({ cwd: args.root ?? process.cwd(), base: args.base === true ? undefined : args.base, max: args.max ? Number(args.max) : MAX_LINES });
  if (r.ok) console.log(`pr-size : ${r.total}/${r.max} lignes, OK`);
  else {
    console.error(`pr-size : ${r.total} lignes modifiees > ${r.max}. Decouper la PR. Plus gros fichiers :`);
    for (const f of r.files.slice(0, 5)) console.error(`  ${f.lines}\t${f.file}`);
    process.exit(1);
  }
}
