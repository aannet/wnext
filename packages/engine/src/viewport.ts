// Vue horizontale du Schedule (ADR-002 §2-3) : zoom jour / semaine / mois, défilement continu, « Aujourd'hui »,
// fenêtres de chargement. Pur et sans rendu : la vue est un centre (jour fractionnaire) + une échelle + une largeur.
//  * Changer de zoom conserve le point central ; « Aujourd'hui » recentre sans changer le zoom.
//  * Précédent / suivant avance d'une largeur de vue (page) ou d'une période du zoom (stepPeriod : jour, semaine, mois).
//  * Défilement continu : une piste (plage de jours bornée, extensible) dont l'abscisse 0 est le début de son premier
//    jour ; la vue s'en déduit par le scrollLeft (viewAtScroll / scrollLeftOf).
//  * Chargement par blocs fixes de 4 semaines alignés sur week_start : un défilement ne recharge que les blocs nouveaux,
//    et la clé d'un bloc est stable (cache par compte). Une requête GET /schedule ne dépasse jamais 400 jours.
//  * Bornes de la plage planifiable : paramètre (ADR-002 §3 « à définir », proposition -2 ans / +3 ans).
import { DAY_MS, MAX_RANGE_DAYS, addDays, addMonths, toIso, toMs } from "./dates";

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

/**
 * Date du jour dans le fuseau du compte (accounts.timezone, IANA), jamais celui du navigateur : les dates métier sont
 * celles du compte (BR-18). `now` est fourni par l'appelant (testable). Fuseau inconnu : INVALID_TIMEZONE.
 */
export function todayIn(timeZone: string, now: Date): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    throw new RangeError(`INVALID_TIMEZONE: ${timeZone}`);
  }
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** « Aujourd'hui » (raccourci T) : `today` est la date du jour dans le fuseau du compte (todayIn). */
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

// ---------- piste du défilement continu ----------

/** Piste centrée sur `date`, `days` jours de chaque côté (par défaut ±12 mois), coupée aux bornes planifiables. */
export function trackAround(date: string, days = 365, bounds?: Bounds): Bounds {
  let first = addDays(date, -days);
  let last = addDays(date, days);
  if (bounds && first < bounds.first) first = bounds.first;
  if (bounds && last > bounds.last) last = bounds.last;
  return { first, last };
}

export const trackDays = (t: Bounds) => dayNumber(t.last) - dayNumber(t.first) + 1;
export const trackWidthPx = (t: Bounds, pxPerDay: number) => trackDays(t) * pxPerDay;

/** Vue dont le bord gauche est à `scrollLeft` pixels du début de la piste. */
export function viewAtScroll(t: Bounds, scrollLeft: number, zoom: Zoom, widthPx: number, pxPerDay: number): Viewport {
  return { zoom, widthPx, pxPerDay, center: dayNumber(t.first) + (scrollLeft + widthPx / 2) / pxPerDay };
}

/** Inverse de viewAtScroll, borné à la piste (0 .. largeur de piste - largeur de vue). */
export function scrollLeftOf(t: Bounds, v: Viewport): number {
  const max = Math.max(0, trackWidthPx(t, v.pxPerDay) - v.widthPx);
  return Math.min(max, Math.max(0, (v.center - dayNumber(t.first)) * v.pxPerDay - v.widthPx / 2));
}

/**
 * Bord atteint : si la vue est à moins de `marginDays` d'une extrémité, la piste s'allonge de `stepDays` au moins (assez
 * pour couvrir la vue et la marge), sans dépasser `bounds`. `shiftPx` = pixels ajoutés à gauche, à reporter sur le
 * scrollLeft pour que la vue ne bouge pas.
 */
