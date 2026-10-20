// Rendu DOM de la grille du Schedule (ADR-005 : DOM virtualisé optimisé, A2, porté du spike spikes/grille/src/main-dom-opt.ts).
//  * Seules les lignes visibles (plus une marge) existent ; les nœuds de ligne et de bloc sont recyclés (aucune création
//    une fois le pool chaud) ; position par transform ; une propriété de style n'est écrite que si sa valeur change.
//  * Accessibilité native : role=row / rowheader / gridcell (le conteneur porte role=grid et son libellé).
//  * Sans React : appelé à chaque défilement, il ne doit pas passer par une réconciliation.
//  * Horizontal (défilement continu) : la surface a la largeur de la piste ; les blocs du modèle sont décalés de `originX`
//    (position du début du modèle sur la piste) et seuls ceux qui touchent [left, right] ont un nœud. Une ligne n'est
//    revisitée que si son modèle, sa fenêtre horizontale ou son origine changent (l'appelant quantifie la fenêtre).
//  * Bande de capacité : une cellule (un nœud, motif en dégradés CSS) par période du zoom, recyclée comme les blocs ; son
//    libellé (aria-label et infobulle) vient de l'appelant, recalculé seulement si les heures changent. La surcharge se lit
//    là, par période ; la ligne n'est jamais colorée en entier (son débordement vaut pour toute la tranche chargée, des
//    semaines hors de la vue, et la colorait même là où rien n'était planifié).
//  * Édition (block-editor) : un bloc est focalisable (tabindex -1, la grille garde un seul arrêt de tabulation) ; blockAt
//    retrouve le bloc et la ligne d'un nœud (ou d'une poignée posée dedans par l'éditeur).
import { blockColors } from "./block-colors";
import { CAP_PX, visibleRows, type GridBlock, type GridCap, type GridModel, type GridRow } from "./grid-model";

interface BlockEl { el: HTMLDivElement; text: Text; v: Partial<GridBlock>; g: GridBlock | null; row: RowEl | null }
interface CapEl { el: HTMLDivElement; v: Partial<GridCap>; y: number }
interface RowEl { el: HTMLDivElement; header: HTMLDivElement; index: number; model: GridModel | null; span: string; blocks: Map<string, BlockEl>; caps: Map<string, CapEl>; top: number; h: number }

/** Placement horizontal, en pixels de surface. Absent : surface à la largeur du modèle, aucun tri horizontal. */
export interface Horizontal { surfaceWidth: number; originX: number; left: number; right: number }

export interface GridRenderer {
  render(model: GridModel, scrollTop: number, viewHeight: number, h?: Horizontal): void;
  /** Bloc affiché qui contient `target` (ou l'une de ses poignées), avec sa ligne ; null hors bloc. */
  blockAt(target: EventTarget | null): { block: GridBlock; row: GridRow; el: HTMLElement } | null;
  /** Surface des lignes (repère des positions du modèle décalées de originX). */
  readonly surface: HTMLElement;
  stats(): { rowsCreated: number; blocksCreated: number; capsCreated: number };
  destroy(): void;
}

const div = (className: string) => {
  const d = document.createElement("div");
  d.className = className;
  return d;
};

export interface GridRendererOptions {
  overscan?: number;
  /** Libellé accessible (aria-label et infobulle) d'une cellule de capacité ; absent : aucun libellé. */
  capLabel?(c: GridCap): string;
}

/** Fond d'une cellule de capacité : confirmé (plein), tentatif (hachuré), zone de dépassement (hachures), ligne de capacité. */
export function capBackground(c: GridCap): string {
  const layers: string[] = [];
  const bar = (img: string, y: number, h: number) => `${img} 0 ${y}px / 100% ${h}px no-repeat`;
  if (c.overPx > 0) layers.push(bar("var(--wn-cap-over-hatch)", 0, c.overPx));
  if (c.state !== "none") layers.push(bar("linear-gradient(var(--wn-cap-line), var(--wn-cap-line))", c.lineY, 2));
  if (c.tentativePx > 0) layers.push(bar("var(--wn-cap-tentative-hatch)", CAP_PX - c.confirmedPx - c.tentativePx, c.tentativePx));
  if (c.confirmedPx > 0) layers.push(bar("linear-gradient(var(--wn-cap-confirmed), var(--wn-cap-confirmed))", CAP_PX - c.confirmedPx, c.confirmedPx));
  return layers.join(", ");
}

