// Variante B2 (second tour) : canvas 2D complété.
// - DPR natif (backing store = taille CSS x devicePixelRatio) ;
// - fond fixe en cache : motif bitmap (week-ends, traits de jour, séparateurs de ligne) + tuiles d'en-tête ;
// - rendu incrémental : au scroll, recopie du corps décalé (blit) + redessin des seules bandes exposées ;
//   pendant le drag, redessin des seules bandes de lignes modifiées (dirty rects). ?blit=0 désactive le blit ;
// - étirement à gauche ;
// - ?a11y=1 : overlay DOM minimal (role=grid, lignes/cellules de la fenêtre visible, clavier, annonce) = variante B3.
import { generate, layoutRow, snap, type Alloc, type RowLayout } from './engine';
import { benchCore, afterPaint } from './bench-hooks';

const t0 = performance.now();
const PEOPLE = 300, DAYS = 365, ROWH = 64, NAMEW = 160, HEADH = 40, TODAY = 290, TW = 512;
const ZOOMS = { day: 44, week: 14, month: 4.5 } as const; type Zoom = keyof typeof ZOOMS;
let zoom: Zoom = 'day'; let px: number = ZOOMS[zoom];
const qs = new URLSearchParams(location.search);
const A11Y = qs.has('a11y'), BLIT = qs.get('blit') !== '0';
const data = generate(PEOPLE, DAYS); const tGen = performance.now() - t0;
const layouts: RowLayout[] = data.map((r) => layoutRow(r, ROWH));
const allocById = new Map<number, Alloc>(); for (const r of data) for (const a of r) allocById.set(a.id, a);
const HUES = Array.from({ length: 360 }, (_, h) => `hsl(${h} 55% 45%)`);

const scrollEl = document.getElementById('scroll')!, sizer = document.getElementById('sizer')!, cv = document.getElementById('cv') as HTMLCanvasElement;
const ctx = cv.getContext('2d', { alpha: false })!;
let DPR = 1, W = 0, H = 0, full = true;
function setSize() {
  sizer.style.width = NAMEW + DAYS * px + 'px'; sizer.style.height = HEADH + PEOPLE * ROWH + 'px';
  if (A11Y) { ov.style.width = NAMEW + DAYS * px + 'px'; ov.style.height = HEADH + PEOPLE * ROWH + 'px'; }
}
function fit() {
  W = scrollEl.clientWidth; H = scrollEl.clientHeight; DPR = devicePixelRatio || 1;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); cv.style.width = W + 'px'; cv.style.height = H + 'px';
  full = true; buildBg(); tiles.clear();
}

// --- Fond en cache : motif d'une période entière (k semaines pour tomber sur des pixels entiers) ---
let bgPat: CanvasPattern | null = null;
function buildBg() {
  let k = 1; while (k < 8 && Math.abs(7 * px * k * DPR - Math.round(7 * px * k * DPR)) > 1e-6) k++;
  const P = 7 * px * k; const t = document.createElement('canvas'); t.width = Math.round(P * DPR); t.height = ROWH * DPR;
  const c = t.getContext('2d', { alpha: false })!; c.scale(DPR, DPR);
  c.fillStyle = '#fff'; c.fillRect(0, 0, P, ROWH);
  c.fillStyle = '#f1f1f4'; for (let w = 0; w < k; w++) c.fillRect(w * 7 * px + 2 * px, 0, 2 * px, ROWH);
  if (zoom === 'day') { c.fillStyle = '#ececec'; for (let d = 0; d < 7 * k; d++) c.fillRect(d * px, 0, 1, ROWH); }
  c.fillStyle = '#e3e3e3'; c.fillRect(0, ROWH - 1, P, 1);
  bgPat = ctx.createPattern(t, 'repeat');
}
// --- Tuiles d'en-tête en cache (LRU simple) ---
const tiles = new Map<string, HTMLCanvasElement>();
function tile(t: number) {
  const key = zoom + ':' + t; let c = tiles.get(key); if (c) return c;
  c = document.createElement('canvas'); c.width = TW * DPR; c.height = HEADH * DPR; const g = c.getContext('2d', { alpha: false })!; g.scale(DPR, DPR);
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, TW, HEADH); g.fillStyle = '#bbb'; g.fillRect(0, HEADH - 1, TW, 1);
  g.font = '12px sans-serif'; g.textBaseline = 'middle';
  const step = zoom === 'day' ? 1 : zoom === 'week' ? 7 : 30;
  for (let d = Math.max(0, Math.floor((t * TW - 60) / px / step) * step); d < DAYS; d += step) {
    const x = d * px - t * TW; if (x > TW) break;
    g.fillStyle = '#ddd'; g.fillRect(x, 0, 1, HEADH); g.fillStyle = '#000';
    g.fillText(zoom === 'day' ? String(new Date(Date.UTC(2026, 0, 1 + d)).getUTCDate()) : zoom === 'week' ? 'S' + (d / 7 + 1) : 'M' + (d / 30 + 1), x + 3, 12);
  }
  tiles.set(key, c); if (tiles.size > 48) tiles.delete(tiles.keys().next().value!);
  return c;
}

