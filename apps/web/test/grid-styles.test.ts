// Règles CSS de la grille du Planning (lot L-X1, cadrage n°4), lues dans styles.css et tokens.css (jsdom n'applique pas les
// feuilles de style) : trait « maintenant » et teinte de la colonne courante (RT-055), en-tête de colonnes renforcé (RT-056),
// survol des blocs (RT-062), jauge sans orange (RT-063).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../src/design/tokens.css", import.meta.url), "utf8");
/** Déclarations d'une règle (sélecteur exact, hors @media), concaténées si le sélecteur apparaît plusieurs fois. */
const rule = (css: string, selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join(";");
};
/** Contenu d'un bloc @media dont la condition contient `cond`. */
const media = (css: string, cond: string) => {
  const i = css.indexOf(`@media ${cond}`);
  if (i < 0) return "";
  let depth = 0;
  const start = css.indexOf("{", i);
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) return css.slice(start + 1, j);
  }
  return "";
};

describe("trait « maintenant » et colonne courante (RT-055)", () => {
  it("teinte de la colonne courante à 10 %", () => {
    expect(tokens).toMatch(/--color-current:\s*rgb\(14 116 144 \/ 0\.1\d*\)/);
  });

  it("trait de 2 px en accent, liseré de 1 px surface, au-dessus des blocs, sans capter le pointeur", () => {
    const now = rule(styles, ".wn-now");
    expect(now).toMatch(/width:\s*2px/);
    expect(now).toMatch(/background:\s*var\(--accent\)/);
    expect(now).toMatch(/box-shadow:\s*0 0 0 1px var\(--surface\)/);
    expect(now).toMatch(/pointer-events:\s*none/);
    expect(now).toMatch(/z-index:\s*[1-9]/);
  });
});

describe("en-tête de colonnes renforcé (RT-056)", () => {
  it("fond distinct du corps, bordure basse forte", () => {
    const h = rule(styles, ".wn-header");
    expect(h).toMatch(/background:\s*var\(--surface-sunken\)/);
    expect(h).toMatch(/border-bottom:\s*1px solid var\(--color-border-strong\)/);
  });

  it("texte --text en graisse 600", () => {
    const c = rule(styles, ".wn-colheader");
    expect(c).toMatch(/color:\s*var\(--text\)/);
    expect(c).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
  });

  it("période courante en pastille accent, texte blanc", () => {
    const p = rule(styles, ".wn-colheader-current .wn-colheader-label");
    expect(p).toMatch(/background:\s*var\(--accent\)/);
    expect(p).toMatch(/color:\s*var\(--accent-fg\)/);
    expect(p).toMatch(/border-radius:\s*var\(--radius-full\)/);
  });
});

describe("survol des blocs (RT-062)", () => {
  it("token --shadow-hover", () => {
    expect(tokens).toMatch(/--shadow-hover:\s*0 2px 6px rgb\(0 0 0 \/ \.18\)/);
  });

  it("souris seulement : soulèvement d'1 px (propriété translate) et ombre, transition rapide ; rien pendant un glisser", () => {
    const m = media(styles, "(hover: hover) and (pointer: fine)");
    expect(m).toMatch(/\.wn-block\s*\{[^}]*transition:[^}]*var\(--duration-fast\)/);
    const hover = /\.wn-block:hover:not\(\.wn-dragging \*\)[^{]*\{([^}]*)\}/.exec(m)?.[1] ?? "";
    expect(hover).toMatch(/translate:\s*0 -1px/);
    expect(hover).toMatch(/box-shadow:\s*var\(--shadow-hover\)/);
    expect(hover).not.toMatch(/transform/); // la position du bloc est un transform en ligne
  });

  it("mouvement réduit : l'ombre seule, sans déplacement", () => {
    const m = media(styles, "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: reduce)");
    expect(m).toMatch(/translate:\s*none/);
  });
});

describe("jauge sans orange (RT-063)", () => {
  it("aucune règle pour l'état full ; barre de 6 px en densité compacte", () => {
    expect(styles).not.toContain("wn-gauge-full");
    expect(styles).toMatch(/--wn-gauge-h:\s*6px/);
    expect(styles).not.toMatch(/--wn-gauge-h:\s*4px/);
  });
});
