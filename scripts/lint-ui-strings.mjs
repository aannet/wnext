#!/usr/bin/env node
// Lint « aucune chaîne visible en dur » dans apps/web (ADR-002 §4, réserve (b) d'ADR-005) : un texte JSX contenant
// une lettre, ou un attribut lu par l'utilisateur ou un lecteur d'écran (title, aria-label, placeholder, alt...)
// écrit en littéral, est refusé. Le texte vient du catalogue i18n (apps/web/src/i18n). Parse avec oxc-parser.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";

const here = dirname(fileURLToPath(import.meta.url));
const VISIBLE_ATTRS = new Set(["title", "aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "placeholder", "alt", "label"]);
const LETTER = /\p{L}/u;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") yield* walk(p); }
    else if (e.name.endsWith(".tsx")) yield p;
  }
}

/** Chaînes visibles en dur d'un fichier : [{ line, text }]. */
export function findUiStrings(file, source) {
  const { program } = parseSync(file, source);
  const lineOf = (pos) => source.slice(0, pos).split("\n").length;
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (node.type === "JSXText" && LETTER.test(node.value)) {
      const text = node.value.trim();
      found.push({ line: lineOf(node.start + node.value.indexOf(text)), text });
    } else if (node.type === "JSXAttribute" && node.name?.type === "JSXIdentifier" && VISIBLE_ATTRS.has(node.name.name)
               && node.value?.type === "Literal" && LETTER.test(String(node.value.value))) {
      found.push({ line: lineOf(node.value.start), text: String(node.value.value) });
    }
    for (const [k, v] of Object.entries(node)) if (k !== "parent" && v && typeof v === "object") visit(v);
  };
  visit(program);
  return found;
}

export function lintUiStrings({ root = resolve(here, "..") } = {}) {
  const out = [];
  for (const file of walk(join(root, "apps/web/src"))) {
    for (const v of findUiStrings(file, readFileSync(file, "utf8"))) out.push({ file: relative(root, file).split(sep).join("/"), ...v });
  }
  return out;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const v = lintUiStrings();
  for (const x of v) console.error(`${x.file}:${x.line}: chaîne en dur « ${x.text} » (passer par le catalogue i18n)`);
  console.log(v.length ? `${v.length} chaîne(s) en dur` : "chaînes de l'interface OK");
  process.exit(v.length ? 1 : 0);
}