export function createGridRenderer(root: HTMLElement, opts: GridRendererOptions = {}): GridRenderer {
  const overscan = opts.overscan ?? 3;
  const surface = div("wn-surface");
  surface.style.position = "relative";
  root.appendChild(surface);
  const active = new Map<number, RowEl>();
  const freeRows: RowEl[] = [];
  const freeBlocks: BlockEl[] = [];
  const freeCaps: CapEl[] = [];
  let rowsCreated = 0;
  let blocksCreated = 0;
  let capsCreated = 0;
  let size = "";

  const takeRow = (): RowEl => {
    const r = freeRows.pop();
    if (r) { r.el.style.display = ""; return r; }
    rowsCreated++;
    const el = div("wn-row");
    el.setAttribute("role", "row");
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.right = "0";
    const header = div("wn-rowheader");
    header.setAttribute("role", "rowheader");
    el.appendChild(header);
    surface.appendChild(el);
    return { el, header, index: -1, model: null, span: "", blocks: new Map(), caps: new Map(), top: NaN, h: NaN };
  };
  const releaseRow = (r: RowEl) => {
    for (const b of r.blocks.values()) releaseBlock(b);
    r.blocks.clear();
    for (const c of r.caps.values()) releaseCap(c);
    r.caps.clear();
    r.index = -1;
    r.model = null;
    r.span = "";
    r.header.textContent = "";
    r.el.style.display = "none";
    freeRows.push(r);
  };
  const byEl = new WeakMap<Element, BlockEl>();
  const takeBlock = (parent: HTMLElement): BlockEl => {
    const b = freeBlocks.pop() ?? (() => {
      blocksCreated++;
      const el = div("wn-block");
      el.setAttribute("role", "gridcell");
      el.tabIndex = -1;
      el.style.position = "absolute";
      // Origine explicite : sans top/left, un bloc prend sa position statique, sous l'en-tête de ligne (décalé de ~22 px).
      el.style.top = "0";
      el.style.left = "0";
      const text = document.createTextNode("");
      el.appendChild(text);
      const made: BlockEl = { el, text, v: {}, g: null, row: null };
      byEl.set(el, made);
      return made;
    })();
    b.el.style.display = "";
    parent.appendChild(b.el);
    return b;
  };
  const releaseBlock = (b: BlockEl) => {
    b.el.style.display = "none";
    b.el.removeAttribute("data-key");
    b.v = {};
    b.g = null;
    b.row = null;
    freeBlocks.push(b);
  };

  const takeCap = (parent: HTMLElement): CapEl => {
    const c = freeCaps.pop() ?? (() => {
      capsCreated++;
      const el = div("wn-cap");
      el.setAttribute("role", "gridcell");
      el.style.position = "absolute";
      el.style.top = "0";
      el.style.height = `${CAP_PX}px`;
      return { el, v: {}, y: NaN };
    })();
    c.el.style.display = "";
    parent.appendChild(c.el);
    return c;
  };
  const releaseCap = (c: CapEl) => {
    c.el.style.display = "none";
    c.el.removeAttribute("data-from");
    c.v = {};
    c.y = NaN;
    freeCaps.push(c);
  };

  const setCap = (c: CapEl, g: GridCap, y: number, originX: number) => {
    const v = c.v;
    const s = c.el.style;
    const x = g.x + originX;
    if (v.from !== g.from) c.el.setAttribute("data-from", g.from);
    if (v.x !== x || c.y !== y) { s.transform = `translate(${x}px, ${y}px)`; c.y = y; }
    if (v.w !== g.w) s.width = `${g.w}px`;
    if (v.state !== g.state) c.el.className = `wn-cap wn-cap-${g.state}`;
    if (v.confirmedPx !== g.confirmedPx || v.tentativePx !== g.tentativePx || v.overPx !== g.overPx || v.lineY !== g.lineY || v.state !== g.state) s.background = capBackground(g);
    if (opts.capLabel && (v.from !== g.from || v.kind !== g.kind || v.plannedHours !== g.plannedHours || v.capacityHours !== g.capacityHours
      || v.tentativeHours !== g.tentativeHours || v.overtimeHours !== g.overtimeHours || v.overbookedDays !== g.overbookedDays)) {
      const label = opts.capLabel(g);
      c.el.setAttribute("aria-label", label);
      c.el.title = label;
    }
    c.v = { ...g, x };
  };

  const setBlock = (b: BlockEl, g: GridBlock, originX: number) => {
    const v = b.v;
    const s = b.el.style;
    const x = g.x + originX;
    if (v.key !== g.key) b.el.setAttribute("data-key", g.key);
    if (v.x !== x || v.y !== g.y) s.transform = `translate(${x}px, ${g.y}px)`;
    if (v.w !== g.w) s.width = `${g.w}px`;
    if (v.h !== g.h) s.height = `${g.h}px`;
    if (v.color !== g.color || v.tentative !== g.tentative) {
      // Couleurs calculées une fois par couleur (cache) : texte noir ou blanc selon la luminance du fond (WCAG 1.4.3).
      const c = blockColors(g.color, g.tentative);
      s.backgroundColor = c.background;
      s.color = c.text;
      s.borderColor = c.border;
    }
    if (v.label !== g.label) b.text.data = g.label;
    if (v.tentative !== g.tentative) b.el.classList.toggle("wn-tentative", g.tentative);
    b.v = { ...g, x };
  };

  const bindRow = (r: RowEl, model: GridModel, index: number, h: Horizontal) => {
    const span = `${h.originX}:${h.left}:${h.right}`;
    if (r.model === model && r.index === index && r.span === span) return;
    const row = model.rows[index]!;
    r.model = model;
    r.index = index;
    r.span = span;
    if (r.top !== row.top) { r.el.style.transform = `translateY(${row.top}px)`; r.top = row.top; }
    if (r.h !== row.heightPx) { r.el.style.height = `${row.heightPx}px`; r.h = row.heightPx; }
    if (r.header.textContent !== row.name) r.header.textContent = row.name;
    const shown = row.blocks.filter((b) => b.x + h.originX + b.w >= h.left && b.x + h.originX <= h.right);
    const keep = new Set(shown.map((b) => b.key));
    for (const [k, b] of r.blocks) if (!keep.has(k)) { releaseBlock(b); r.blocks.delete(k); }
    for (const g of shown) {
      let b = r.blocks.get(g.key);
      if (!b) { b = takeBlock(r.el); r.blocks.set(g.key, b); }
      setBlock(b, g, h.originX);
      b.g = g;
      b.row = r;
    }
    const capsShown = row.cells.filter((c) => c.x + h.originX + c.w >= h.left && c.x + h.originX <= h.right);
    const capKeep = new Set(capsShown.map((c) => c.from));
    for (const [k, c] of r.caps) if (!capKeep.has(k)) { releaseCap(c); r.caps.delete(k); }
    for (const g of capsShown) {
      let c = r.caps.get(g.from);
      if (!c) { c = takeCap(r.el); r.caps.set(g.from, c); }
      setCap(c, g, row.capY, h.originX);
    }
  };

  return {
    render(model, scrollTop, viewHeight, horizontal) {
      const h = horizontal ?? { surfaceWidth: model.widthPx, originX: 0, left: -Infinity, right: Infinity };
      const next = `${h.surfaceWidth}x${model.heightPx}`;
      if (next !== size) { surface.style.width = `${h.surfaceWidth}px`; surface.style.height = `${model.heightPx}px`; size = next; }
      const want = new Set(visibleRows(model, scrollTop, viewHeight, overscan));
      for (const [i, r] of active) if (!want.has(i)) { releaseRow(r); active.delete(i); }
      for (const i of want) {
        let r = active.get(i);
        if (!r) { r = takeRow(); active.set(i, r); }
        bindRow(r, model, i, h);
      }
    },
    blockAt(target) {
      const el = target instanceof Element ? target.closest(".wn-block") : null;
      const b = el ? byEl.get(el) : undefined;
      const row = b?.row?.model?.rows[b.row.index];
      return b && b.g && row ? { block: b.g, row, el: b.el } : null;
    },
    surface,
    stats: () => ({ rowsCreated, blocksCreated, capsCreated }),
    destroy() {
      root.removeChild(surface);
      active.clear();
      freeRows.length = 0;
      freeBlocks.length = 0;
      freeCaps.length = 0;
    },
  };
}
