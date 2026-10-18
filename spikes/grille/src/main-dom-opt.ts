// Variante A2 (second tour) : DOM virtualisé optimisé de bonne foi.
// - pool de lignes et de blocs recyclés (aucune création/destruction au scroll une fois le pool chaud) ;
// - position par transform, écritures de style seulement si la valeur change ;
// - contain:strict sur lignes, blocs, en-têtes ; option ?cv=1 pour content-visibility:auto sur les lignes ;
// - lectures de layout groupées en tête de frame (scrollTop/scrollLeft), tailles du viewport en cache ;
// - fenêtre horizontale par tranches (chunk = largeur du viewport) : le scroll natif déplace le contenu,
//   le JS ne retravaille que lorsqu'une ligne entre/sort ou qu'on change de tranche.
import { generate, layoutRow, snap, type Alloc, type Placed, type RowLayout } from './engine';
import { benchCore, afterPaint } from './bench-hooks';

const t0 = performance.now();
const PEOPLE = 300, DAYS = 365, ROWH = 64, NAMEW = 160, HEADH = 40, TODAY = 290, OVER = 3;
const ZOOMS = { day: 44, week: 14, month: 4.5 } as const; type Zoom = keyof typeof ZOOMS;
let zoom: Zoom = 'day'; let px: number = ZOOMS[zoom];
const data = generate(PEOPLE, DAYS); const tGen = performance.now() - t0;
const layouts: RowLayout[] = data.map((r) => layoutRow(r, ROWH));
if (new URLSearchParams(location.search).has('cv')) document.body.classList.add('cv');

const $ = (id: string) => document.getElementById(id)!;
const scrollEl = $('scroll'), sizer = $('sizer'), head = $('head'), names = $('names'), grid = $('grid'), todayEl = $('today');
let W = scrollEl.clientWidth, H = scrollEl.clientHeight, CH = W;
names.style.height = PEOPLE * ROWH + 'px'; grid.style.height = PEOPLE * ROWH + 'px';
sizer.style.height = HEADH + PEOPLE * ROWH + 'px';

interface Blk { el: HTMLDivElement; txt: Text; a: Alloc | null; x: number; y: number; w: number; h: number; hue: number; lbl: string; shown: boolean; gen: number }
interface Row { el: HTMLDivElement; nm: HTMLDivElement; idx: number; chunk: number; dirty: boolean; shown: boolean; nmTxt: string; blocks: Map<number, Blk>; free: Blk[] }
const blkOf = new WeakMap<Element, Blk>();
const div = (c: string) => { const d = document.createElement('div'); d.className = c; return d; };

function newBlk(parent: HTMLElement): Blk {
  const el = div('blk') as HTMLDivElement; const txt = document.createTextNode(''); el.appendChild(txt); parent.appendChild(el);
  const b: Blk = { el, txt, a: null, x: NaN, y: NaN, w: NaN, h: NaN, hue: -1, lbl: '', shown: true, gen: 0 }; blkOf.set(el, b); return b;
}
function setBlk(b: Blk, a: Alloc, x: number, y: number, w: number, h: number, lbl: string) {
  b.a = a; const s = b.el.style;
  if (!b.shown) { s.display = ''; b.shown = true; }
  if (x !== b.x || y !== b.y) { s.transform = `translate(${x}px,${y}px)`; b.x = x; b.y = y; }
  if (w !== b.w) { s.width = w + 'px'; b.w = w; }
  if (h !== b.h) { s.height = h + 'px'; b.h = h; }
  if (a.hue !== b.hue) { s.backgroundColor = `hsl(${a.hue} 55% 45%)`; b.hue = a.hue; }
  if (lbl !== b.lbl) { b.txt.data = lbl; b.lbl = lbl; }
}
function hideBlk(b: Blk) { if (b.shown) { b.el.style.display = 'none'; b.shown = false; } b.a = null; }

const rows = new Map<number, Row>(); const freeRows: Row[] = [];
function newRow(): Row {
  const el = div('row') as HTMLDivElement; el.style.width = DAYS * px + 'px'; grid.appendChild(el);
  const nm = div('nm') as HTMLDivElement; names.appendChild(nm);
  return { el, nm, idx: -1, chunk: NaN, dirty: true, shown: true, nmTxt: '', blocks: new Map(), free: [] };
}
let gen = 0; const vis: Placed[] = [];
function bindRow(r: Row, i: number, chunk: number) {
  if (!r.shown) { r.el.style.display = ''; r.nm.style.display = ''; r.shown = true; }
  if (r.idx !== i) {
    r.idx = i; const t = `translateY(${i * ROWH}px)`; r.el.style.transform = t; r.nm.style.transform = t; r.dirty = true;
    for (const b of r.blocks.values()) r.free.push(b); r.blocks.clear();
  }
  if (!r.dirty && r.chunk === chunk) return;
  r.chunk = chunk; r.dirty = false;
  const lay = layouts[i]; const nt = `P${i}${lay.over ? ' ▲' : ''}`;
  if (nt !== r.nmTxt) { r.nm.textContent = nt; r.nm.classList.toggle('over', lay.over); r.nmTxt = nt; }
  const wl = (chunk - 1) * CH, wr = (chunk + 2) * CH; const g = ++gen; vis.length = 0;
  for (const p of lay.placed) {
    const x = p.a.start * px, w = p.a.len * px; if (x + w < wl || x > wr) continue;
    vis.push(p); const b = r.blocks.get(p.a.id); if (b) b.gen = g;
  }
  for (const [id, b] of r.blocks) if (b.gen !== g) { r.blocks.delete(id); r.free.push(b); }
  const lblOn = px >= 14;
  for (const p of vis) {
    let b = r.blocks.get(p.a.id);
    if (!b) { b = r.free.pop() ?? newBlk(r.el); b.gen = g; r.blocks.set(p.a.id, b); }
    setBlk(b, p.a, p.a.start * px, p.y, Math.max(2, p.a.len * px - 1), p.h, lblOn ? `${Math.round(p.a.pct * 100)}%` : '');
  }
  for (const b of r.free) if (b.shown) hideBlk(b);
}

