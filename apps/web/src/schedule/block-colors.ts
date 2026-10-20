// Couleurs d'un bloc à partir de la couleur du projet (WCAG 1.4.3 : texte >= 4,5:1 sur son fond).
//  * Confirmé : fond = couleur du projet ; texte noir ou blanc, celui qui contraste le plus (luminance relative WCAG).
//  * Tentatif : fond = teinte claire de la couleur (20 % sur blanc), bord pointillé de la couleur du projet, texte choisi
//    de la même façon ; la distinction ne repose pas sur la couleur seule (bord pointillé et hachures CSS).
//  * Calculé une fois par couleur (cache), jamais au redessin.

export interface BlockColors { background: string; text: string; border: string }

const NEUTRAL = "#6b7280";
const TINT = 0.2;

/** Composantes 0-255 d'une couleur #rgb ou #rrggbb ; null si la chaîne n'en est pas une. */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Luminance relative WCAG 2.x (0 = noir, 1 = blanc). */
export function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rapport de contraste WCAG entre deux luminances. */
export const contrastRatio = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/** Texte noir ou blanc, celui dont le contraste avec le fond est le plus fort (>= 4,58:1 pour tout fond). */
export function textColorOn(rgb: readonly [number, number, number]): "#000000" | "#ffffff" {
  const l = relativeLuminance(rgb);
  return contrastRatio(l, 0) >= contrastRatio(l, 1) ? "#000000" : "#ffffff";
}

const hex = (rgb: readonly number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

const cache = new Map<string, BlockColors>();

export function blockColors(color: string | null, tentative: boolean): BlockColors {
  const key = `${color ?? ""}|${tentative ? 1 : 0}`;
  let c = cache.get(key);
  if (!c) {
    const rgb = parseHex(color ?? "") ?? parseHex(NEUTRAL)!;
    const bg = tentative ? rgb.map((v) => 255 - (255 - v) * TINT) as [number, number, number] : rgb;
    c = { background: hex(bg), text: textColorOn(bg), border: hex(rgb) };
    cache.set(key, c);
  }
  return c;
}