let focusId = -1;
function drawBody(x: number, y: number, w: number, h: number, sl: number, st: number) {
  if (w <= 0 || h <= 0) return;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  bgPat!.setTransform(new DOMMatrix([1 / DPR, 0, 0, 1 / DPR, NAMEW - sl, HEADH - st])); ctx.fillStyle = bgPat!; ctx.fillRect(x, y, w, h);
  const r0 = Math.max(0, Math.floor((y + st - HEADH) / ROWH)), r1 = Math.min(PEOPLE - 1, Math.floor((y + h - 1 + st - HEADH) / ROWH));
  const d0 = (x + sl - NAMEW) / px, d1 = (x + w + sl - NAMEW) / px;
  ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
  for (let i = r0; i <= r1; i++) {
    const y0 = HEADH + i * ROWH - st;
    for (const p of layouts[i].placed) {
      if (p.a.start + p.a.len < d0 || p.a.start > d1 || p.y >= ROWH - 1) continue;
      const bx = NAMEW + p.a.start * px - sl, bw = Math.max(2, p.a.len * px - 1), bh = Math.min(p.h, ROWH - 1 - p.y);
      ctx.fillStyle = HUES[p.a.hue]; ctx.fillRect(bx, y0 + p.y, bw, bh);
      if (px >= 14 && bw > 28 && bh >= 12) { ctx.fillStyle = '#fff'; ctx.fillText(`${Math.round(p.a.pct * 100)}%`, bx + 4, y0 + p.y + 8); }
      if (p.a.id === focusId) { ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(bx + 1, y0 + p.y + 1, bw - 2, bh - 2); }
    }
  }
  const tx = NAMEW + TODAY * px - sl; if (tx + 2 >= x && tx <= x + w) { ctx.fillStyle = '#e33'; ctx.fillRect(tx, y, 2, h); }
  ctx.restore();
}
function drawHeader(sl: number) {
  ctx.save(); ctx.beginPath(); ctx.rect(NAMEW, 0, W - NAMEW, HEADH); ctx.clip();
  for (let t = Math.floor(sl / TW); t <= Math.floor((sl + W - NAMEW) / TW); t++) ctx.drawImage(tile(t), NAMEW + t * TW - sl, 0, TW, HEADH);
  ctx.restore(); ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, NAMEW, HEADH); ctx.fillStyle = '#bbb'; ctx.fillRect(0, HEADH - 1, NAMEW, 1); ctx.fillRect(NAMEW - 1, 0, 1, HEADH);
}
function drawNames(st: number) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, HEADH, NAMEW, H - HEADH); ctx.clip();
  ctx.fillStyle = '#fff'; ctx.fillRect(0, HEADH, NAMEW, H - HEADH); ctx.font = '12px sans-serif'; ctx.textBaseline = 'middle';
  const r0 = Math.max(0, Math.floor(st / ROWH)), r1 = Math.min(PEOPLE - 1, Math.floor((st + H - HEADH) / ROWH));
  for (let i = r0; i <= r1; i++) {
    const y0 = HEADH + i * ROWH - st; ctx.fillStyle = '#e3e3e3'; ctx.fillRect(0, y0 + ROWH - 1, NAMEW, 1);
    ctx.fillStyle = layouts[i].over ? '#c00' : '#000'; ctx.fillText(`P${i}${layouts[i].over ? ' ▲' : ''}`, 6, y0 + 12);
  }
  ctx.fillStyle = '#bbb'; ctx.fillRect(NAMEW - 1, HEADH, 1, H - HEADH); ctx.restore();
}

