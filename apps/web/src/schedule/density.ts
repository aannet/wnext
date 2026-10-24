// Densité d'affichage du Schedule (RT-005 à RT-007, cadrage n°1 Q1 et Q2 ; docs/06-decisions/reviews-v1.1/ux-ui.md §2.2 amendé le 2026-10-21).
//  * Trois niveaux à HAUTEURS FIXES (Q1 : pas d'ajustement à la fenêtre), calibrés sur l'écran de référence 1920 × 1080
//    (zone des lignes mesurée dans Chromium le 2026-10-21 : 787 px sous l'en-tête de dates) : 12, 8 et 6 personnes entières
//    visibles (le compte tient pour une zone de 744 à 805 px).
//    Hauteur d'une ligne sans empilement = rowUnitPx (blocs à 100 % de la journée) + capPx (bande de capacité).
//  * Compacte = les dimensions d'avant le réglage (48 + 14 px) : c'est aussi le défaut de buildGrid, ce qui garde les
//    calculs de pixels des tests existants. L'écran démarre en standard (défaut retenu par Alec).
//  * En aéré, tout grossit (RT-006) : blocs, bande, et dans la colonne de gauche avatar, textes et jauge (variables CSS
//    posées par data-density sur l'écran, échelle typographique des tokens).
//  * Bascule « Charge » (RT-052) : rowMetrics retire la bande (capPx = 0) quand elle est éteinte ; état en mémoire seulement.
//  * Mémorisée localement (localStorage, sous try/catch : navigation privée, stockage bloqué) et portée par les vues
//    sauvegardées (filters.density, contrat). Pas de profil utilisateur (T2).
import type { ScheduleViewFilters } from "@wnext/contracts";

export type Density = NonNullable<ScheduleViewFilters["density"]>;

export const DENSITIES: readonly Density[] = ["compact", "standard", "airy"];
export const DEFAULT_DENSITY: Density = "standard";

export interface RowMetrics {
  /** Hauteur des blocs à 100 % de la journée de référence. */
  rowUnitPx: number;
  /** Hauteur de la bande de capacité en pied de ligne. */
  capPx: number;
}

/** Multiples de 8 pour la hauteur des blocs (une heure d'une journée de 8 h = un nombre entier de pixels). */
export const DENSITY_METRICS: Readonly<Record<Density, RowMetrics>> = {
  compact: { rowUnitPx: 48, capPx: 14 },
  standard: { rowUnitPx: 72, capPx: 20 },
  airy: { rowUnitPx: 96, capPx: 24 },
};

/**
 * Hauteurs du modèle selon la densité et la bascule « Charge » (RT-052, cadrage n°4 D3) : bascule éteinte, la bande de
 * capacité n'est pas dessinée et la ligne perd sa hauteur (capPx = 0).
 */
export function rowMetrics(d: Density, showLoad: boolean): RowMetrics {
  const m = DENSITY_METRICS[d];
  return showLoad ? m : { rowUnitPx: m.rowUnitPx, capPx: 0 };
}

export const isDensity = (v: unknown): v is Density => typeof v === "string" && (DENSITIES as readonly string[]).includes(v);

export const DENSITY_STORAGE_KEY = "wnext.schedule.density";

type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | undefined => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

/** Densité mémorisée dans ce navigateur, ou le défaut (absente, illisible, stockage indisponible). */
export function readStoredDensity(store: Store | undefined = browserStore()): Density {
  try {
    const v = store?.getItem(DENSITY_STORAGE_KEY);
    return isDensity(v) ? v : DEFAULT_DENSITY;
  } catch { return DEFAULT_DENSITY; }
}

/** Mémorise la densité ; sans effet si le stockage est indisponible (l'écran garde la valeur courante). */
export function storeDensity(d: Density, store: Store | undefined = browserStore()): void {
  try { store?.setItem(DENSITY_STORAGE_KEY, d); } catch { /* stockage plein ou bloqué : sans effet */ }
}