// En-tête : pool de cellules, rebind uniquement au changement de tranche ou de zoom.
interface HC { el: HTMLDivElement; x: number; w: number; lbl: string; shown: boolean }
const hcs: HC[] = [];
function drawHead(chunk: number) {
  const wl = (chunk - 1) * CH, wr = (chunk + 2) * CH; const step = zoom === 'day' ? 1 : zoom === 'week' ? 7 : 30; let k = 0;
  for (let d = Math.max(0, Math.floor(wl / px / step) * step); d < DAYS; d += step) {
    const x = d * px; if (x > wr) break; if (x + step * px < wl) continue;
    let c = hcs[k]; if (!c) { const el = div('hc') as HTMLDivElement; el.style.height = '40px'; head.appendChild(el); c = hcs[k] = { el, x: NaN, w: NaN, lbl: '', shown: true }; }
    k++;
    const lbl = zoom === 'day' ? String(new Date(Date.UTC(2026, 0, 1 + d)).getUTCDate()) : zoom === 'week' ? 'S' + Math.floor(d / 7 + 1) : 'M' + (Math.floor(d / 30) + 1);
    if (!c.shown) { c.el.style.display = ''; c.shown = true; }
    if (c.x !== x) { c.el.style.transform = `translateX(${NAMEW + x}px)`; c.x = x; }
    if (c.w !== step * px) { c.el.style.width = step * px + 'px'; c.w = step * px; }
    if (c.lbl !== lbl) { c.el.textContent = lbl; c.lbl = lbl; }
  }
  for (; k < hcs.length; k++) if (hcs[k].shown) { hcs[k].el.style.display = 'none'; hcs[k].shown = false; }
}

function applyWidths() {
  const tw = DAYS * px;
  sizer.style.width = NAMEW + tw + 'px'; head.style.width = NAMEW + tw + 'px'; grid.style.width = tw + 'px';
  for (const r of rows.values()) r.el.style.width = tw + 'px'; for (const r of freeRows) r.el.style.width = tw + 'px';
  // fond : week-ends (jours 2-3 de chaque période, le 2026-01-01 est un jeudi) + traits de jour en zoom jour
  let img = `linear-gradient(to right, transparent ${2 * px}px, #f1f1f4 ${2 * px}px, #f1f1f4 ${4 * px}px, transparent ${4 * px}px)`; let size = `${7 * px}px 100%`;
  if (zoom === 'day') { img = `linear-gradient(to right, #ececec 1px, transparent 1px), ${img}`; size = `${px}px 100%, ${size}`; }
  grid.style.backgroundImage = img; grid.style.backgroundSize = size;
  todayEl.style.transform = `translateX(${TODAY * px}px)`;
}

let cur = { r0: -1, r1: -1, chunk: NaN }; let forceAll = true;
const renderCost: number[] = [];
function render() {
  const c0 = performance.now();
  const st = scrollEl.scrollTop, sl = scrollEl.scrollLeft; // lectures groupées, layout propre à ce stade
  const r0 = Math.max(0, Math.floor(st / ROWH) - OVER), r1 = Math.min(PEOPLE - 1, Math.floor((st + H - HEADH) / ROWH) + OVER);
  const chunk = Math.floor(sl / CH);
  if (forceAll || r0 !== cur.r0 || r1 !== cur.r1 || chunk !== cur.chunk) {
    for (const [i, r] of rows) if (i < r0 || i > r1) { rows.delete(i); freeRows.push(r); }
    for (let i = r0; i <= r1; i++) {
      let r = rows.get(i); if (!r) { r = freeRows.pop() ?? newRow(); rows.set(i, r); }
      if (forceAll) r.dirty = true; bindRow(r, i, chunk);
    }
    for (const r of freeRows) if (r.shown) { r.el.style.display = 'none'; r.nm.style.display = 'none'; r.shown = false; }
    if (forceAll || chunk !== cur.chunk) drawHead(chunk);
    cur = { r0, r1, chunk }; forceAll = false;
  }
  renderCost.push(performance.now() - c0);
}
let pending = false;
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
scrollEl.addEventListener('scroll', schedule, { passive: true });
new ResizeObserver(() => { W = scrollEl.clientWidth; H = scrollEl.clientHeight; CH = W; forceAll = true; schedule(); }).observe(scrollEl);

