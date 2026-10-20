// Couleurs des blocs (WCAG 1.4.3) : texte noir ou blanc selon la luminance relative, teinte claire pour le tentatif, cache.
import { describe, expect, it } from "vitest";
import { blockColors, contrastRatio, parseHex, relativeLuminance, textColorOn } from "../src/schedule/block-colors";

const ratio = (a: string, b: string) => contrastRatio(relativeLuminance(parseHex(a)!), relativeLuminance(parseHex(b)!));
const DEMO = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#0EA5E9"];

describe("block-colors", () => {
  it("luminance et contraste WCAG : valeurs de référence", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
    expect(ratio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(ratio("#f59e0b", "#ffffff")).toBeCloseTo(2.15, 2); // le défaut relevé par axe : blanc sur ambre
    expect(parseHex("bleu")).toBeNull();
  });

  it("texte : celui des deux (noir, blanc) qui contraste le plus", () => {
    expect(textColorOn([255, 255, 255])).toBe("#000000");
    expect(textColorOn([0, 0, 0])).toBe("#ffffff");
    expect(textColorOn(parseHex("#1d4ed8")!)).toBe("#ffffff");
    expect(textColorOn(parseHex("#f59e0b")!)).toBe("#000000");
  });

  it("toute couleur : contraste du texte >= 4,5:1, confirmé comme tentatif", () => {
    const colors = [...DEMO, "#1d4ed8", "#777777", "#767676", "#808080", "#ff00ff", "#00ff00", "#123", "#fff", "#000"];
    for (let v = 0; v < 256; v += 15) colors.push(`#${v.toString(16).padStart(2, "0").repeat(3)}`);
    for (const c of colors) for (const tentative of [false, true]) {
      const b = blockColors(c, tentative);
      expect(ratio(b.text, b.background), `${c} ${tentative}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("confirmé : fond = couleur du projet ; tentatif : teinte claire, bord de la couleur du projet", () => {
    expect(blockColors("#3B82F6", false)).toEqual({ background: "#3b82f6", text: "#000000", border: "#3b82f6" });
    const t = blockColors("#3B82F6", true);
    expect(t.border).toBe("#3b82f6");
    expect(relativeLuminance(parseHex(t.background)!)).toBeGreaterThan(0.7);
    expect(t.text).toBe("#000000");
  });

  it("couleur absente ou invalide : gris neutre ; même entrée = même objet (cache)", () => {
    expect(blockColors(null, false).background).toBe("#6b7280");
    expect(blockColors("rouge", false).background).toBe("#6b7280");
    expect(blockColors("#10B981", true)).toBe(blockColors("#10B981", true));
  });
});
