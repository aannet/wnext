import { generate, layoutRow, snap, type Alloc, type RowLayout } from './engine';
const t0 = performance.now();
const PEOPLE = 300, DAYS = 365, ROWH = 64, NAMEW = 160, HEADH = 40, TODAY = 290;
const ZOOMS = { day: 44, week: 14, month: 4.5 } as const; type Zoom = keyof typeof ZOOMS;
let zoom: Zoom = 'day'; let px: number = ZOOMS[zoom];
const data = generate(PEOPLE, DAYS); const tGen = performance.now() - t0;
const layouts: RowLayout[] = data.map((r) => layoutRow(r, ROWH));
const scrollEl = document.getElementById('scroll')!, sizer = document.getElementById('sizer')!, cv = document.getElementById('cv') as HTMLCanvasElement;
const ctx = cv.getContext('2d', { alpha: false })!;
const setSize = () => { sizer.style.width = NAMEW + DAYS * px + 'px'; sizer.style.height = HEADH + PEOPLE * ROWH + 'px'; };
function fit() { cv.width = scrollEl.clientWidth; cv.height = scrollEl.clientHeight; }
setSize(); fit();
let pending = false; const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); };
const renderCost: number[] = [];
function render() {
  const c0 = performance.now(); const W = cv.width, H = cv.height; const sl = scrollEl.scrollLeft, st = scrollEl.scrollTop;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const r0 = Math.max(0, Math.floor((st - HEADH) / ROWH)), r1 = Math.min(PEOPLE - 1, Math.ceil((st + H - HEADH) / ROWH));
  ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
  for (let i = r0; i <= r1; i++) {
    const y0 = HEADH + i * ROWH - st; ctx.fillStyle = '#e3e3e3'; ctx.fillRect(0, y0 + ROWH - 1, W, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(0, y0, W, ROWH - 1); ctx.clip();
    for (const p of layouts[i].placed) {
      const x = NAMEW + p.a.start * px - sl, w = p.a.len * px; if (x + w < NAMEW || x > W) continue;
      ctx.fillStyle = `hsl(${p.a.hue} 55% 45%)`; ctx.fillRect(x, y0 + p.y, Math.max(2, w - 1), p.h);
      if (px >= 14 && w > 28) { ctx.fillStyle = '#fff'; ctx.fillText(`${Math.round(p.a.pct * 100)}%`, x + 4, y0 + p.y + 8); }
    }
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.fillRect(0, y0, NAMEW, ROWH - 1); ctx.fillStyle = '#000'; ctx.fillText(`P${i}${layouts[i].over ? ' ▲' : ''}`, 6, y0 + 12);
    ctx.fillStyle = '#bbb'; ctx.fillRect(NAMEW - 1, y0, 1, ROWH);
  }
  ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, W, HEADH); ctx.fillStyle = '#000';
  const step = zoom === 'day' ? 1 : zoom === 'week' ? 7 : 30;
  for (let d = Math.floor(Math.max(0, sl - 200) / px / step) * step; d < DAYS; d += step) { const x = NAMEW + d * px - sl; if (x > W) break; if (x + step * px < NAMEW) continue;
    ctx.fillStyle = '#ddd'; ctx.fillRect(x, 0, 1, HEADH); ctx.fillStyle = '#000'; ctx.fillText(zoom === 'day' ? String(new Date(Date.UTC(2026, 0, 1 + d)).getUTCDate()) : zoom === 'week' ? 'S' + (d / 7 + 1) : 'M' + (d / 30 + 1), x + 3, 12); }
  ctx.fillStyle = '#e33'; ctx.fillRect(NAMEW + TODAY * px - sl, HEADH, 2, H);
  ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, NAMEW, HEADH);
  renderCost.push(performance.now() - c0);
}
scrollEl.addEventListener('scroll', schedule, { passive: true });
new ResizeObserver(() => { fit(); schedule(); }).observe(scrollEl);
function afterPaint(cb: () => void) { requestAnimationFrame(() => requestAnimationFrame(cb)); }
const metrics: Record<string, any> = { dataGenMs: tGen, zoomMs: [], todayMs: [], moveLatency: [] };
function setZoom(z: Zoom) { const s = performance.now(); const center = (scrollEl.scrollLeft + scrollEl.clientWidth / 2 - NAMEW) / px; zoom = z; px = ZOOMS[z]; setSize();
  scrollEl.scrollLeft = Math.max(0, center * px + NAMEW - scrollEl.clientWidth / 2); render(); afterPaint(() => metrics.zoomMs.push(performance.now() - s)); }
function goToday() { const s = performance.now(); scrollEl.scrollLeft = Math.max(0, TODAY * px - scrollEl.clientWidth / 2 + NAMEW); render(); afterPaint(() => metrics.todayMs.push(performance.now() - s)); }
document.getElementById('zd')!.onclick = () => setZoom('day'); document.getElementById('zw')!.onclick = () => setZoom('week');
document.getElementById('zm')!.onclick = () => setZoom('month'); document.getElementById('today-btn')!.onclick = goToday;

