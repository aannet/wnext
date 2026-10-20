#!/usr/bin/env node
// Lint « aucune couleur en dur » dans apps/web/src (docs/review/ux-ui.md §3.1 : jamais de couleur en dur dans les
// composants). Une couleur littérale (#hex, rgb(), rgba(), hsl(), hsla(), oklch()... y compris dans une classe Tailwind
// arbitraire comme bg-[#3b82f6]) est refusée partout sauf dans apps/web/src/design/tokens.css, qui porte les tokens.
// Les fichiers de test sont ignorés. Ce qui ne peut pas encore migrer figure dans ALLOWLIST, avec sa raison.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TOKENS = "apps/web/src/design/tokens.css";
const EXTENSIONS = [".css", ".ts", ".tsx", ".html"];

/** Exceptions explicites : { path (relatif à la racine), reason }. Viser une liste vide. */
export const ALLOWLIST = [
  { path: "apps/web/src/schedule/block-colors.ts", reason: "calcul de contraste WCAG : il lui faut des composantes numériques (gris neutre de repli) et il rend #000000 ou #ffffff comme valeur de style en ligne" },
  { path: "apps/web/src/demo.ts", reason: "palette de projets du jeu de démo : couleurs de projet, c'est-à-dire des données (projects.color), pas des tokens" },
  { path: "apps/web/src/data/import-source.ts", reason: "couleur de projet par défaut à l'import local : donnée (projects.color), pas un token" },
];

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") yield* walk(p); }
    else if (EXTENSIONS.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) yield p;
  }
}

/** Couleurs littérales d'une source : [{ line, text }]. */
export function findRawColors(source) {
  const found = [];
  source.split("\n").forEach((lineText, i) => {
    for (const re of [HEX, FUNC]) {
      re.lastIndex = 0;
      for (const m of lineText.matchAll(re)) found.push({ line: i + 1, text: m[0] });
    }
  });
  return found.sort((a, b) => a.line - b.line);
}

export function lintRawColors({ root = resolve(here, ".."), allowlist = ALLOWLIST } = {}) {
  const allowed = new Set(allowlist.map((a) => a.path));
  const out = [];
  for (const file of walk(join(root, "apps/web/src"))) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel === TOKENS || allowed.has(rel)) continue;
    for (const v of findRawColors(readFileSync(file, "utf8"))) out.push({ file: rel, ...v });
  }
  return out;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const v = lintRawColors();
  for (const x of v) console.error(`${x.file}:${x.line}: couleur en dur « ${x.text} » (passer par un token de design/tokens.css)`);
  console.log(v.length ? `${v.length} couleur(s) en dur` : "couleurs de l'interface OK");
  process.exit(v.length ? 1 : 0);
}
