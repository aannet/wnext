import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockColors } from "../src/schedule/block-colors";
import { ACCENT_HUE, colorWarnings, hueDistance, hueOf, MIN_HUE_DISTANCE_ACCENT, MIN_HUE_DISTANCE_OVER, OVER_CAPACITY_HUE, PROJECT_PALETTE, suggestColor, textContrast } from "../src/design/project-palette";

const tokens = readFileSync(new URL("../src/design/tokens.css", import.meta.url), "utf8");
const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)![1]!;

describe("palette projet", () => {
  it("compte 16 couleurs distinctes au format #RRGGBB", () => {
    expect(PROJECT_PALETTE).toHaveLength(16);
    expect(new Set(PROJECT_PALETTE.map((p) => p.hex)).size).toBe(16);
    for (const p of PROJECT_PALETTE) expect(p.hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("le texte choisi contraste au moins 4,5:1 avec chaque couleur, en bloc confirmé comme en bloc tentatif", () => {
    for (const p of PROJECT_PALETTE) {
      expect(textContrast(p.hex)).toBeGreaterThanOrEqual(4.5);
      expect(blockColors(p.hex, false).text).toBe(p.text);
      expect(blockColors(p.hex, true).text).toMatch(/^#(000000|ffffff)$/);
    }
  });

  it("chaque couleur reste à distance de teinte de --cap-over et de l'accent (valeurs lues dans tokens.css)", () => {
    // Les constantes de teinte doivent correspondre aux tokens réels.
    expect(hueDistance(hueOf(token("color-cap-over"))!, OVER_CAPACITY_HUE)).toBeLessThan(5);
    expect(hueDistance(hueOf(token("color-accent"))!, ACCENT_HUE)).toBeLessThan(5);
    for (const p of PROJECT_PALETTE) {
      const h = hueOf(p.hex)!;
      // La teinte relue après conversion en hexadécimal dérive de quelques degrés (gamut, arrondi).
      expect(hueDistance(h, hueOf(token("color-cap-over"))!)).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE_OVER - 5);
      expect(hueDistance(h, hueOf(token("color-accent"))!)).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE_ACCENT - 5);
    }
  });

  it("les teintes sont réparties (écart d'au moins 12 degrés entre voisines)", () => {
    const hues = PROJECT_PALETTE.map((p) => p.hue).sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i++) expect(hues[i]! - hues[i - 1]!).toBeGreaterThanOrEqual(12);
  });
});

describe("couleur libre : avertissements", () => {
  it("aucun avertissement pour une couleur de la palette", () => {
    for (const p of PROJECT_PALETTE) expect(colorWarnings(p.hex)).toEqual([]);
  });
  it("signale un hexadécimal invalide, un jaune pâle, un rouge et un pétrole", () => {
    expect(colorWarnings("rouge")).toEqual(["invalid"]);
    expect(colorWarnings("#FFFFCC")).toContain("low-surface-contrast");
    expect(colorWarnings(token("color-cap-over"))).toContain("near-over-capacity");
    expect(colorWarnings(token("color-accent"))).toContain("near-accent");
  });
  it("un gris n'a pas de teinte donc pas d'avertissement de teinte", () => {
    expect(colorWarnings("#808080")).toEqual([]);
  });
});

describe("couleur proposée", () => {
  it("prend la première couleur de la palette non utilisée, sans tenir compte de la casse", () => {
    expect(suggestColor([])).toBe(PROJECT_PALETTE[0]!.hex);
    expect(suggestColor([PROJECT_PALETTE[0]!.hex.toLowerCase()])).toBe(PROJECT_PALETTE[1]!.hex);
  });
  it("tourne quand la palette est épuisée", () => {
    expect(PROJECT_PALETTE.map((p) => p.hex)).toContain(suggestColor(PROJECT_PALETTE.map((p) => p.hex)));
  });
});
