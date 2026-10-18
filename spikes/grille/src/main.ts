import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { generate, layoutRow, snap, type Alloc, type RowLayout } from './engine';

const t0 = performance.now();
const PEOPLE = 300, DAYS = 365, ROWH = 64, NAMEW = 160, HEADH = 40, TODAY = 290, OVERSCAN_PX = 800;
const ZOOMS = { day: 44, week: 14, month: 4.5 } as const;
type Zoom = keyof typeof ZOOMS;
let zoom: Zoom = "day"; let px: number = ZOOMS[zoom];

const data = generate(PEOPLE, DAYS);
const tGen = performance.now() - t0;
const layouts: RowLayout[] = data.map((r) => layoutRow(r, ROWH));
const scrollEl = document.getElementById('scroll')!, sizer = document.getElementById('sizer')!, head = document.getElementById('head')!;
sizer.style.height = HEADH + PEOPLE * ROWH + 'px';
const setW = () => (sizer.style.width = NAMEW + DAYS * px + 'px');
setW();
const todayEl = document.createElement('div'); todayEl.id = 'today'; sizer.appendChild(todayEl);

const rowEls = new Map<number, HTMLElement>();
const rowWin = new Map<number, [number, number]>(); // fenêtre x rendue par ligne
const blkEls = new Map<number, Map<number, HTMLElement>>();

const virt = new Virtualizer<HTMLElement, HTMLElement>({
  count: PEOPLE, getScrollElement: () => scrollEl, estimateSize: () => ROWH, overscan: 4, paddingStart: HEADH,
  scrollToFn: elementScroll, observeElementRect, observeElementOffset, onChange: () => schedule(),
});
virt._willUpdate();

let pending = false;
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }

function xWindow(): [number, number] { const l = scrollEl.scrollLeft - NAMEW; return [l - OVERSCAN_PX, l + scrollEl.clientWidth + OVERSCAN_PX]; }

function drawRow(i: number, force = false) {
  let el = rowEls.get(i);
  const [wl, wr] = xWindow();
  if (!el) {
    el = document.createElement('div'); el.className = 'row'; el.style.top = HEADH + i * ROWH + 'px'; el.style.width = NAMEW + DAYS * px + 'px';
    el.innerHTML = `<div class="name"></div>`; sizer.appendChild(el); rowEls.set(i, el); blkEls.set(i, new Map());
  }
  const w = rowWin.get(i);
  const needs = force || !w || wl < w[0] + OVERSCAN_PX / 2 || wr > w[1] - OVERSCAN_PX / 2;
  if (!needs) return;
  rowWin.set(i, [wl, wr]);
  const lay = layouts[i]; const name = el.firstChild as HTMLElement;
  name.innerHTML = `P${i}${lay.over ? ' <span class="over">▲</span>' : ''}`;
  const map = blkEls.get(i)!; const keep = new Set<number>();
  for (const p of lay.placed) {
    const x = p.a.start * px, w2 = p.a.len * px;
    if (x + w2 < wl || x > wr) continue;
    keep.add(p.a.id);
    let b = map.get(p.a.id);
    if (!b) { b = document.createElement('div'); b.className = 'blk'; b.dataset.id = String(p.a.id); b.dataset.p = String(i);
      b.innerHTML = '<span class="hl"></span><span class="lbl"></span><span class="hr"></span><span class="hh"></span>'; el.appendChild(b); map.set(p.a.id, b); }
    b.style.cssText = `left:${NAMEW + x}px;top:${p.y}px;width:${Math.max(2, w2 - 1)}px;height:${p.h}px;background:hsl(${p.a.hue} 55% 45%)`;
    (b.children[1] as HTMLElement).textContent = px >= 14 ? `${Math.round(p.a.pct * 100)}%` : '';
  }
  for (const [id, b] of map) if (!keep.has(id)) { b.remove(); map.delete(id); }
}

function dropRow(i: number) { rowEls.get(i)?.remove(); rowEls.delete(i); rowWin.delete(i); blkEls.delete(i); }

function drawHead() {
  const [wl, wr] = [scrollEl.scrollLeft - NAMEW - 200, scrollEl.scrollLeft + scrollEl.clientWidth];
  head.style.width = NAMEW + DAYS * px + 'px'; let h = '';
  const step = zoom === 'day' ? 1 : zoom === 'week' ? 7 : 30;
  for (let d = 0; d < DAYS; d += step) { const x = d * px; if (x + step * px < wl || x > wr) continue;
    const dt = new Date(Date.UTC(2026, 0, 1 + d)); const lbl = zoom === 'day' ? dt.getUTCDate() : zoom === 'week' ? 'S' + Math.floor(d / 7 + 1) : 'M' + (Math.floor(d / 30) + 1);
    h += `<div class="hc" style="left:${NAMEW + x}px;width:${step * px}px">${lbl}</div>`; }
  head.innerHTML = h;
}

const renderCost: number[] = [];
function render() {
  const c0 = performance.now();
  const items = virt.getVirtualItems(); const live = new Set<number>();
  for (const it of items) { live.add(it.index); drawRow(it.index); }
  for (const i of [...rowEls.keys()]) if (!live.has(i)) dropRow(i);
  drawHead(); todayEl.style.left = NAMEW + TODAY * px + 'px';
  renderCost.push(performance.now() - c0);
}

scrollEl.addEventListener('scroll', schedule, { passive: true });
new ResizeObserver(() => schedule()).observe(scrollEl);

