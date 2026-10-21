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
//  * Congés : un nœud par congé visible (recyclé comme les blocs), derrière les blocs (z-index CSS), focalisable
//    (tabindex -1) ; teinte du type (classe wn-timeoff-tone-N), motif pour « en attente » et « refusé » (classes de statut :
//    l'information ne repose pas sur la couleur seule) ; libellé accessible de l'appelant. timeoffAt retrouve le congé d'un nœud.
//  * En-tête de ligne (colonne de gauche, ux-ui §2.1) : avatar à initiales, nom, rôle, département en pastille, jauge de la
//    période visible (barre + pourcentage, ▲ et « +N h » au-delà de 100 % : redondance non chromatique, WCAG 1.4.1). La
//    jauge n'est recalculée (gaugeOf, O(1)) que si la ligne ou la période change, et un nœud n'est écrit que si sa valeur change.
import { blockColors } from "./block-colors";
import { CAP_PX, gaugeOf, visibleRows, type GridBlock, type GridCap, type GridGauge, type GridModel, type GridRow, type GridTimeoff } from "./grid-model";

interface BlockEl { el: HTMLDivElement; text: Text; v: Partial<GridBlock>; g: GridBlock | null; row: RowEl | null }
interface CapEl { el: HTMLDivElement; v: Partial<GridCap>; y: number; h: number }
interface OffEl { el: HTMLDivElement; text: Text; v: Partial<GridTimeoff>; g: GridTimeoff | null; row: RowEl | null }
interface HeadEl {
  avatar: HTMLSpanElement; name: Text; role: HTMLSpanElement; dept: HTMLSpanElement; gauge: HTMLSpanElement; fill: HTMLSpanElement; value: Text;
  /** Valeurs écrites (identité, jauge) et clé ligne + période de la jauge affichée. */
  v: { name?: string; initials?: string; role?: string; department?: string };
  g: Partial<GridGauge>; key: string; model: GridModel | null;
}
interface RowEl {
  el: HTMLDivElement; header: HTMLDivElement; head: HeadEl; index: number; model: GridModel | null; span: string; blocks: Map<string, BlockEl>; caps: Map<string, CapEl>;
  offs: Map<string, OffEl>; top: number; h: number;
}

/** Placement horizontal, en pixels de surface. Absent : surface à la largeur du modèle, aucun tri horizontal. */
export interface Horizontal { surfaceWidth: number; originX: number; left: number; right: number }

export interface GridRenderer {
  /** `period` : jours visibles, période de la jauge par personne (absente : toute la tranche du modèle). */
  render(model: GridModel, scrollTop: number, viewHeight: number, h?: Horizontal, period?: { from: string; to: string }): void;
  /** Bloc affiché qui contient `target` (ou l'une de ses poignées), avec sa ligne ; null hors bloc. */
  blockAt(target: EventTarget | null): { block: GridBlock; row: GridRow; el: HTMLElement } | null;
  /** Congé affiché qui contient `target`, avec sa ligne ; null hors congé. */
  timeoffAt(target: EventTarget | null): { timeoff: GridTimeoff; row: GridRow; el: HTMLElement } | null;
  /** Surface des lignes (repère des positions du modèle décalées de originX). */
  readonly surface: HTMLElement;
  stats(): { rowsCreated: number; blocksCreated: number; capsCreated: number };
  /** Nouveaux libellés (changement de locale) : chaque ligne affichée est réécrite au prochain render. */
  setLabels(l: Pick<GridRendererOptions, "capLabel" | "blockLabel" | "timeoffLabel" | "gaugeLabel">): void;
  destroy(): void;
}

const div = (className: string) => {
  const d = document.createElement("div");
  d.className = className;
  return d;
};
const span = (className: string, parent: HTMLElement) => {
  const d = document.createElement("span");
  d.className = className;
  parent.appendChild(d);
  return d;
};
const textIn = (parent: HTMLElement) => parent.appendChild(document.createTextNode(""));

/** Texte et infobulle d'une jauge sans catalogue (tests) : pourcentage, ▲ et +N h en dépassement. */
const defaultGaugeLabel = (g: GridGauge) => {
  const text = g.state === "over" ? `▲ ${g.percent === null ? "" : `${g.percent} % `}+${g.overHours} h` : g.percent === null ? "—" : `${g.percent} %`;
  return { text, title: `${g.from} – ${g.to} : ${g.plannedHours} h / ${g.capacityHours} h` };
};