let lastSl = NaN, lastSt = NaN; const dirtyRows = new Set<number>();
const renderCost: number[] = [], ovCost: number[] = []; const modes = { full: 0, blit: 0, rows: 0 };
function render() {
  const c0 = performance.now(); const sl = scrollEl.scrollLeft, st = scrollEl.scrollTop;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const BW = W - NAMEW, BH = H - HEADH, dx = sl - lastSl, dy = st - lastSt;
  if (full || !BLIT || !(Math.abs(dx) < BW && Math.abs(dy) < BH) || !Number.isInteger(dx * DPR) || !Number.isInteger(dy * DPR)) {
    if (full || dx || dy || dirtyRows.size) { drawBody(NAMEW, HEADH, BW, BH, sl, st); drawHeader(sl); drawNames(st); modes.full++; }
    full = false; dirtyRows.clear();
  } else {
    if (dx || dy) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(NAMEW * DPR, HEADH * DPR, BW * DPR, BH * DPR); ctx.clip();
      ctx.drawImage(cv, -dx * DPR, -dy * DPR); ctx.restore(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (dx > 0) drawBody(W - dx, HEADH, dx, BH, sl, st); else if (dx < 0) drawBody(NAMEW, HEADH, -dx, BH, sl, st);
      if (dy > 0) drawBody(NAMEW, H - dy, BW, dy, sl, st); else if (dy < 0) drawBody(NAMEW, HEADH, BW, -dy, sl, st);
      if (dx) drawHeader(sl); if (dy) drawNames(st); modes.blit++;
    }
    if (dirtyRows.size) {
      for (const i of dirtyRows) { const y0 = HEADH + i * ROWH - st, yy = Math.max(HEADH, y0), y1 = Math.min(H, y0 + ROWH); if (y1 > yy) drawBody(NAMEW, yy, BW, y1 - yy, sl, st); }
      drawNames(st); dirtyRows.clear(); modes.rows++;
    }
  }
  lastSl = sl; lastSt = st;
  if (A11Y) { const o0 = performance.now(); syncOverlay(sl, st); ovCost.push(performance.now() - o0); }
  renderCost.push(performance.now() - c0);
}
let pending = false; const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); };
scrollEl.addEventListener('scroll', schedule, { passive: true });

const metrics: Record<string, any> = { dataGenMs: tGen, zoomMs: [], todayMs: [], moveLatency: [], kbMs: [] };
function setZoom(z: Zoom) {
  const s = performance.now(); const center = (scrollEl.scrollLeft + W / 2 - NAMEW) / px; zoom = z; px = ZOOMS[z]; setSize(); buildBg();
  scrollEl.scrollLeft = Math.max(0, center * px + NAMEW - W / 2); full = true; if (A11Y) ovForce = true; render(); afterPaint(() => metrics.zoomMs.push(performance.now() - s));
}
function goToday() { const s = performance.now(); scrollEl.scrollLeft = Math.max(0, TODAY * px - W / 2 + NAMEW); render(); afterPaint(() => metrics.todayMs.push(performance.now() - s)); }
document.getElementById('zd')!.onclick = () => setZoom('day'); document.getElementById('zw')!.onclick = () => setZoom('week');
document.getElementById('zm')!.onclick = () => setZoom('month'); document.getElementById('today-btn')!.onclick = goToday;