const metrics: Record<string, any> = { dataGenMs: tGen, zoomMs: [], todayMs: [], moveLatency: [] };
function setZoom(z: Zoom) {
  const s = performance.now(); const center = (scrollEl.scrollLeft + W / 2 - NAMEW) / px;
  zoom = z; px = ZOOMS[z]; applyWidths();
  scrollEl.scrollLeft = Math.max(0, center * px + NAMEW - W / 2);
  forceAll = true; render(); afterPaint(() => metrics.zoomMs.push(performance.now() - s));
}
function goToday() { const s = performance.now(); scrollEl.scrollLeft = Math.max(0, TODAY * px - W / 2 + NAMEW); render(); afterPaint(() => metrics.todayMs.push(performance.now() - s)); }
$('zd').onclick = () => setZoom('day'); $('zw').onclick = () => setZoom('week'); $('zm').onclick = () => setZoom('month'); $('today-btn').onclick = goToday;

// --- Drag / resize (gauche, droite, hauteur) : mode déduit de la position dans le bloc (pas de nœuds poignées) ---
type Mode = 'move' | 'l' | 'r' | 'h';
let drag: null | { a: Alloc; mode: Mode; x0: number; y0: number; orig: Alloc } = null; let pend: PointerEvent | null = null; let dragEl: HTMLElement | null = null;
grid.addEventListener('pointerdown', (e) => {
  const el = (e.target as HTMLElement).closest('.blk'); if (!el) return; const b = blkOf.get(el); if (!b?.a) return;
  const rc = el.getBoundingClientRect(); const ox = e.clientX - rc.left, oy = e.clientY - rc.top;
  const mode: Mode = ox < 6 ? 'l' : ox > rc.width - 6 ? 'r' : oy > rc.height - 4 ? 'h' : 'move';
  grid.setPointerCapture(e.pointerId); drag = { a: b.a, mode, x0: e.clientX, y0: e.clientY, orig: { ...b.a } };
  el.classList.add('drag'); dragEl = el as HTMLElement;
});
grid.addEventListener('pointermove', (e) => { if (!drag) return; pend = e; requestAnimationFrame(applyDrag); });
function applyDrag() {
  const e = pend; if (!e || !drag) return; pend = null; const c0 = performance.now();
  const { a, orig, mode } = drag; const dd = snap(e.clientX - drag.x0, px); const oldP = a.person;
  if (mode === 'move') { a.start = Math.max(0, Math.min(DAYS - a.len, orig.start + dd)); a.person = Math.max(0, Math.min(PEOPLE - 1, orig.person + snap(e.clientY - drag.y0, ROWH))); }
  else if (mode === 'r') a.len = Math.max(1, Math.min(DAYS - a.start, orig.len + dd));
  else if (mode === 'l') { const ns = Math.max(0, Math.min(orig.start + orig.len - 1, orig.start + dd)); a.start = ns; a.len = orig.start + orig.len - ns; }
  else a.pct = Math.max(0.1, Math.min(1.5, orig.pct - (e.clientY - drag.y0) / (ROWH - 4)));
  if (a.person !== oldP) { data[oldP] = data[oldP].filter((x) => x !== a); data[a.person].push(a); data[a.person].sort((x, y) => x.start - y.start || x.id - y.id); }
  for (const p of new Set([oldP, a.person])) { layouts[p] = layoutRow(data[p], ROWH); const r = rows.get(p); if (r) { r.dirty = true; bindRow(r, p, cur.chunk); } }
  const nb = rows.get(a.person)?.blocks.get(a.id);
  if (nb && nb.el !== dragEl) { dragEl?.classList.remove('drag'); nb.el.classList.add('drag'); dragEl = nb.el; }
  renderCost.push(performance.now() - c0);
  metrics.moveLatency.push(performance.now() - e.timeStamp);
}
const end = () => { if (drag) { dragEl?.classList.remove('drag'); dragEl = null; drag = null; } };
grid.addEventListener('pointerup', end); grid.addEventListener('pointercancel', end);

const core = benchCore(scrollEl, PEOPLE * ROWH - 400);
(window as any).__bench = {
  ...core, renderCost, ROWH, NAMEW, HEADH, metrics, setZoom, goToday, scrollEl,
  domNodes: () => document.getElementsByTagName('*').length,
  blocks: () => { let n = 0; for (const r of rows.values()) n += r.blocks.size; return n; },
  totalAllocs: () => data.reduce((n, r) => n + r.length, 0),
};
applyWidths(); render(); goToday();
afterPaint(() => { metrics.firstRenderMs = performance.now() - t0; (window as any).__ready = true; });
