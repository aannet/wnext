// Moteur de layout d'une ligne du Schedule (ADR-002 §6), sans DOM ni canvas : le rendu (ADR-005, non tranché) ne fait
// que convertir ces unités en pixels. Unités : colonnes = jours depuis le début de la fenêtre ; y et h = fractions de la
// hauteur de ligne (1 = 100 % de la capacité de référence de la personne).
//  * Largeur = durée en jours (un bloc d'un jour est valide), coupée aux bords de la fenêtre.
//  * Hauteur = part de la capacité : heures / journée de référence (la plus longue de work_days_hours), ou % tel quel.
//  * Empilement : chaque bloc prend la plus basse position libre parmi les blocs qui le chevauchent dans le temps
//    (les trous laissés plus haut sont réutilisés). Ordre déterministe : début, puis plus long d'abord, puis id.
//  * La hauteur de contenu dépasse 1 en cas d'empilement > 100 % (sur-allocation visible, BR-01) ; l'alerte métier,
//    elle, vient de la capacité nette (capacity-state, BR-38), pas de la géométrie.
import { DAY_MS, toMs } from "./dates";

export interface LayoutBlock {
  id: string;
  startDate: string;
  endDate: string;
  /** Hauteur en fraction de la ligne (> 0). Voir blockFraction. */
  fraction: number;
}

export interface PlacedBlock {
  id: string;
  /** Première colonne visible (0 = premier jour de la fenêtre). */
  col: number;
  /** Nombre de colonnes visibles (>= 1). */
  span: number;
  /** Le bloc continue avant / après la fenêtre (pour dessiner un bord ouvert). */
  clippedStart: boolean;
  clippedEnd: boolean;
  y: number;
  h: number;
}

export interface RowLayout {
  placed: PlacedBlock[];
  /** max(1, sommet du plus haut bloc) : hauteur de ligne à réserver, en fractions. */
  height: number;
  /** Empilement au-delà de 100 % de la ligne sur au moins un jour. */
  overflow: boolean;
}

const EPS = 1e-9;

/** Journée de référence d'une personne : sa plus longue journée de travail (8 h si aucune). */
export const referenceHours = (workDaysHours: readonly number[]): number => {
  const m = Math.max(0, ...workDaysHours);
  return m > 0 ? m : 8;
};

/** Fraction de hauteur d'une allocation : % / 100 en mode pourcentage, heures / journée de référence sinon. */
export function blockFraction(
  a: { mode: "hours" | "percentage"; hoursPerDay: number | null; percent: number | null },
  workDaysHours: readonly number[],
): number {
  return a.mode === "percentage" ? (a.percent ?? 0) / 100 : (a.hoursPerDay ?? 0) / referenceHours(workDaysHours);
}

const dayIndex = (from: string, d: string) => Math.round((toMs(d) - toMs(from)) / DAY_MS);

/** Dispose les blocs d'une ligne dans la fenêtre [from, to] (bornes incluses). Les blocs hors fenêtre sont ignorés. */
export function layoutRow(blocks: readonly LayoutBlock[], from: string, to: string): RowLayout {
  const days = dayIndex(from, to) + 1;
  const items = blocks
    .filter((b) => b.startDate <= to && b.endDate >= from && b.endDate >= b.startDate && b.fraction > 0)
    .map((b) => ({ b, s: dayIndex(from, b.startDate), e: dayIndex(from, b.endDate) }))
    .sort((x, y) => x.s - y.s || (y.e - y.s) - (x.e - x.s) || (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0));

  const placed: (PlacedBlock & { s: number; e: number })[] = [];
  let top = 0;
  for (const { b, s, e } of items) {
    const h = b.fraction;
    const busy = placed.filter((p) => p.s <= e && s <= p.e).map((p) => [p.y, p.y + p.h] as const).sort((x, y) => x[0] - y[0]);
    let y = 0;
    for (const [lo, hi] of busy) {
      if (y + h <= lo + EPS) break; // le trou sous ce bloc suffit
      if (hi > y) y = hi;
    }
    const col = Math.max(0, s);
    placed.push({ id: b.id, col, span: Math.min(days - 1, e) - col + 1, clippedStart: s < 0, clippedEnd: e >= days, y, h, s, e });
    top = Math.max(top, y + h);
  }
  return {
    placed: placed.map(({ s: _s, e: _e, ...p }) => p),
    height: Math.max(1, top),
    overflow: top > 1 + EPS,
  };
}

/** Aimantation d'une hauteur glissée (fraction) à un pas d'heures ; jamais sous un pas. */
export function snapHours(fraction: number, refHours: number, stepHours = 0.5): number {
  const hours = Math.round((fraction * refHours) / stepHours) * stepHours;
  return Math.max(stepHours, hours);
}