// --- Hit test + drag (déplacer / étirer gauche et droite / hauteur) ---
type Mode = 'move' | 'l' | 'r' | 'h';
function hit(cx: number, cy: number) {
  const r = scrollEl.getBoundingClientRect(); const x = cx - r.left + scrollEl.scrollLeft, y = cy - r.top + scrollEl.scrollTop;
  const i = Math.floor((y - HEADH) / ROWH); if (i < 0 || i >= PEOPLE || x < NAMEW) return null;
  const ly = y - HEADH - i * ROWH;
  for (const p of layouts[i].placed) {
    const bx = NAMEW + p.a.start * px, bw = p.a.len * px;
    if (x >= bx && x <= bx + bw && ly >= p.y && ly <= p.y + p.h) { const mode: Mode = x < bx + 6 ? 'l' : x > bx + bw - 6 ? 'r' : ly > p.y + p.h - 4 ? 'h' : 'move'; return { a: p.a, mode }; }
  }
  return null;
}
let drag: null | { a: Alloc; mode: Mode; x0: number; y0: number; orig: Alloc } = null; let pend: PointerEvent | null = null;
scrollEl.addEventListener('pointerdown', (e) => { const h = hit(e.clientX, e.clientY); if (!h) return; scrollEl.setPointerCapture(e.pointerId); drag = { ...h, x0: e.clientX, y0: e.clientY, orig: { ...h.a } }; });
scrollEl.addEventListener('pointermove', (e) => { if (!drag) return; pend = e; requestAnimationFrame(apply); });
function apply() {
  const e = pend; if (!e || !drag) return; pend = null; const { a, orig, mode } = drag; const dd = snap(e.clientX - drag.x0, px); const oldP = a.person;
  if (mode === 'move') { a.start = Math.max(0, Math.min(DAYS - a.len, orig.start + dd)); a.person = Math.max(0, Math.min(PEOPLE - 1, orig.person + snap(e.clientY - drag.y0, ROWH))); }
  else if (mode === 'r') a.len = Math.max(1, Math.min(DAYS - a.start, orig.len + dd));
  else if (mode === 'l') { const ns = Math.max(0, Math.min(orig.start + orig.len - 1, orig.start + dd)); a.start = ns; a.len = orig.start + orig.len - ns; }
  else a.pct = Math.max(0.1, Math.min(1.5, orig.pct - (e.clientY - drag.y0) / (ROWH - 4)));
  if (a.person !== oldP) { data[oldP] = data[oldP].filter((x) => x !== a); data[a.person].push(a); data[a.person].sort((x, y) => x.start - y.start || x.id - y.id); }
  for (const p of new Set([oldP, a.person])) { layouts[p] = layoutRow(data[p], ROWH); dirtyRows.add(p); if (A11Y) markOvDirty(p); }
  render(); metrics.moveLatency.push(performance.now() - e.timeStamp);
}
const end = () => { drag = null; }; scrollEl.addEventListener('pointerup', end); scrollEl.addEventListener('pointercancel', end);

