// Palette des couleurs de projet (RT-018, US-2.1) : 16 teintes de même clarté et de même chroma perceptuels (espace OKLab,
// L = 0,62 et C = 0,12), donc d'un poids visuel homogène sur la grille. Calculée à l'exécution : aucun littéral de couleur
// (garde-fou lint:raw-colors), seules les teintes sont des nombres.
//  * Exclusions (Q-09, 2026-10-21) : la zone rouge, proche de --cap-over (dépassement de capacité, teinte ~27°), pour
//    qu'un bloc de projet ne soit jamais pris pour une alerte ; et la zone sarcelle/pétrole, proche de l'accent de
//    l'interface (teinte ~223°), pour qu'il reste la couleur de l'interface.
//  * Texte : noir ou blanc selon textColorOn (>= 4,58:1 pour tout fond), jamais choisi à la main.
import { contrastRatio, parseHex, relativeLuminance, textColorOn } from "../schedule/block-colors";

export const PALETTE_LIGHTNESS = 0.62;
export const PALETTE_CHROMA = 0.12;
/** Teintes (degrés OKLCH) des tokens à éviter : --cap-over et --color-accent. Vérifiées contre tokens.css par les tests. */
export const OVER_CAPACITY_HUE = 27;
export const ACCENT_HUE = 223;
/** Distance de teinte minimale (degrés) exigée avec --cap-over et avec l'accent. */
export const MIN_HUE_DISTANCE_OVER = 30;
export const MIN_HUE_DISTANCE_ACCENT = 35;

export const hueDistance = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Espace OKLCH vers sRGB (0-255), ramené dans le gamut par réduction du chroma si besoin. */
export function oklchToRgb(l: number, c: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const linear = (chroma: number) => {
    const a = chroma * Math.cos(h), b = chroma * Math.sin(h);
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    ];
  };
  let chroma = c;
  let lin = linear(chroma);
  for (let i = 0; i < 40 && lin.some((v) => v < -1e-6 || v > 1 + 1e-6); i++) { chroma *= 0.95; lin = linear(chroma); }
  const gamma = (v: number) => { const x = Math.min(1, Math.max(0, v)); return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055); };
  return lin.map(gamma) as [number, number, number];
}

export const rgbToHex = (rgb: readonly number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function paletteHues(): number[] {
  const kept: number[] = [];
  for (let h = 0; h < 360; h += 12) {
    if (hueDistance(h, OVER_CAPACITY_HUE) < MIN_HUE_DISTANCE_OVER || hueDistance(h, ACCENT_HUE) < MIN_HUE_DISTANCE_ACCENT) continue;
    kept.push(h);
  }
  // 16 teintes réparties au plus régulier parmi celles qui restent.
  return Array.from({ length: 16 }, (_, i) => kept[Math.floor((i * kept.length) / 16)]!);
}

export interface PaletteEntry { hue: number; hex: string; text: ReturnType<typeof textColorOn> }

export const PROJECT_PALETTE: readonly PaletteEntry[] = paletteHues().map((hue) => {
  const rgb = oklchToRgb(PALETTE_LIGHTNESS, PALETTE_CHROMA, hue);
  return { hue, hex: rgbToHex(rgb), text: textColorOn(rgb) };
});

/** Contraste du texte noir ou blanc choisi sur ce fond (>= 4,5:1 exigé, WCAG 1.4.3) ; null si ce n'est pas un hexadécimal #rrggbb. */
export function textContrast(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const l = relativeLuminance(rgb);
  return Math.max(contrastRatio(l, 0), contrastRatio(l, 1)); // textColorOn retient celui des deux qui contraste le plus
}

/** Teinte OKLCH d'une couleur #rrggbb ; null pour un gris (chroma quasi nul) ou une chaîne invalide. */
export function hueOf(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  if (Math.hypot(a, bb) < 0.02) return null;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

export type ColorWarning = "invalid" | "low-surface-contrast" | "near-over-capacity" | "near-accent";

/**
 * Avertissements pour une couleur libre (hors palette). Le texte du bloc reste lisible quelle que soit la couleur (noir ou blanc,
 * textColorOn) ; ce qui peut manquer, c'est la distinction du bloc sur la page blanche (WCAG 1.4.11 : 3:1) et la confusion avec
 * l'alerte de dépassement (rouge) ou avec l'accent de l'interface.
 */
export function colorWarnings(hex: string): ColorWarning[] {
  const rgb = parseHex(hex);
  if (!rgb) return ["invalid"];
  const out: ColorWarning[] = [];
  if (contrastRatio(relativeLuminance(rgb), 1) < 3) out.push("low-surface-contrast");
  const hue = hueOf(hex);
  if (hue !== null) {
    if (hueDistance(hue, OVER_CAPACITY_HUE) < MIN_HUE_DISTANCE_OVER) out.push("near-over-capacity");
    if (hueDistance(hue, ACCENT_HUE) < MIN_HUE_DISTANCE_ACCENT) out.push("near-accent");
  }
  return out;
}

/** Couleur proposée à la création : la première de la palette que les projets existants n'utilisent pas encore (sinon, par rotation). */
export function suggestColor(used: Iterable<string>): string {
  const taken = new Set([...used].map((c) => c.toUpperCase()));
  const free = PROJECT_PALETTE.find((p) => !taken.has(p.hex));
  return (free ?? PROJECT_PALETTE[taken.size % PROJECT_PALETTE.length]!).hex;
}