function afterPaint(cb: (ms: number) => void) { const s = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => cb(performance.now() - s))); }
const metrics: Record<string, number | number[]> = { dataGenMs: tGen, zoomMs: [], todayMs: [], moveLatency: [] };
function setZoom(z: Zoom) {
  const s = performance.now(); const center = (scrollEl.scrollLeft + scrollEl.clientWidth / 2 - NAMEW) / px;
  zoom = z; px = ZOOMS[z]; setW();
  for (const i of [...rowEls.keys()]) dropRow(i);
  scrollEl.scrollLeft = Math.max(0, center * px + NAMEW - scrollEl.clientWidth / 2);
  render(); afterPaint(() => (metrics.zoomMs as number[]).push(performance.now() - s));
}
function goToday() { const s = performance.now(); scrollEl.scrollLeft = Math.max(0, TODAY * px - scrollEl.clientWidth / 2 + NAMEW); render(); afterPaint(() => (metrics.todayMs as number[]).push(performance.now() - s)); }
document.getElementById('zd')!.onclick = () => setZoom('day');
document.getElementById('zw')!.onclick = () => setZoom('week');
document.getElementById('zm')!.onclick = () => setZoom('month');
document.getElementById('today-btn')!.onclick = goToday;

// --- Drag / resize ---
type Mode = 'move' | 'l' | 'r' | 'h';
let drag: null | { a: Alloc; mode: Mode; x0: number; y0: number; orig: Alloc; el: HTMLElement } = null;
let dragPending: PointerEvent | null = null;
sizer.addEventListener('pointerdown', (e) => {
  const t = (e.target as HTMLElement); const b = t.closest('.blk') as HTMLElement | null; if (!b) return;
  const p = +b.dataset.p!, id = +b.dataset.id!; const a = data[p].find((x) => x.id === id)!;
  const mode: Mode = t.classList.contains('hl') ? 'l' : t.classList.contains('hr') ? 'r' : t.classList.contains('hh') ? 'h' : 'move';
  b.setPointerCapture(e.pointerId); drag = { a, mode, x0: e.clientX, y0: e.clientY, orig: { ...a }, el: b }; b.classList.add('drag');
});
sizer.addEventListener('pointermove', (e) => { if (!drag) return; dragPending = e; requestAnimationFrame(applyDrag); });
function applyDrag() {
  const e = dragPending; if (!e || !drag) return; dragPending = null;
  const { a, orig, mode } = drag; const dd = snap(e.clientX - drag.x0, px); const oldP = a.person;
  if (mode === 'move') { a.start = Math.max(0, Math.min(DAYS - a.len, orig.start + dd)); a.person = Math.max(0, Math.min(PEOPLE - 1, orig.person + snap(e.clientY - drag.y0, ROWH))); }
  else if (mode === 'r') a.len = Math.max(1, Math.min(DAYS - a.start, orig.len + dd));
  else if (mode === 'l') { const ns = Math.max(0, Math.min(orig.start + orig.len - 1, orig.start + dd)); a.start = ns; a.len = orig.start + orig.len - ns; }
  else a.pct = Math.max(0.1, Math.min(1.5, orig.pct - (e.clientY - drag.y0) / (ROWH - 4)));
  if (a.person !== oldP) { data[oldP] = data[oldP].filter((x) => x !== a); data[a.person].push(a); data[a.person].sort((x, y) => x.start - y.start || x.id - y.id); }
  for (const p of new Set([oldP, a.person])) { layouts[p] = layoutRow(data[p], ROWH); if (rowEls.has(p)) { const m = blkEls.get(p)!; for (const [, b] of m) b.remove(); m.clear(); drawRow(p, true); } }
  const b = blkEls.get(a.person)?.get(a.id); if (b) { b.classList.add('drag'); drag.el = b; }
  (metrics.moveLatency as number[]).push(performance.now() - e.timeStamp);
}
const end = () => { if (drag) { drag.el.classList.remove('drag'); drag = null; } };
sizer.addEventListener('pointerup', end); sizer.addEventListener('pointercancel', end);

// --- Accès pour le banc de mesure ---
const frames: number[] = []; let rec = false, last = 0;
function loop(t: number) { if (rec && last) frames.push(t - last); last = t; requestAnimationFrame(loop); }
requestAnimationFrame(loop);
const longtasks: number[] = [];
try { new PerformanceObserver((l) => l.getEntries().forEach((e) => longtasks.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
const eventDur: Record<string, number[]> = {};
try { new PerformanceObserver((l) => l.getEntries().forEach((e: any) => (eventDur[e.name] ??= []).push(e.duration))).observe({ type: 'event', durationThreshold: 16, buffered: true } as any); } catch {}

(window as any).__bench = {
  renderCost, ROWH, NAMEW, HEADH, metrics, longtasks, eventDur, frames,
  startRec() { frames.length = 0; longtasks.length = 0; rec = true; last = 0; },
  stopRec() { rec = false; return { frames: [...frames], longtasks: [...longtasks] }; },
  scrollRun(ms: number, dxs: number, dys: number) { return new Promise<void>((res) => { const s = performance.now(); const tick = (t: number) => {
    scrollEl.scrollLeft += dxs; scrollEl.scrollTop = (scrollEl.scrollTop + dys) % (PEOPLE * ROWH - 400);
    if (scrollEl.scrollLeft >= scrollEl.scrollWidth - scrollEl.clientWidth - 5) scrollEl.scrollLeft = 0;
    if (t - s < ms) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); }); },
  domNodes: () => document.getElementsByTagName('*').length,
  blocks: () => document.querySelectorAll('.blk').length,
  totalAllocs: () => data.reduce((n, r) => n + r.length, 0),
  setZoom, goToday, scrollEl,
};
render(); goToday();
afterPaint(() => { metrics.firstRenderMs = performance.now() - t0; (window as any).__ready = true; });
