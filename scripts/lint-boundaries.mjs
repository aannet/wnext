#!/usr/bin/env node
// Lint de frontieres du monorepo. Parse chaque fichier de chaque paquet (oxc-parser,
// independant de l'API JS de TypeScript 7) et verifie ses imports contre boundaries.config.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";
import defaultConfig from "../boundaries.config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function* walk(dir, cfg) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!cfg.ignoreDirs.includes(e.name)) yield* walk(p, cfg);
    } else if (cfg.extensions.includes(extname(e.name)) && !e.name.endsWith(".d.ts")) {
      yield p;
    }
  }
}

// Specifiers d'un fichier : imports/exports statiques (AST) + import("x") / require("x")
// litteraux (regex, couvre aussi les types `import("x").T`). Sur-detecte plutot que de rater.
export function extractSpecifiers(file, source) {
  const found = new Set();
  const { module: m } = parseSync(file, source);
  for (const i of m.staticImports) found.add(i.moduleRequest.value);
  for (const x of m.staticExports) {
    for (const en of x.entries) if (en.moduleRequest) found.add(en.moduleRequest.value);
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g)) {
    found.add(match[2]);
  }
  return [...found];
}

function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function check(spec, owner, pkgDir, file, cfg) {
  const { rule, monorepo, external } = owner;
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const target = resolve(dirname(file), spec);
    const rel = relative(pkgDir, target);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      return ["no-package-escape", "l'import relatif sort du paquet"];
    }
    return null;
  }
  const name = packageName(spec);
  if (name.startsWith(cfg.scope)) {
    if (!monorepo.includes(name)) return [rule, `${name} n'est pas importable ici (autorises : ${monorepo.join(", ") || "aucun"})`];
    if (spec !== name) return ["no-deep-import", `import profond ${spec} : n'importer que ${name}`];
    return null;
  }
  if (cfg.monorepoRoots.some((r) => spec.startsWith(r))) {
    return [rule, "import nu vers un dossier du monorepo"];
  }
  if (external && !external.includes(name)) {
    return [owner.externalRule, `dependance externe ${name} interdite (autorisees : ${external.join(", ")})`];
  }
  return null;
}

export function lintBoundaries({ root = resolve(here, ".."), config = defaultConfig } = {}) {
  const cfg = config;
  const violations = [];
  for (const owner of Object.values(cfg.packages)) {
    const pkgDir = join(root, owner.dir);
    for (const file of walk(pkgDir, cfg)) {
      const source = readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(file, source)) {
        const res = check(spec, owner, pkgDir, file, cfg);
        if (res) {
          violations.push({ file: relative(root, file).split(sep).join("/"), specifier: spec, rule: res[0], message: res[1] });
        }
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? resolve(process.argv[i + 1]) : resolve(here, "..");
  const v = lintBoundaries({ root });
  for (const x of v) console.error(`${x.file}: [${x.rule}] "${x.specifier}" - ${x.message}`);
  console.log(v.length ? `${v.length} violation(s) de frontieres` : "frontieres OK");
  process.exit(v.length ? 1 : 0);
}