// Hit test + drag (déplacer / étirer droite / hauteur)
type Mode = 'move' | 'r' | 'h';
function hit(cx: number, cy: number) {
  const r = scrollEl.getBoundingClientRect(); const x = cx - r.left + scrollEl.scrollLeft, y = cy - r.top + scrollEl.scrollTop;
  const i = Math.floor((y - HEADH) / ROWH); if (i < 0 || i >= PEOPLE || x < NAMEW) return null;
  const ly = y - HEADH - i * ROWH;
  for (const p of layouts[i].placed) { const bx = NAMEW + p.a.start * px, bw = p.a.len * px;
    if (x >= bx && x <= bx + bw && ly >= p.y && ly <= p.y + p.h) { const mode: Mode = x > bx + bw - 6 ? 'r' : ly > p.y + p.h - 4 ? 'h' : 'move'; return { a: p.a, mode }; } }
  return null;
}
let drag: null | { a: Alloc; mode: Mode; x0: number; y0: number; orig: Alloc } = null; let pend: PointerEvent | null = null;
scrollEl.addEventListener('pointerdown', (e) => { const h = hit(e.clientX, e.clientY); if (!h) return; scrollEl.setPointerCapture(e.pointerId); drag = { ...h, x0: e.clientX, y0: e.clientY, orig: { ...h.a } }; });
scrollEl.addEventListener('pointermove', (e) => { if (!drag) return; pend = e; requestAnimationFrame(apply); });
function apply() { const e = pend; if (!e || !drag) return; pend = null; const { a, orig, mode } = drag; const dd = snap(e.clientX - drag.x0, px); const oldP = a.person;
  if (mode === 'move') { a.start = Math.max(0, Math.min(DAYS - a.len, orig.start + dd)); a.person = Math.max(0, Math.min(PEOPLE - 1, orig.person + snap(e.clientY - drag.y0, ROWH))); }
  else if (mode === 'r') a.len = Math.max(1, Math.min(DAYS - a.start, orig.len + dd)); else a.pct = Math.max(0.1, Math.min(1.5, orig.pct - (e.clientY - drag.y0) / (ROWH - 4)));
  if (a.person !== oldP) { data[oldP] = data[oldP].filter((x) => x !== a); data[a.person].push(a); data[a.person].sort((x, y) => x.start - y.start || x.id - y.id); }
  for (const p of new Set([oldP, a.person])) layouts[p] = layoutRow(data[p], ROWH);
  render(); metrics.moveLatency.push(performance.now() - e.timeStamp); }
const end = () => { drag = null; }; scrollEl.addEventListener('pointerup', end); scrollEl.addEventListener('pointercancel', end);

const frames: number[] = []; let rec = false, last = 0; const longtasks: number[] = [];
(function loop(t: number) { if (rec && last) frames.push(t - last); last = t; requestAnimationFrame(loop); })(0);
try { new PerformanceObserver((l) => l.getEntries().forEach((e) => longtasks.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
const eventDur: Record<string, number[]> = {};
try { new PerformanceObserver((l) => l.getEntries().forEach((e: any) => (eventDur[e.name] ??= []).push(e.duration))).observe({ type: 'event', durationThreshold: 16, buffered: true } as any); } catch {}
(window as any).__bench = { renderCost, ROWH, NAMEW, HEADH, metrics, longtasks, eventDur, frames,
  startRec() { frames.length = 0; longtasks.length = 0; rec = true; last = 0; }, stopRec() { rec = false; return { frames: [...frames], longtasks: [...longtasks] }; },
  scrollRun(ms: number, dxs: number, dys: number) { return new Promise<void>((res) => { const s = performance.now(); const tick = (t: number) => { scrollEl.scrollLeft += dxs; scrollEl.scrollTop = (scrollEl.scrollTop + dys) % (PEOPLE * ROWH - 400);
    if (scrollEl.scrollLeft >= scrollEl.scrollWidth - scrollEl.clientWidth - 5) scrollEl.scrollLeft = 0; if (t - s < ms) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); }); },
  domNodes: () => document.getElementsByTagName('*').length, blocks: () => 0, totalAllocs: () => data.reduce((n, r) => n + r.length, 0), setZoom, goToday, scrollEl,
  locate(sel: string) { const r = scrollEl.getBoundingClientRect(); const st = scrollEl.scrollTop, sl = scrollEl.scrollLeft;
    for (let i = Math.floor((st) / ROWH) + 1; i < PEOPLE; i++) for (const p of layouts[i].placed) { const x = r.left + NAMEW + p.a.start * px - sl, y = r.top + HEADH + i * ROWH - st + p.y; const w = p.a.len * px;
      if (x > r.left + NAMEW + 120 && x + w < r.right - 200 && w > 60 && p.h > 24 && y > r.top + HEADH + 20 && y + p.h < r.bottom - 200) return sel === 'move' ? [x + w / 2, y + p.h / 2] : sel === 'r' ? [x + w - 2, y + p.h / 2] : [x + w / 2, y + p.h - 2]; } return null; } };
fit(); goToday(); afterPaint(() => { metrics.firstRenderMs = performance.now() - t0; (window as any).__ready = true; });
