// En-tête de dates du Schedule (ADR-005 A2), dans le conteneur qui défile : `position: sticky; top: 0` le garde en haut et
// le défilement horizontal natif le garde aligné sur les blocs, sans recalage en JS.
//  * Seules les cellules de la fenêtre horizontale existent ; leurs nœuds sont recyclés (clé = date de début).
//  * Accessibilité : role=row, cellules role=columnheader (data-from = date de début) ; le coin au-dessus des noms de
//    personnes est collé à gauche et masqué aux lecteurs d'écran (aucun texte d'interface).
//  * Le libellé est fourni par l'appelant (formatage localisé) : ce module ne porte aucune chaîne.
//  * Période courante (RT-027) : classe wn-colheader-current et aria-current="date" (l'information ne repose pas sur la
//    couleur seule) ; samedi et dimanche en vue jour (Q9) : classe wn-colheader-weekend. Marques retirées au recyclage.
//  * Corps de la grille (RT-026, RT-027) : columnsBackground donne le fond de la surface des lignes, un séparateur au début
//    de chaque cellule et une teinte sous la colonne courante, en couches CSS (aucun nœud par colonne).

export interface HeaderItem { from: string; x: number; w: number; label: string; current?: boolean; weekend?: boolean }

/** Fond de la surface des lignes : séparateurs de colonnes (1 px) puis teinte de la colonne courante, en dessous. */
export function columnsBackground(items: readonly HeaderItem[]): string {
  const layer = (token: string, x: number, w: number) => `linear-gradient(var(${token}), var(${token})) ${x}px 0px / ${w}px 100% no-repeat`;
  const lines = items.map((i) => layer("--wn-grid-line", i.x, 1));
  const current = items.filter((i) => i.current).map((i) => layer("--wn-col-current", i.x, i.w));
  return [...lines, ...current].join(", ");
}

export interface HeaderRenderer {
  render(items: readonly HeaderItem[], surfaceWidth: number): void;
  /** Décale les libellés des colonnes à moitié cachées par le coin, à chaque défilement (sans repeindre les cellules). */
  scroll(scrollLeft: number): void;
  stats(): { cellsCreated: number };
  destroy(): void;
}

interface CellEl { el: HTMLDivElement; labelEl: HTMLSpanElement; text: Text; x: number; w: number; label: string; kind: string }

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
  let scrolled = 0;

  // Une colonne qui commence avant la zone visible (sous le coin) garde son libellé visible : il glisse jusqu'à la limite de sa cellule.
  const placeLabel = (c: CellEl) => {
    const hidden = scrolled + opts.gutterPx - c.x;
    const room = Math.max(0, c.w - 2 * 4 - c.labelEl.offsetWidth);
    const shift = Math.min(Math.max(0, hidden), room);
    c.labelEl.style.transform = shift > 0 ? `translateX(${shift}px)` : "";
  };

  const take = (): CellEl => {
    const c = free.pop();
    if (c) { c.el.style.display = ""; c.el.setAttribute("role", "columnheader"); return c; }
    cellsCreated++;
    const el = document.createElement("div");
    el.className = "wn-colheader";
    el.setAttribute("role", "columnheader");
    el.style.position = "absolute";
    el.style.top = "0";
    const labelEl = document.createElement("span");
    labelEl.className = "wn-colheader-label";
    const text = document.createTextNode("");
    labelEl.appendChild(text);
    el.appendChild(labelEl);
    bar.appendChild(el);
    return { el, labelEl, text, x: NaN, w: NaN, label: "", kind: "" };
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
        c.el.removeAttribute("aria-current");
        c.el.className = "wn-colheader";
        c.kind = "";
        free.push(c);
        active.delete(k);
      }
      for (const i of items) {
        let c = active.get(i.from);
        if (!c) { c = take(); c.el.setAttribute("data-from", i.from); active.set(i.from, c); }
        if (c.x !== i.x) { c.el.style.transform = `translateX(${i.x}px)`; c.x = i.x; }
        if (c.w !== i.w) { c.el.style.width = `${i.w}px`; c.w = i.w; }
        if (c.label !== i.label) { c.text.data = i.label; c.label = i.label; }
        placeLabel(c);
        const kind = `${i.current ? "c" : ""}${i.weekend ? "w" : ""}`;
        if (c.kind !== kind) {
          c.el.className = `wn-colheader${i.current ? " wn-colheader-current" : ""}${i.weekend ? " wn-colheader-weekend" : ""}`;
          if (i.current) c.el.setAttribute("aria-current", "date");
          else c.el.removeAttribute("aria-current");
          c.kind = kind;
        }
      }
    },
    scroll(scrollLeft) {
      scrolled = scrollLeft;
      for (const c of active.values()) placeLabel(c);
    },
    stats: () => ({ cellsCreated }),
    destroy() {
      bar.remove();
      active.clear();
      free.length = 0;
    },
  };
}