export interface GridRendererOptions {
  overscan?: number;
  /** Libellé accessible (aria-label et infobulle) d'une cellule de capacité ; absent : aucun libellé. */
  capLabel?(c: GridCap): string;
  /** Libellé accessible d'un bloc (projet, dates, quantité) ; recalculé seulement si l'un d'eux change. */
  blockLabel?(b: GridBlock): string;
  /** Libellé accessible d'un congé (type, dates, demi-journées, statut). */
  timeoffLabel?(t: GridTimeoff): string;
  /** Jauge d'une personne : texte visible (pourcentage, ▲ +N h) et infobulle (« du … au … : X h planifiées sur Y h »). */
  gaugeLabel?(g: GridGauge): { text: string; title: string };
}

/**
 * Fond d'une cellule de capacité : confirmé (plein), tentatif (hachuré), zone de dépassement (hachures), ligne de capacité ;
 * `capPx` : hauteur de la bande (densité du modèle). */
export function capBackground(c: GridCap, capPx = CAP_PX): string {
  const layers: string[] = [];
  const bar = (img: string, y: number, h: number) => `${img} 0 ${y}px / 100% ${h}px no-repeat`;
  if (c.overPx > 0) layers.push(bar("var(--wn-cap-over-hatch)", 0, c.overPx));
  if (c.state !== "none") layers.push(bar("linear-gradient(var(--wn-cap-line), var(--wn-cap-line))", c.lineY, 2));
  if (c.tentativePx > 0) layers.push(bar("var(--wn-cap-tentative-hatch)", capPx - c.confirmedPx - c.tentativePx, c.tentativePx));
  if (c.confirmedPx > 0) layers.push(bar("linear-gradient(var(--wn-cap-confirmed), var(--wn-cap-confirmed))", capPx - c.confirmedPx, c.confirmedPx));
  return layers.join(", ");
}

