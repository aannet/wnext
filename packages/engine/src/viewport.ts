// Vue horizontale du Schedule (ADR-002 §2-3) : zoom jour / semaine / mois, défilement continu, « Aujourd'hui »,
// fenêtres de chargement. Pur et sans rendu : la vue est un centre (jour fractionnaire) + une échelle + une largeur.
//  * Changer de zoom conserve le point central ; « Aujourd'hui » recentre sans changer le zoom.
//  * Précédent / suivant avance d'une largeur de vue.
//  * Chargement par blocs fixes de 4 semaines alignés sur week_start : un défilement ne recharge que les blocs nouveaux,
//    et la clé d'un bloc est stable (cache par compte). Une requête GET /schedule ne dépasse jamais 400 jours.
//  * Bornes de la plage planifiable : paramètre (ADR-002 §3 « à définir », proposition -2 ans / +3 ans).
import { DAY_MS, MAX_RANGE_DAYS, addDays, toIso, toMs } from "./dates";

export type Zoom = "day" | "week" | "month";

/** Pixels par jour de chaque zoom. Valeurs provisoires, à régler à l'écran (le moteur ne dépend que du rapport). */
export const DEFAULT_PX_PER_DAY: Readonly<Record<Zoom, number>> = { day: 96, week: 28, month: 8 };

export interface Viewport {
  zoom: Zoom;
  /** Jour au centre de la vue, en jours depuis 1970-01-01 (fractionnaire : on peut être au milieu d'un jour). */
  center: number;
  widthPx: number;
  pxPerDay: number;
}

export interface Bounds { first: string; last: string }

export const dayNumber = (d: string) => Math.round(toMs(d) / DAY_MS);
export const fromDayNumber = (n: number) => toIso(Math.floor(n) * DAY_MS);

/** Vue centrée sur le MILIEU du jour `date`. */
export function viewAt(date: string, zoom: Zoom, widthPx: number, scale = DEFAULT_PX_PER_DAY): Viewport {
  return { zoom, center: dayNumber(date) + 0.5, widthPx, pxPerDay: scale[zoom] };
}

/** Jours visibles, même partiellement (bornes incluses). */
export function visibleRange(v: Viewport): { from: string; to: string } {
  const half = v.widthPx / v.pxPerDay / 2;
  return { from: fromDayNumber(v.center - half), to: fromDayNumber(Math.ceil(v.center + half) - 1) };
}

/** Abscisse (px, depuis le bord gauche de la vue) du début du jour `date`. */
export const xOfDate = (v: Viewport, date: string) => (dayNumber(date) - v.center) * v.pxPerDay + v.widthPx / 2;

/** Jour sous l'abscisse x (aimantation à la journée : allocations sans heure, ADR-004). */
export const dateAtX = (v: Viewport, x: number) => fromDayNumber(v.center + (x - v.widthPx / 2) / v.pxPerDay);

function clamp(v: Viewport, bounds?: Bounds): Viewport {
  if (!bounds) return v;
  const half = v.widthPx / v.pxPerDay / 2;
  const lo = dayNumber(bounds.first) + half;
  const hi = dayNumber(bounds.last) + 1 - half;
  const center = lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v.center));
  return center === v.center ? v : { ...v, center };
}

export function setZoom(v: Viewport, zoom: Zoom, scale = DEFAULT_PX_PER_DAY, bounds?: Bounds): Viewport {
  return clamp({ ...v, zoom, pxPerDay: scale[zoom] }, bounds);
}

export const goToDate = (v: Viewport, date: string, bounds?: Bounds) => clamp({ ...v, center: dayNumber(date) + 0.5 }, bounds);

/** « Aujourd'hui » (raccourci T) : `today` est la date du jour dans le fuseau du compte, fournie par l'appelant. */
export const goToday = goToDate;

/** Défilement de dx pixels (positif = vers le futur). */
export const scrollBy = (v: Viewport, dx: number, bounds?: Bounds) => clamp({ ...v, center: v.center + dx / v.pxPerDay }, bounds);

/** Précédent (-1) / suivant (+1) : une largeur de vue, arrondie au jour. */
export const page = (v: Viewport, dir: -1 | 1, bounds?: Bounds) =>
  clamp({ ...v, center: v.center + dir * Math.max(1, Math.round(v.widthPx / v.pxPerDay)) }, bounds);

/** Début de la semaine contenant `d`, pour un premier jour ISO weekStart (1 = lundi .. 7 = dimanche). */
export function weekStartOf(d: string, weekStart: number): string {
  const isoDow = ((new Date(toMs(d)).getUTCDay() + 6) % 7) + 1;
  return addDays(d, -((isoDow - weekStart + 7) % 7));
}

export const CHUNK_DAYS = 28;

/** Blocs de chargement (4 semaines alignées sur weekStart) qui couvrent la vue élargie de `prefetchDays` de chaque côté. */
export function loadChunks(v: Viewport, weekStart: number, prefetchDays = 28, bounds?: Bounds): { from: string; to: string }[] {
  const r = visibleRange(v);
  let from = addDays(r.from, -prefetchDays);
  let to = addDays(r.to, prefetchDays);
  if (bounds) {
    if (from < bounds.first) from = bounds.first;
    if (to > bounds.last) to = bounds.last;
  }
  // Ancre fixe (une semaine de référence) : le découpage ne dépend pas de la position de la vue.
  const anchor = dayNumber(weekStartOf("2000-01-03", weekStart));
  const first = anchor + Math.floor((dayNumber(from) - anchor) / CHUNK_DAYS) * CHUNK_DAYS;
  const out: { from: string; to: string }[] = [];
  for (let s = first; s <= dayNumber(to); s += CHUNK_DAYS) out.push({ from: fromDayNumber(s), to: fromDayNumber(s + CHUNK_DAYS - 1) });
  return out;
}

/** Regroupe des blocs contigus en requêtes GET /schedule de 400 jours au plus. */
export function mergeChunks(chunks: readonly { from: string; to: string }[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const c of [...chunks].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    const last = out.at(-1);
    if (last && addDays(last.to, 1) === c.from && dayNumber(c.to) - dayNumber(last.from) <= MAX_RANGE_DAYS) last.to = c.to;
    else out.push({ ...c });
  }
  return out;
}

export interface HeaderCell { from: string; to: string; kind: "day" | "week" | "month" }

/** Cellules d'en-tête de la plage : jours (zoom jour), semaines alignées sur weekStart (zoom semaine), mois (zoom mois). */
export function headerCells(range: { from: string; to: string }, zoom: Zoom, weekStart: number): HeaderCell[] {
  const out: HeaderCell[] = [];
  let d = zoom === "day" ? range.from : zoom === "week" ? weekStartOf(range.from, weekStart) : `${range.from.slice(0, 8)}01`;
  while (d <= range.to) {
    const next = zoom === "day" ? addDays(d, 1)
      : zoom === "week" ? addDays(d, 7)
      : toIso(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1));
    out.push({ from: d, to: addDays(next, -1), kind: zoom });
    d = next;
  }
  return out;
}
