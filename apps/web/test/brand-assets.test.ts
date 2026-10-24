// Fichiers de la marque : symbole SVG 1.1 monochrome (currentColor), favicon redessiné sur la grille de 16 px (coordonnées
// entières : barres nettes), icônes déclarées par index.html.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("fichiers de la marque", () => {
  it("logo.svg : SVG 1.1, viewBox 100, formes en currentColor, ni couleur ni classe", () => {
    const svg = read("src/design/brand/logo.svg");
    expect(svg).toMatch(/<svg[^>]*\bversion="1\.1"/);
    expect(svg).toMatch(/<svg[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/<svg[^>]*\bviewBox="0 0 100 100"/);
    expect(svg).toMatch(/fill="currentColor"/);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\bclass=/i);
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg.match(/<circle /g)).toHaveLength(1);
  });

  it("favicon.svg : grille 16 × 16, coordonnées entières, couleur claire et sombre", () => {
    const svg = read("public/favicon.svg");
    expect(svg).toMatch(/<svg[^>]*\bviewBox="0 0 16 16"/);
    const coords = [...svg.matchAll(/\b(x|y|width|height)="([^"]+)"/g)].map((m) => Number(m[2]));
    expect(coords.length).toBeGreaterThanOrEqual(16);
    expect(coords.every((n) => Number.isInteger(n))).toBe(true);
    expect(svg).toContain("prefers-color-scheme: dark");
  });

  it("index.html déclare le favicon SVG et son repli PNG 16 × 16", () => {
    const html = read("index.html");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />');
    expect(readFileSync(new URL("../public/favicon-16.png", import.meta.url)).subarray(1, 4).toString()).toBe("PNG");
  });
});