export function createGridRenderer(root: HTMLElement, options: GridRendererOptions = {}): GridRenderer {
  const opts = { ...options };
  const overscan = opts.overscan ?? 3;
  const surface = div("wn-surface");
  surface.style.position = "relative";
  root.appendChild(surface);
  const active = new Map<number, RowEl>();
  const freeRows: RowEl[] = [];
  const freeBlocks: BlockEl[] = [];
  const freeCaps: CapEl[] = [];
  const freeOffs: OffEl[] = [];
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
    const avatar = span("wn-person-avatar", header);
    avatar.setAttribute("aria-hidden", "true");
    const person = span("wn-person", header);
    const name = textIn(span("wn-person-name", person));
    const meta = span("wn-person-meta", person);
    const role = span("wn-person-role", meta);
    const dept = span("wn-person-dept", meta);
    const gauge = span("wn-gauge", person);
    gauge.setAttribute("role", "img");
    const fill = span("wn-gauge-fill", span("wn-gauge-track", gauge));
    const value = textIn(span("wn-gauge-value", gauge));
    el.appendChild(header);
    surface.appendChild(el);
    const head: HeadEl = { avatar, name, role, dept, gauge, fill, value, v: {}, g: {}, key: "", model: null };
    return { el, header, head, index: -1, model: null, span: "", blocks: new Map(), caps: new Map(), offs: new Map(), top: NaN, h: NaN };
  };
  const releaseRow = (r: RowEl) => {
    for (const b of r.blocks.values()) releaseBlock(b);
    r.blocks.clear();
    for (const c of r.caps.values()) releaseCap(c);
    r.caps.clear();
    for (const o of r.offs.values()) releaseOff(o);
    r.offs.clear();
    r.index = -1;
    r.model = null;
    r.span = "";
    r.head.name.data = "";
    r.head.v = {};
    r.head.g = {};
    r.head.key = "";
    r.head.model = null;
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

  const offByEl = new WeakMap<Element, OffEl>();
  const takeOff = (parent: HTMLElement): OffEl => {
    const o = freeOffs.pop() ?? (() => {
      const el = div("wn-timeoff");
      el.setAttribute("role", "gridcell");
      el.tabIndex = -1;
      el.style.position = "absolute";
      el.style.top = "0";
      el.style.left = "0";
      const text = document.createTextNode("");
      el.appendChild(text);
      const made: OffEl = { el, text, v: {}, g: null, row: null };
      offByEl.set(el, made);
      return made;
    })();
    o.el.style.display = "";
    // Avant les blocs : sous eux dans l'ordre du document comme à l'écran.
    parent.insertBefore(o.el, parent.children[1] ?? null);
    return o;
  };
  const releaseOff = (o: OffEl) => {
    o.el.style.display = "none";
    o.el.removeAttribute("data-timeoff");
    o.v = {};
    o.g = null;
    o.row = null;
    freeOffs.push(o);
  };
  const setOff = (o: OffEl, g: GridTimeoff, originX: number) => {
    const v = o.v;
    const s = o.el.style;
    const x = g.x + originX;
    if (v.key !== g.key) o.el.setAttribute("data-timeoff", g.key);
    if (v.x !== x) s.transform = `translate(${x}px, 0px)`;
    if (v.w !== g.w) s.width = `${g.w}px`;
    if (v.h !== g.h) s.height = `${g.h}px`;
    if (v.tone !== g.tone || v.status !== g.status) o.el.className = `wn-timeoff wn-timeoff-tone-${g.tone} wn-timeoff-${g.status}`;
    if (v.typeName !== g.typeName) o.text.data = g.typeName;
    if (opts.timeoffLabel && (v.typeName !== g.typeName || v.startDate !== g.startDate || v.endDate !== g.endDate || v.startHalf !== g.startHalf
      || v.endHalf !== g.endHalf || v.status !== g.status || v.scope !== g.scope || v.hoursPerDay !== g.hoursPerDay)) {
      const label = opts.timeoffLabel(g);
      o.el.setAttribute("aria-label", label);
      o.el.title = label;
    }
    o.v = { ...g, x };
  };

  const takeCap = (parent: HTMLElement): CapEl => {
    const c = freeCaps.pop() ?? (() => {
      capsCreated++;
      const el = div("wn-cap");
      el.setAttribute("role", "gridcell");
      el.style.position = "absolute";
      el.style.top = "0";
      return { el, v: {}, y: NaN, h: NaN };
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

  const setCap = (c: CapEl, g: GridCap, y: number, originX: number, capPx: number) => {
    const v = c.v;
    const s = c.el.style;
    const x = g.x + originX;
    if (c.h !== capPx) { s.height = `${capPx}px`; c.h = capPx; c.v = {}; }
    if (v.from !== g.from) c.el.setAttribute("data-from", g.from);
    if (v.x !== x || c.y !== y) { s.transform = `translate(${x}px, ${y}px)`; c.y = y; }
    if (v.w !== g.w) s.width = `${g.w}px`;
    if (v.state !== g.state) c.el.className = `wn-cap wn-cap-${g.state}`;
    if (v.confirmedPx !== g.confirmedPx || v.tentativePx !== g.tentativePx || v.overPx !== g.overPx || v.lineY !== g.lineY || v.state !== g.state) s.background = capBackground(g, capPx);
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
    if (opts.blockLabel && (v.label !== g.label || v.startDate !== g.startDate || v.endDate !== g.endDate || v.hoursPerDay !== g.hoursPerDay
      || v.percent !== g.percent || v.tentative !== g.tentative || v.repeat !== g.repeat)) b.el.setAttribute("aria-label", opts.blockLabel(g));
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
    const hv = r.head.v;
    if (hv.name !== row.name) { r.head.name.data = row.name; hv.name = row.name; }
    if (hv.initials !== row.initials) { r.head.avatar.textContent = row.initials; hv.initials = row.initials; }
    if (hv.role !== row.role) { r.head.role.textContent = row.role; r.head.role.hidden = row.role === ""; hv.role = row.role; }
    if (hv.department !== row.department) { r.head.dept.textContent = row.department; r.head.dept.hidden = row.department === ""; hv.department = row.department; }
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
    const offsShown = row.timeoffs.filter((t) => t.x + h.originX + t.w >= h.left && t.x + h.originX <= h.right);
    const offKeep = new Set(offsShown.map((t) => t.key));
    for (const [k, o] of r.offs) if (!offKeep.has(k)) { releaseOff(o); r.offs.delete(k); }
    for (const g of offsShown) {
      let o = r.offs.get(g.key);
      if (!o) { o = takeOff(r.el); r.offs.set(g.key, o); }
      setOff(o, g, h.originX);
      o.g = g;
      o.row = r;
    }
    const capsShown = row.cells.filter((c) => c.x + h.originX + c.w >= h.left && c.x + h.originX <= h.right);
    const capKeep = new Set(capsShown.map((c) => c.from));
    for (const [k, c] of r.caps) if (!capKeep.has(k)) { releaseCap(c); r.caps.delete(k); }
    for (const g of capsShown) {
      let c = r.caps.get(g.from);
      if (!c) { c = takeCap(r.el); r.caps.set(g.from, c); }
      setCap(c, g, row.capY, h.originX, model.capPx);
    }
  };

  /** Jauge de la ligne sur la période : recalculée si la ligne ou la période change ; nœuds écrits si leur valeur change. */
  const bindGauge = (r: RowEl, model: GridModel, period: { from: string; to: string }) => {
    const row = model.rows[r.index]!;
    const head = r.head;
    // Le modèle compte : une reconstruction (données, densité) garde les indices de ligne avec d'autres charges.
    const key = `${r.index}:${period.from}..${period.to}`;
    if (head.model === model && head.key === key) return;
    head.model = model;
    head.key = key;
    const g = gaugeOf(row, period, model.thresholds);
    const v = head.g;
    if (v.state !== g.state) head.gauge.className = `wn-gauge wn-gauge-${g.state}`;
    if (v.fill !== g.fill) head.fill.style.width = `${g.fill}%`;
    if (v.from !== g.from || v.to !== g.to || v.plannedHours !== g.plannedHours || v.capacityHours !== g.capacityHours || v.percent !== g.percent
      || v.overHours !== g.overHours || v.state !== g.state) {
      const l = (opts.gaugeLabel ?? defaultGaugeLabel)(g);
      head.value.data = l.text;
      head.gauge.title = l.title;
      head.gauge.setAttribute("aria-label", `${l.text}, ${l.title}`);
    }
    head.g = g;
  };

  return {
    render(model, scrollTop, viewHeight, horizontal, period) {
      const h = horizontal ?? { surfaceWidth: model.widthPx, originX: 0, left: -Infinity, right: Infinity };
      const next = `${h.surfaceWidth}x${model.heightPx}`;
      if (next !== size) { surface.style.width = `${h.surfaceWidth}px`; surface.style.height = `${model.heightPx}px`; size = next; }
      const want = new Set(visibleRows(model, scrollTop, viewHeight, overscan));
      for (const [i, r] of active) if (!want.has(i)) { releaseRow(r); active.delete(i); }
      for (const i of want) {
        let r = active.get(i);
        if (!r) { r = takeRow(); active.set(i, r); }
        bindRow(r, model, i, h);
        bindGauge(r, model, period ?? model);
      }
    },
    blockAt(target) {
      const el = target instanceof Element ? target.closest(".wn-block") : null;
      const b = el ? byEl.get(el) : undefined;
      const row = b?.row?.model?.rows[b.row.index];
      return b && b.g && row ? { block: b.g, row, el: b.el } : null;
    },
    timeoffAt(target) {
      const el = target instanceof Element ? target.closest(".wn-timeoff") : null;
      const o = el ? offByEl.get(el) : undefined;
      const row = o?.row?.model?.rows[o.row.index];
      return o && o.g && row ? { timeoff: o.g, row, el: o.el } : null;
    },
    surface,
    stats: () => ({ rowsCreated, blocksCreated, capsCreated }),
    setLabels(l) {
      opts.capLabel = l.capLabel;
      opts.blockLabel = l.blockLabel;
      opts.timeoffLabel = l.timeoffLabel;
      opts.gaugeLabel = l.gaugeLabel;
      for (const r of active.values()) {
        r.model = null;
        r.head.g = {};
        r.head.key = "";
        for (const b of r.blocks.values()) b.v = {};
        for (const o of r.offs.values()) o.v = {};
        for (const c of r.caps.values()) c.v = {};
      }
    },
    destroy() {
      root.removeChild(surface);
      active.clear();
      freeRows.length = 0;
      freeBlocks.length = 0;
      freeCaps.length = 0;
      freeOffs.length = 0;
    },
  };
}
