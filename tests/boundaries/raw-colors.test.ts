// Lint « aucune couleur en dur » de apps/web/src (ux-ui.md §3.1) : les couleurs passent par les tokens de design/tokens.css.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { ALLOWLIST, findRawColors, lintRawColors } from "../../scripts/lint-raw-colors.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const find = (src: string): { line: number; text: string }[] => findRawColors(src);

function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wnext-colors-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

describe("lint des couleurs en dur", () => {
  it("le dépôt réel passe", () => {
    expect(lintRawColors({ root: repoRoot })).toEqual([]);
  });

  it("la liste blanche ne contient que des entrées motivées", () => {
    for (const a of ALLOWLIST) expect(a.reason.length).toBeGreaterThan(10);
  });

  it("refusé : hex, rgb(), rgba(), hsl(), oklch() et classe Tailwind arbitraire, avec leur ligne", () => {
    const src = ".a { color: #fff; }\n.b { color: rgb(0 0 0); background: rgba(0,0,0,.5); }\n.c { color: hsl(10 20% 30%); border-color: oklch(0.6 0.1 20); }\nconst k = \"bg-[#3b82f6] text-[rgb(1,2,3)]\";";
    expect(find(src).map((v) => `${v.line}:${v.text}`)).toEqual(["1:#fff", "2:rgb(", "2:rgba(", "3:hsl(", "3:oklch(", "4:#3b82f6", "4:rgb("]);
  });

  it("autorisé : var(--token), ancres CSS, identifiants, fragments non hexadécimaux", () => {
    expect(find(`#root { color: var(--text); background: var(--color-bg); }\nconst a = "#main-content"; const b = "bg-focus"; const c = "#face-lift";`)).toEqual([]);
  });

  it("un fichier fautif échoue ; tokens.css, les tests et la liste blanche passent", () => {
    const root = fakeRepo({
      "apps/web/src/a.css": ".x { color: #123456; }",
      "apps/web/src/b.tsx": "const s = { color: \"rgb(1 2 3)\" };",
      "apps/web/src/design/tokens.css": "@theme { --color-bg: #ffffff; }",
      "apps/web/src/c.test.ts": "const c = \"#ffffff\";",
      "apps/web/src/ok.ts": "const c = \"var(--text)\";",
      "apps/web/src/exception.ts": "const c = \"#abcdef\";",
    });
    const allowlist = [{ path: "apps/web/src/exception.ts", reason: "exception de test, motivée ici" }];
    expect(lintRawColors({ root, allowlist }).map((v: { file: string }) => v.file).sort()).toEqual(["apps/web/src/a.css", "apps/web/src/b.tsx"]);
  });
});
