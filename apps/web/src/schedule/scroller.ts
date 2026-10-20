// Défilement horizontal continu du Schedule (ADR-002 §2-3, ADR-005 A2), sans React : pilote le conteneur qui défile.
//  * Piste : plage de jours bornée (±12 mois autour d'aujourd'hui), abscisse 0 = début de son premier jour, après la
//    gouttière des noms de personnes (collée à gauche). Le défilement est natif (molette, trackpad, Maj + molette, barre) ;
//    la piste s'allonge quand la vue approche d'un bord (le scrollLeft est reporté pour que la vue ne bouge pas).
//  * Tranches : le modèle (buildGrid) couvre les blocs de chargement (28 jours, alignés sur week_start) de la vue élargie
//    d'une largeur de vue de chaque côté. Il n'est reconstruit qu'au changement de tranche, de zoom ou de données : en
//    tâche de fond quand la marge restante passe sous un demi-voisinage, tout de suite si le visible sort du modèle.
//  * Redessin : un seul par image (requestAnimationFrame) ; lignes, blocs et cellules d'en-tête hors champ recyclés. La
//    fenêtre horizontale est quantifiée (QUANTUM_PX) : entre deux paliers, une ligne visible n'est pas revisitée.
//  * Vue transmise à la source de données au plus toutes les `viewChangeMs` pendant le défilement (préchargement), tout
//    de suite au montage et au changement de zoom.
//  * « Aujourd'hui », précédent / suivant (une période du zoom) : défilement doux, sauf préférence « mouvement réduit ».
//    Le zoom garde la date au centre.
import type { ScheduleResponse } from "@wnext/contracts";
import {
  CHUNK_DAYS, DEFAULT_PX_PER_DAY, chunkCover, coreRange, dayNumber, extendTrack, fromDayNumber, headerCells, neighborDays, scrollLeftOf,
  stepPeriod, trackAround, trackWidthPx, viewAtScroll, visibleRange, type Bounds, type HeaderCell, type Viewport, type Zoom,
} from "@wnext/engine";
import type { EditHost } from "./block-editor";
import { createGridRenderer } from "./grid-dom";
import { createHeaderRenderer, type HeaderItem } from "./grid-header";
import { buildGrid, type GridBlock, type GridCap, type GridModel } from "./grid-model";

/** Largeur de la colonne des noms de personnes (gouttière collée à gauche). */
export const GUTTER_PX = 140;
export const HEADER_PX = 32;
/** Pas de la fenêtre horizontale rendue (et marge de chaque côté de la vue). */
export const QUANTUM_PX = 256;
/** Défilement clavier (flèches) : une unité d'en-tête. */
const KEY_DAYS: Readonly<Record<Zoom, number>> = { day: 1, week: 7, month: 30 };

export interface Clock {
  raf(cb: () => void): number;
  caf(id: number): void;
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** Travail différable (reconstruction anticipée du modèle). */
  idle(cb: () => void): void;
}

export interface ScrollerOptions {
  root: HTMLElement;
  data: ScheduleResponse;
  today: string;
  /** Largeur totale (gouttière comprise) et hauteur du conteneur. */
  widthPx: number;
  heightPx: number;
  /** Libellé localisé d'une cellule d'en-tête. */
  label(c: HeaderCell): string;
  zoom?: Zoom;
  onViewChange?(v: Viewport): void;
  clock?: Partial<Clock>;
  viewChangeMs?: number;
  smoothMs?: number;
  reducedMotion?(): boolean;
  trackDays?: number;
  bounds?: Bounds;
  build?: typeof buildGrid;
  /** Libellé accessible d'une cellule de capacité, avec la période déjà formatée (catalogue i18n). */
  capacityLabel?(period: string, c: GridCap): string;
  /** Libellé accessible d'un bloc (catalogue i18n). */
  blockLabel?(b: GridBlock): string;
}

export interface Scroller {
  view(): Viewport;
  zoom(): Zoom;
  setData(d: ScheduleResponse): void;
  /** Date du jour (fuseau du compte) : cible d'« Aujourd'hui » ; la vue ne bouge pas. */
  setToday(today: string): void;
  /** Libellés localisés (changement de locale) : tout est réécrit au prochain dessin, la vue ne bouge pas. */
  setLabels(l: Pick<ScrollerOptions, "label" | "capacityLabel" | "blockLabel">): void;
  resize(widthPx: number, heightPx: number): void;
  today(): void;
  step(dir: -1 | 1): void;
  setZoom(z: Zoom): void;
  /** Flèches gauche / droite. */
  nudge(dir: -1 | 1): void;
  /** Repère de l'édition par gestes (block-editor) : données, modèle courant, géométrie. */
  readonly host: EditHost;
  stats(): { builds: number; rowsCreated: number; blocksCreated: number; capsCreated: number; cellsCreated: number; nodes: number };
  destroy(): void;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function defaultClock(): Clock {
  const g = globalThis as typeof globalThis & { requestIdleCallback?: (cb: () => void) => number };
  return {
    raf: (cb) => (g.requestAnimationFrame ? g.requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)),
    caf: (id) => (g.cancelAnimationFrame ? g.cancelAnimationFrame(id) : clearTimeout(id)),
    now: () => performance.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (id) => clearTimeout(id as number),
    idle: (cb) => (g.requestIdleCallback ? g.requestIdleCallback(cb) : setTimeout(cb, 0)),
  };
}

const prefersReducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function createScroller(o: ScrollerOptions): Scroller {
  const root = o.root;
  const clock: Clock = { ...defaultClock(), ...o.clock };
  const build = o.build ?? buildGrid;
  const viewChangeMs = o.viewChangeMs ?? 100;
  const smoothMs = o.smoothMs ?? 300;
  const reduced = o.reducedMotion ?? prefersReducedMotion;
  const header = createHeaderRenderer(root, { heightPx: HEADER_PX, gutterPx: GUTTER_PX });
  const grid = createGridRenderer(root, {
    ...(o.capacityLabel ? { capLabel: (c: GridCap) => o.capacityLabel!(label(c), c) } : {}),
    ...(o.blockLabel ? { blockLabel: o.blockLabel } : {}),
  });

  let data = o.data;
  let zoom: Zoom = o.zoom ?? "day";
  let pxPerDay = DEFAULT_PX_PER_DAY[zoom];
  let widthPx = o.widthPx;
  let heightPx = o.heightPx;
  let track = trackAround(o.today, o.trackDays ?? 365, o.bounds);
  let model: GridModel | null = null;
  let modelKey = "";
  let builds = 0;
  let frameId = 0;
  let idlePending = false;
  let anim: { c0: number; c1: number; t0: number } | null = null;
  let timer: unknown = null;
  let latest: Viewport | null = null;
  let headerKey = "";
  let labels = new Map<string, string>();
  let destroyed = false;
  let today = o.today;
  let labelOf = o.label;

  const tl = () => Math.max(1, widthPx - GUTTER_PX);
  const viewFor = (center: number): Viewport => ({ zoom, center, widthPx: tl(), pxPerDay });
  const current = () => viewAtScroll(track, root.scrollLeft, zoom, tl(), pxPerDay);
  const weekStart = () => data.account.weekStart;

  function rebuild(v: Viewport) {
    const range = chunkCover(v, weekStart(), neighborDays(v));
    model = build(data, range, pxPerDay, zoom);
    modelKey = `${range.from}..${range.to}`;
    builds++;
  }

  /**
   * Modèle de la vue : reconstruit tout de suite s'il ne couvre plus le visible (saut, défilement très rapide), en tâche
   * de fond quand la marge restante passe sous une demi-voisinage (on change alors de tranche), sinon conservé.
   */
  function ensureModel(v: Viewport) {
    if (!model) return rebuild(v);
    const inside = (r: { from: string; to: string }) => r.from >= model!.from && r.to <= model!.to;
    // coreRange : le visible, ou son cœur pour une vue de plus de 400 jours (modèle borné, chunkCover).
    if (!inside(coreRange(v))) return rebuild(v);
    if (inside(coreRange({ ...v, widthPx: v.widthPx + neighborDays(v) * v.pxPerDay })) || idlePending) return;
    idlePending = true;
    clock.idle(() => {
      idlePending = false;
      if (destroyed) return;
      const w = current();
      const want = chunkCover(w, weekStart(), neighborDays(w));
      if (`${want.from}..${want.to}` !== modelKey) { rebuild(w); paint(root.scrollLeft); }
    });
  }

  function label(c: HeaderCell): string {
    let s = labels.get(c.from);
    if (s === undefined) { s = labelOf(c); labels.set(c.from, s); }
    return s;
  }

  /** Dessine pour un scrollLeft donné (avant de l'appliquer : la surface est déjà à la bonne largeur). */
  function paint(sl: number) {
    const m = model;
    if (!m) return;
    const first = dayNumber(track.first);
    const surfaceWidth = GUTTER_PX + trackWidthPx(track, pxPerDay);
    const left = Math.floor((sl + GUTTER_PX - QUANTUM_PX) / QUANTUM_PX) * QUANTUM_PX;
    const right = Math.ceil((sl + GUTTER_PX + tl() + QUANTUM_PX) / QUANTUM_PX) * QUANTUM_PX;
    const originX = GUTTER_PX + (dayNumber(m.from) - first) * pxPerDay;
    grid.render(m, Math.max(0, root.scrollTop - HEADER_PX), heightPx - HEADER_PX, { surfaceWidth, originX, left, right });
    const key = `${left}:${right}:${zoom}:${track.first}:${track.last}`;
    if (key === headerKey) return;
    headerKey = key;
    const range = {
      from: fromDayNumber(Math.max(first, first + (left - GUTTER_PX) / pxPerDay)),
      to: fromDayNumber(Math.min(dayNumber(track.last), first + (right - GUTTER_PX) / pxPerDay)),
    };
    const items: HeaderItem[] = headerCells(range, zoom, weekStart()).map((c) => ({
      from: c.from, label: label(c),
      x: GUTTER_PX + (dayNumber(c.from) - first) * pxPerDay,
      w: (dayNumber(c.to) - dayNumber(c.from) + 1) * pxPerDay,
    }));
    header.render(items, surfaceWidth);
  }

  /** Allonge la piste si `v` approche d'un bord ; rend le scrollLeft corrigé. */
  function grow(v: Viewport, sl: number): number {
    const e = extendTrack(track, v, { marginDays: neighborDays(v), stepDays: 6 * CHUNK_DAYS, bounds: o.bounds });
    if (e.track === track) return sl;
    track = e.track;
    const next = sl + e.shiftPx;
    paint(next);
    root.scrollLeft = next;
    return next;
  }

  function emit(v: Viewport, now = false) {
    latest = v;
    if (!o.onViewChange) return;
    if (now) {
      if (timer !== null) { clock.clearTimer(timer); timer = null; }
      o.onViewChange(v);
      return;
    }
    if (timer !== null) return;
    timer = clock.setTimer(() => { timer = null; if (!destroyed && latest) o.onViewChange!(latest); }, viewChangeMs);
  }

  function frame() {
    frameId = 0;
    if (destroyed) return;
    if (anim) {
      const t = Math.min(1, (clock.now() - anim.t0) / smoothMs);
      root.scrollLeft = scrollLeftOf(track, viewFor(anim.c0 + (anim.c1 - anim.c0) * ease(t)));
      if (t >= 1) anim = null;
      else schedule();
    }
    const sl = grow(current(), root.scrollLeft);
    const v = viewAtScroll(track, sl, zoom, tl(), pxPerDay);
    ensureModel(v);
    paint(sl);
    emit(v);
  }

  function schedule() {
    if (!frameId && !destroyed) frameId = clock.raf(frame);
  }

  /** Place la vue sur `center` sans animation (zoom, redimensionnement, montage). */
  function jump(center: number) {
    const v = viewFor(center);
    grow(v, root.scrollLeft);
    const sl = scrollLeftOf(track, v);
    if (!model || model.pxPerDay !== pxPerDay) rebuild(v);
    else ensureModel(v);
    paint(sl);
    root.scrollLeft = sl;
  }

  function animateTo(center: number) {
    grow(viewFor(center), root.scrollLeft);
    if (reduced() || smoothMs <= 0) {
      anim = null;
      jump(center);
      schedule();
      return;
    }
    anim = { c0: current().center, c1: center, t0: clock.now() };
    schedule();
  }

  const onScroll = () => schedule();
  const stopAnim = () => { anim = null; };
  root.addEventListener("scroll", onScroll, { passive: true });
  root.addEventListener("wheel", stopAnim, { passive: true });
  root.addEventListener("pointerdown", stopAnim, { passive: true });

  jump(dayNumber(o.today) + 0.5);
  emit(current(), true);

  return {
    view: current,
    zoom: () => zoom,
    setData(d) {
      if (d === data) return;
      data = d;
      rebuild(current());
      headerKey = "";
      paint(root.scrollLeft);
    },
    resize(w, h) {
      if (w === widthPx && h === heightPx) return;
      const c = current().center;
      widthPx = w;
      heightPx = h;
      headerKey = "";
      model = null;
      jump(c);
      emit(current(), true);
    },
    setToday(d) { today = d; },
    setLabels(l) {
      labelOf = l.label;
      labels = new Map();
      headerKey = "";
      grid.setLabels({
        ...(l.capacityLabel ? { capLabel: (c: GridCap) => l.capacityLabel!(label(c), c) } : {}),
        ...(l.blockLabel ? { blockLabel: l.blockLabel } : {}),
      });
      schedule();
    },
    today: () => animateTo(dayNumber(today) + 0.5),
    step(dir) {
      const base = anim ? viewFor(anim.c1) : current();
      animateTo(stepPeriod(base, dir, o.bounds).center);
    },
    setZoom(z) {
      if (z === zoom) return;
      const c = anim ? anim.c1 : current().center;
      anim = null;
      zoom = z;
      pxPerDay = DEFAULT_PX_PER_DAY[z];
      labels = new Map();
      headerKey = "";
      jump(c);
      emit(current(), true);
    },
    nudge(dir) {
      anim = null;
      root.scrollLeft = Math.max(0, root.scrollLeft + dir * KEY_DAYS[zoom] * pxPerDay);
      schedule();
    },
    host: {
      surface: grid.surface,
      data: () => data,
      model: () => model,
      pxPerDay: () => pxPerDay,
      xOfDate: (d) => GUTTER_PX + (dayNumber(d) - dayNumber(track.first)) * pxPerDay,
      scrollDay: () => dayNumber(track.first) + root.scrollLeft / pxPerDay,
      blockAt: grid.blockAt,
    },
    stats: () => ({ builds, ...grid.stats(), ...header.stats(), nodes: root.getElementsByTagName("*").length }),
    destroy() {
      destroyed = true;
      if (frameId) clock.caf(frameId);
      if (timer !== null) clock.clearTimer(timer);
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", stopAnim);
      root.removeEventListener("pointerdown", stopAnim);
      grid.destroy();
      header.destroy();
    },
  };
}
