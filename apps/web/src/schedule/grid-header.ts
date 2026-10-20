// En-tête de dates du Schedule (ADR-005 A2), dans le conteneur qui défile : `position: sticky; top: 0` le garde en haut et
// le défilement horizontal natif le garde aligné sur les blocs, sans recalage en JS.
//  * Seules les cellules de la fenêtre horizontale existent ; leurs nœuds sont recyclés (clé = date de début).
//  * Accessibilité : role=row, cellules role=columnheader (data-from = date de début) ; le coin au-dessus des noms de
//    personnes est collé à gauche et masqué aux lecteurs d'écran (aucun texte d'interface).
//  * Le libellé est fourni par l'appelant (formatage localisé) : ce module ne porte aucune chaîne.

export interface HeaderItem { from: string; x: number; w: number; label: string }

export interface HeaderRenderer {
  render(items: readonly HeaderItem[], surfaceWidth: number): void;
  stats(): { cellsCreated: number };
  destroy(): void;
}

interface CellEl { el: HTMLDivElement; text: Text; x: number; w: number; label: string }

export function createHeaderRenderer(root: HTMLElement, opts: { heightPx: number; gutterPx: number }): HeaderRenderer {
  const bar = document.createElement("div");
  bar.className = "wn-header";
  bar.setAttribute("role", "row");
  Object.assign(bar.style, { position: "sticky", top: "0", height: `${opts.heightPx}px`, zIndex: "2" });
  const corner = document.createElement("div");
  corner.className = "wn-corner";
  corner.setAttribute("aria-hidden", "true");
  Object.assign(corner.style, { position: "sticky", left: "0", width: `${opts.gutterPx}px`, height: "100%", zIndex: "1" });
  bar.appendChild(corner);
  root.insertBefore(bar, root.firstChild);

  const active = new Map<string, CellEl>();
  const free: CellEl[] = [];
  let cellsCreated = 0;
  let width = -1;

  const take = (): CellEl => {
    const c = free.pop();
    if (c) { c.el.style.display = ""; c.el.setAttribute("role", "columnheader"); return c; }
    cellsCreated++;
    const el = document.createElement("div");
    el.className = "wn-colheader";
    el.setAttribute("role", "columnheader");
    el.style.position = "absolute";
    el.style.top = "0";
    const text = document.createTextNode("");
    el.appendChild(text);
    bar.appendChild(el);
    return { el, text, x: NaN, w: NaN, label: "" };
  };

  return {
    render(items, surfaceWidth) {
      if (surfaceWidth !== width) { bar.style.width = `${surfaceWidth}px`; width = surfaceWidth; }
      const want = new Set(items.map((i) => i.from));
      for (const [k, c] of active) {
        if (want.has(k)) continue;
        c.el.style.display = "none";
        c.el.removeAttribute("role"); // hors champ : ni cellule pour l'arbre d'accessibilité, ni date
        c.el.removeAttribute("data-from");
        free.push(c);
        active.delete(k);
      }
      for (const i of items) {
        let c = active.get(i.from);
        if (!c) { c = take(); c.el.setAttribute("data-from", i.from); active.set(i.from, c); }
        if (c.x !== i.x) { c.el.style.transform = `translateX(${i.x}px)`; c.x = i.x; }
        if (c.w !== i.w) { c.el.style.width = `${i.w}px`; c.w = i.w; }
        if (c.label !== i.label) { c.text.data = i.label; c.label = i.label; }
      }
    },
    stats: () => ({ cellsCreated }),
    destroy() {
      bar.remove();
      active.clear();
      free.length = 0;
    },
  };
}
