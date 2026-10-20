// Rendu DOM de la grille du Schedule (ADR-005 : DOM virtualisé optimisé, A2, porté du spike spikes/grille/src/main-dom-opt.ts).
//  * Seules les lignes visibles (plus une marge) existent ; les nœuds de ligne et de bloc sont recyclés (aucune création
//    une fois le pool chaud) ; position par transform ; une propriété de style n'est écrite que si sa valeur change.
//  * Accessibilité native : role=row / rowheader / gridcell (le conteneur porte role=grid et son libellé).
//  * Sans React : appelé à chaque défilement, il ne doit pas passer par une réconciliation.
//  * Horizontal (défilement continu) : la surface a la largeur de la piste ; les blocs du modèle sont décalés de `originX`
//    (position du début du modèle sur la piste) et seuls ceux qui touchent [left, right] ont un nœud. Une ligne n'est
//    revisitée que si son modèle, sa fenêtre horizontale ou son origine changent (l'appelant quantifie la fenêtre).
import { visibleRows, type GridBlock, type GridModel } from "./grid-model";

interface BlockEl { el: HTMLDivElement; text: Text; v: Partial<GridBlock> }
interface RowEl { el: HTMLDivElement; header: HTMLDivElement; index: number; model: GridModel | null; span: string; blocks: Map<string, BlockEl>; top: number; h: number; overflow: boolean }

/** Placement horizontal, en pixels de surface. Absent : surface à la largeur du modèle, aucun tri horizontal. */
export interface Horizontal { surfaceWidth: number; originX: number; left: number; right: number }

export interface GridRenderer {
  render(model: GridModel, scrollTop: number, viewHeight: number, h?: Horizontal): void;
  stats(): { rowsCreated: number; blocksCreated: number };
  destroy(): void;
}

const div = (className: string) => {
  const d = document.createElement("div");
  d.className = className;
  return d;
};

export function createGridRenderer(root: HTMLElement, opts: { overscan?: number } = {}): GridRenderer {
  const overscan = opts.overscan ?? 3;
  const surface = div("wn-surface");
  surface.style.position = "relative";
  root.appendChild(surface);
  const active = new Map<number, RowEl>();
  const freeRows: RowEl[] = [];
  const freeBlocks: BlockEl[] = [];
  let rowsCreated = 0;
  let blocksCreated = 0;
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
    return { el, header, index: -1, model: null, span: "", blocks: new Map(), top: NaN, h: NaN, overflow: false };
  };
  const releaseRow = (r: RowEl) => {
    for (const b of r.blocks.values()) releaseBlock(b);
    r.blocks.clear();
    r.index = -1;
    r.model = null;
    r.span = "";
    r.header.textContent = "";
    r.el.style.display = "none";
    freeRows.push(r);
  };
  const takeBlock = (parent: HTMLElement): BlockEl => {
    const b = freeBlocks.pop() ?? (() => {
      blocksCreated++;
      const el = div("wn-block");
      el.setAttribute("role", "gridcell");
      el.style.position = "absolute";
      const text = document.createTextNode("");
      el.appendChild(text);
      return { el, text, v: {} };
    })();
    b.el.style.display = "";
    parent.appendChild(b.el);
    return b;
  };
  const releaseBlock = (b: BlockEl) => {
    b.el.style.display = "none";
    b.el.removeAttribute("data-key");
    b.v = {};
    freeBlocks.push(b);
  };

  const setBlock = (b: BlockEl, g: GridBlock, originX: number) => {
    const v = b.v;
    const s = b.el.style;
    const x = g.x + originX;
    if (v.key !== g.key) b.el.setAttribute("data-key", g.key);
    if (v.x !== x || v.y !== g.y) s.transform = `translate(${x}px, ${g.y}px)`;
    if (v.w !== g.w) s.width = `${g.w}px`;
    if (v.h !== g.h) s.height = `${g.h}px`;
    if (v.color !== g.color) s.backgroundColor = g.color ?? "";
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
    if (r.overflow !== row.overflow) { r.el.classList.toggle("wn-overflow", row.overflow); r.overflow = row.overflow; }
    if (r.header.textContent !== row.name) r.header.textContent = row.name;
    const shown = row.blocks.filter((b) => b.x + h.originX + b.w >= h.left && b.x + h.originX <= h.right);
    const keep = new Set(shown.map((b) => b.key));
    for (const [k, b] of r.blocks) if (!keep.has(k)) { releaseBlock(b); r.blocks.delete(k); }
    for (const g of shown) {
      let b = r.blocks.get(g.key);
      if (!b) { b = takeBlock(r.el); r.blocks.set(g.key, b); }
      setBlock(b, g, h.originX);
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
    stats: () => ({ rowsCreated, blocksCreated }),
    destroy() {
      root.removeChild(surface);
      active.clear();
      freeRows.length = 0;
      freeBlocks.length = 0;
    },
  };
}
