// Rendu DOM de la grille du Schedule (ADR-005 : DOM virtualisé optimisé, A2, porté du spike spikes/grille/src/main-dom-opt.ts).
//  * Seules les lignes visibles (plus une marge) existent ; les nœuds de ligne et de bloc sont recyclés (aucune création
//    une fois le pool chaud) ; position par transform ; une propriété de style n'est écrite que si sa valeur change.
//  * Accessibilité native : role=row / rowheader / gridcell (le conteneur porte role=grid et son libellé).
//  * Sans React : appelé à chaque défilement, il ne doit pas passer par une réconciliation.
import { visibleRows, type GridBlock, type GridModel } from "./grid-model";

interface BlockEl { el: HTMLDivElement; text: Text; v: Partial<GridBlock> }
interface RowEl { el: HTMLDivElement; header: HTMLDivElement; index: number; model: GridModel | null; blocks: Map<string, BlockEl>; top: number; h: number; overflow: boolean }

export interface GridRenderer {
  render(model: GridModel, scrollTop: number, viewHeight: number): void;
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
    return { el, header, index: -1, model: null, blocks: new Map(), top: NaN, h: NaN, overflow: false };
  };
  const releaseRow = (r: RowEl) => {
    for (const b of r.blocks.values()) releaseBlock(b);
    r.blocks.clear();
    r.index = -1;
    r.model = null;
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

  const setBlock = (b: BlockEl, g: GridBlock) => {
    const v = b.v;
    const s = b.el.style;
    if (v.key !== g.key) b.el.setAttribute("data-key", g.key);
    if (v.x !== g.x || v.y !== g.y) s.transform = `translate(${g.x}px, ${g.y}px)`;
    if (v.w !== g.w) s.width = `${g.w}px`;
    if (v.h !== g.h) s.height = `${g.h}px`;
    if (v.color !== g.color) s.backgroundColor = g.color ?? "";
    if (v.label !== g.label) b.text.data = g.label;
    if (v.tentative !== g.tentative) b.el.classList.toggle("wn-tentative", g.tentative);
    b.v = { ...g };
  };

  const bindRow = (r: RowEl, model: GridModel, index: number) => {
    if (r.model === model && r.index === index) return;
    const row = model.rows[index]!;
    r.model = model;
    r.index = index;
    if (r.top !== row.top) { r.el.style.transform = `translateY(${row.top}px)`; r.top = row.top; }
    if (r.h !== row.heightPx) { r.el.style.height = `${row.heightPx}px`; r.h = row.heightPx; }
    if (r.overflow !== row.overflow) { r.el.classList.toggle("wn-overflow", row.overflow); r.overflow = row.overflow; }
    if (r.header.textContent !== row.name) r.header.textContent = row.name;
    const keep = new Set(row.blocks.map((b) => b.key));
    for (const [k, b] of r.blocks) if (!keep.has(k)) { releaseBlock(b); r.blocks.delete(k); }
    for (const g of row.blocks) {
      let b = r.blocks.get(g.key);
      if (!b) { b = takeBlock(r.el); r.blocks.set(g.key, b); }
      setBlock(b, g);
    }
  };

  return {
    render(model, scrollTop, viewHeight) {
      const next = `${model.widthPx}x${model.heightPx}`;
      if (next !== size) { surface.style.width = `${model.widthPx}px`; surface.style.height = `${model.heightPx}px`; size = next; }
      const want = new Set(visibleRows(model, scrollTop, viewHeight, overscan));
      for (const [i, r] of active) if (!want.has(i)) { releaseRow(r); active.delete(i); }
      for (const i of want) {
        let r = active.get(i);
        if (!r) { r = takeRow(); active.set(i, r); }
        bindRow(r, model, i);
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