// --- Overlay d'accessibilité (B3) : fenêtre visible seulement, pas d'overscan vertical ---
const ov = document.createElement('div'); let ovForce = true;
interface OCell { el: HTMLDivElement; id: number; x: number; y: number; w: number; h: number; lbl: string; shown: boolean; gen: number }
interface ORow { el: HTMLDivElement; hd: HTMLDivElement; idx: number; chunk: number; dirty: boolean; shown: boolean; hdLbl: string; cells: Map<number, OCell>; free: OCell[] }
const orows = new Map<number, ORow>(); const ofree: ORow[] = []; let ocur = { r0: -1, r1: -1, chunk: NaN }; let ogen = 0;
const live = document.createElement('div');
const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const dstr = (d: number) => fmt.format(Date.UTC(2026, 0, 1 + d));
const label = (a: Alloc) => `Allocation ${a.id}, P${a.person}, du ${dstr(a.start)} au ${dstr(a.start + a.len - 1)}, ${Math.round(a.pct * 100)} % de capacité`;
let tabCell: OCell | null = null;
if (A11Y) {
  ov.id = 'ov'; ov.setAttribute('role', 'grid'); ov.setAttribute('aria-label', 'Planning : personnes et allocations'); ov.setAttribute('aria-rowcount', String(PEOPLE)); ov.tabIndex = -1; sizer.appendChild(ov);
  live.id = 'announce'; live.className = 'sr'; live.setAttribute('aria-live', 'polite'); document.body.appendChild(live);
  ov.addEventListener('keydown', onKey);
}
function markOvDirty(p: number) { const r = orows.get(p); if (r) r.dirty = true; }
function newORow(): ORow {
  const el = document.createElement('div'); el.className = 'orow'; el.setAttribute('role', 'row'); el.style.width = NAMEW + DAYS * px + 'px';
  const hd = document.createElement('div'); hd.className = 'ohd'; hd.setAttribute('role', 'rowheader'); el.appendChild(hd); ov.appendChild(el);
  return { el, hd, idx: -1, chunk: NaN, dirty: true, shown: true, hdLbl: '', cells: new Map(), free: [] };
}
function releaseCell(c: OCell) {
  if (c === tabCell) { c.el.tabIndex = -1; tabCell = null; }
  if (document.activeElement === c.el) ov.focus({ preventScroll: true }); // la focalisation reste dans la grille
}
function bindORow(r: ORow, i: number, chunk: number, CH: number) {
  if (!r.shown) { r.el.style.display = ''; r.shown = true; }
  if (r.idx !== i) { r.idx = i; r.el.style.transform = `translateY(${HEADH + i * ROWH}px)`; r.el.setAttribute('aria-rowindex', String(i + 1)); r.dirty = true;
    for (const c of r.cells.values()) { releaseCell(c); r.free.push(c); } r.cells.clear(); }
  if (!r.dirty && r.chunk === chunk) return;
  r.chunk = chunk; r.dirty = false;
  const hl = `P${i}${layouts[i].over ? ', sur-allocation' : ''}`; if (hl !== r.hdLbl) { r.hd.setAttribute('aria-label', hl); r.hdLbl = hl; }
  const wl = chunk * CH - NAMEW, wr = (chunk + 2) * CH; const g = ++ogen;
  const vis = layouts[i].placed.filter((p) => { const x = p.a.start * px; return !(x + p.a.len * px < wl || x > wr); });
  for (const p of vis) { const c = r.cells.get(p.a.id); if (c) c.gen = g; }
  for (const [id, c] of r.cells) if (c.gen !== g) { releaseCell(c); r.cells.delete(id); r.free.push(c); }
  for (const p of vis) {
    let c = r.cells.get(p.a.id);
    if (!c) {
      c = r.free.pop(); if (!c) { const el = document.createElement('div'); el.className = 'ocell'; el.setAttribute('role', 'gridcell'); el.tabIndex = -1; r.el.appendChild(el); c = { el, id: -1, x: NaN, y: NaN, w: NaN, h: NaN, lbl: '', shown: true, gen: 0 }; }
      c.gen = g; r.cells.set(p.a.id, c);
    }
    const s = c.el.style; if (!c.shown) { s.display = ''; c.shown = true; }
    if (c.id !== p.a.id) { c.id = p.a.id; c.el.id = 'c' + p.a.id; }
    const x = NAMEW + p.a.start * px, w = Math.max(2, p.a.len * px - 1), h = Math.min(p.h, ROWH - 1 - p.y);
    if (x !== c.x || p.y !== c.y) { s.transform = `translate(${x}px,${p.y}px)`; c.x = x; c.y = p.y; }
    if (w !== c.w) { s.width = w + 'px'; c.w = w; } if (h !== c.h) { s.height = Math.max(0, h) + 'px'; c.h = h; }
    const l = label(p.a); if (l !== c.lbl) { c.el.setAttribute('aria-label', l); c.lbl = l; }
  }
  for (const c of r.free) if (c.shown) { c.el.style.display = 'none'; c.shown = false; c.id = -1; c.el.removeAttribute('id'); }
}
function syncOverlay(sl: number, st: number) {
  const r0 = Math.max(0, Math.floor(st / ROWH)), r1 = Math.min(PEOPLE - 1, Math.floor((st + H - HEADH - 1) / ROWH));
  const CH = W, chunk = Math.floor(sl / CH); let dirty = false; for (const r of orows.values()) if (r.dirty) dirty = true;
  if (!ovForce && !dirty && r0 === ocur.r0 && r1 === ocur.r1 && chunk === ocur.chunk) return;
  for (const [i, r] of orows) if (i < r0 || i > r1) { orows.delete(i); ofree.push(r); for (const c of r.cells.values()) releaseCell(c); }
  for (let i = r0; i <= r1; i++) {
    let r = orows.get(i); if (!r) { r = ofree.pop() ?? newORow(); orows.set(i, r); }
    if (ovForce) { r.dirty = true; r.el.style.width = NAMEW + DAYS * px + 'px'; } bindORow(r, i, chunk, CH);
  }
  for (const r of ofree) if (r.shown) { r.el.style.display = 'none'; r.shown = false; r.idx = -1; for (const c of r.cells.values()) r.free.push(c); r.cells.clear(); }
  ocur = { r0, r1, chunk }; ovForce = false;
  // tabindex itinérant : la cellule focalisée si elle est rendue, sinon la première cellule visible
  const fa = allocById.get(focusId); let want = fa ? orows.get(fa.person)?.cells.get(fa.id) ?? null : null;
  if (!want) { const fr = orows.get(r0); want = fr ? fr.cells.values().next().value ?? null : null; }
  if (want && want !== tabCell) { if (tabCell) tabCell.el.tabIndex = -1; want.el.tabIndex = 0; tabCell = want; }
}
function firstVisible(): Alloc | undefined { const r = orows.get(ocur.r0); const c = r?.cells.values().next().value; return c ? allocById.get(c.id) : undefined; }
function onKey(e: KeyboardEvent) {
  const s = performance.now(); const cur = allocById.get(focusId) ?? firstVisible(); if (!cur) return;
  const row = data[cur.person]; const k = row.indexOf(cur); let next: Alloc | undefined;
  if (e.key === 'ArrowRight') next = row[k + 1]; else if (e.key === 'ArrowLeft') next = row[k - 1];
  else if (e.key === 'Home') next = row[0]; else if (e.key === 'End') next = row[row.length - 1];
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const step = e.key === 'ArrowDown' ? 1 : -1;
    for (let j = cur.person + step; j >= 0 && j < PEOPLE && !next; j += step) {
      let best: Alloc | undefined; for (const a of data[j]) if (!best || Math.abs(a.start - cur.start) < Math.abs(best.start - cur.start)) best = a; next = best;
    }
  } else return;
  e.preventDefault(); if (!next) return;
  focusAlloc(next); metrics.kbMs.push(performance.now() - s);
}
function focusAlloc(a: Alloc) {
  const prev = allocById.get(focusId); focusId = a.id; if (prev) dirtyRows.add(prev.person); dirtyRows.add(a.person);
  const sl = scrollEl.scrollLeft, st = scrollEl.scrollTop; const x0 = NAMEW + a.start * px, x1 = x0 + a.len * px, y0 = HEADH + a.person * ROWH;
  let nl = sl, nt = st;
  if (x0 < sl + NAMEW || x1 > sl + W) nl = Math.max(0, x0 - NAMEW - 40);
  if (y0 < st + HEADH) nt = y0 - HEADH; else if (y0 + ROWH > st + H) nt = y0 + ROWH - H;
  if (nl !== sl) scrollEl.scrollLeft = nl; if (nt !== st) scrollEl.scrollTop = nt;
  render();
  const c = orows.get(a.person)?.cells.get(a.id);
  if (c) { if (tabCell && tabCell !== c) tabCell.el.tabIndex = -1; c.el.tabIndex = 0; tabCell = c; c.el.focus({ preventScroll: true }); }
  live.textContent = label(a);
}