export function extendTrack(t: Bounds, v: Viewport, opts: { marginDays: number; stepDays: number; bounds?: Bounds }): { track: Bounds; shiftPx: number } {
  const r = visibleRange(v);
  let first = t.first;
  let last = t.last;
  const lo = addDays(r.from, -opts.marginDays);
  const hi = addDays(r.to, opts.marginDays);
  if (lo < first) {
    first = addDays(first, -opts.stepDays);
    if (lo < first) first = lo;
    if (opts.bounds && first < opts.bounds.first) first = opts.bounds.first;
  }
  if (hi > last) {
    last = addDays(last, opts.stepDays);
    if (hi > last) last = hi;
    if (opts.bounds && last > opts.bounds.last) last = opts.bounds.last;
  }
  if (first === t.first && last === t.last) return { track: t, shiftPx: 0 };
  return { track: { first, last }, shiftPx: (dayNumber(t.first) - dayNumber(first)) * v.pxPerDay };
}

/** Précédent (-1) / suivant (+1) d'une période du zoom : un jour, une semaine, un mois calendaire (fin de mois ramenée). */
export function stepPeriod(v: Viewport, dir: -1 | 1, bounds?: Bounds): Viewport {
  const day = Math.floor(v.center);
  const target = v.zoom === "day" ? day + dir : v.zoom === "week" ? day + 7 * dir : dayNumber(addMonths(fromDayNumber(day), dir));
  return clamp({ ...v, center: target + (v.center - day) }, bounds);
}

/**
 * Voisinage d'une vue : une largeur de vue de chaque côté, au moins un bloc (préchargement, fenêtre du modèle), réduit
 * pour que la vue élargie, arrondie aux blocs, tienne dans 400 jours (layout et capacité refusent au-delà).
 */
export function neighborDays(v: Viewport): number {
  const w = Math.ceil(v.widthPx / v.pxPerDay);
  return Math.min(Math.max(CHUNK_DAYS, w), Math.max(0, Math.floor((MAX_RANGE_DAYS - w) / 2) - CHUNK_DAYS));
}

/** Blocs entiers que tient une plage de 400 jours (layout et capacité refusent au-delà). */
const MAX_COVER_CHUNKS = Math.floor(MAX_RANGE_DAYS / CHUNK_DAYS);
/** Demi-largeur du cœur d'une vue trop large : le modèle centré le contient encore après un bloc de défilement. */
const CORE_HALF_DAYS = Math.floor(MAX_COVER_CHUNKS / 2 - 1) * CHUNK_DAYS - CHUNK_DAYS;

/**
 * Plage couverte par les blocs de chargement de la vue élargie de `padDays` (bornes de blocs : stable au défilement).
 * Une vue plus large que 400 jours (zoom mois sur un écran 4K) est ramenée aux blocs centrés sur la vue qui tiennent
 * dans 400 jours : les bords extrêmes du visible restent alors hors du modèle (voir coreRange).
 */
export function chunkCover(v: Viewport, weekStart: number, padDays: number): { from: string; to: string } {
  let c = loadChunks(v, weekStart, padDays);
  if (c.length > MAX_COVER_CHUNKS) {
    const center = fromDayNumber(v.center);
    const mid = c.findIndex((x) => x.from <= center && x.to >= center);
    const start = Math.min(c.length - MAX_COVER_CHUNKS, Math.max(0, mid - Math.floor(MAX_COVER_CHUNKS / 2)));
    c = c.slice(start, start + MAX_COVER_CHUNKS);
  }
  return { from: c[0]!.from, to: c.at(-1)!.to };
}

/**
 * Partie de la vue que le modèle doit couvrir : le visible ; pour une vue trop large (chunkCover bornée), les jours à
 * ±CORE_HALF_DAYS du centre, que le modèle centré contient jusqu'à ce que la vue ait défilé d'un bloc.
 */
export function coreRange(v: Viewport): { from: string; to: string } {
  const r = visibleRange(v);
  if (dayNumber(r.to) - dayNumber(r.from) + 1 <= MAX_RANGE_DAYS - 2 * CHUNK_DAYS) return r;
  const c = Math.floor(v.center);
  return { from: fromDayNumber(c - CORE_HALF_DAYS), to: fromDayNumber(c + CORE_HALF_DAYS) };
}

export const coversRange = (outer: { from: string; to: string }, inner: { from: string; to: string }) =>
  outer.from <= inner.from && outer.to >= inner.to;