const core = benchCore(scrollEl, PEOPLE * ROWH - 400);
(window as any).__bench = {
  ...core, renderCost, ovCost, modes, ROWH, NAMEW, HEADH, metrics, setZoom, goToday, scrollEl, DPR: () => DPR,
  domNodes: () => document.getElementsByTagName('*').length, blocks: () => 0, totalAllocs: () => data.reduce((n, r) => n + r.length, 0),
  ovNodes: () => ov.getElementsByTagName('*').length + (A11Y ? 1 : 0),
  ovCells: () => { let n = 0; for (const r of orows.values()) n += r.cells.size; return n; },
  locate(sel: string) {
    const r = scrollEl.getBoundingClientRect(); const st = scrollEl.scrollTop, sl = scrollEl.scrollLeft;
    for (let i = Math.floor(st / ROWH) + 1; i < PEOPLE; i++) for (const p of layouts[i].placed) {
      const x = r.left + NAMEW + p.a.start * px - sl, y = r.top + HEADH + i * ROWH - st + p.y; const w = p.a.len * px;
      if (x > r.left + NAMEW + 120 && x + w < r.right - 200 && w > 60 && p.h > 24 && y > r.top + HEADH + 20 && y + p.h < r.bottom - 200)
        return sel === 'move' ? [x + w / 2, y + p.h / 2] : sel === 'r' ? [x + w - 2, y + p.h / 2] : sel === 'l' ? [x + 2, y + p.h / 2] : [x + w / 2, y + p.h - 2];
    }
    return null;
  },
};
setSize(); fit(); new ResizeObserver(() => { fit(); if (A11Y) ovForce = true; schedule(); }).observe(scrollEl);
goToday(); afterPaint(() => { metrics.firstRenderMs = performance.now() - t0; (window as any).__ready = true; });
