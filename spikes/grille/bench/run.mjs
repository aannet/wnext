import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const VARIANT = process.env.VARIANT ?? 'A';
const PAGE = VARIANT === 'B' ? 'canvas.html' : '';
const RUNS = +(process.env.RUNS ?? 5);
const THROTTLE = +(process.env.THROTTLE ?? 1);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const stats = (f) => ({ n: f.length, p50: pct(f, .5), p95: pct(f, .95), p99: pct(f, .99), max: Math.max(...f), over20: f.filter((x) => x > 20).length / f.length, fpsP95: 1000 / pct(f, .95) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '5198', '--strictPort'], { stdio: 'ignore' });
await wait(2500);
const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const runs = [];
try {
  for (let r = 0; r < RUNS; r++) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.goto('http://127.0.0.1:5198/' + PAGE); await page.waitForFunction(() => window.__ready);
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = await cdp.send('Performance.getMetrics'); return m.metrics.find((x) => x.name === 'JSHeapUsedSize').value / 1048576; };
    await cdp.send('Performance.enable');
    const out = {};
    out.env = r === 0 ? await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl'); const e = c?.getExtension('WEBGL_debug_renderer_info'); return { ua: navigator.userAgent, gl: e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : null }; }) : undefined;
    out.firstRenderMs = await page.evaluate(() => window.__bench.metrics.firstRenderMs);
    out.dataGenMs = await page.evaluate(() => window.__bench.metrics.dataGenMs);
    out.allocs = await page.evaluate(() => window.__bench.totalAllocs());
    out.heapMB_initial = await heap();
    out.dom_initial = await page.evaluate(() => window.__bench.domNodes());
    out.blocks_initial = await page.evaluate(() => window.__bench.blocks());

    const scroll = async (label, ms, dx, dy) => {
      await page.evaluate(() => { window.__bench.startRec(); window.__bench.renderCost.length = 0; });
      await page.evaluate(([m, x, y]) => window.__bench.scrollRun(m, x, y), [ms, dx, dy]);
      const res = await page.evaluate(() => ({ ...window.__bench.stopRec(), rc: [...window.__bench.renderCost] }));
      out[label] = { renderCost: { n: res.rc.length, p50: pct(res.rc, .5), p95: pct(res.rc, .95), max: Math.max(...res.rc) }, ...stats(res.frames), longtasks: res.longtasks.length, longtaskMax: Math.max(0, ...res.longtasks) };
    };
    await scroll('scrollH_day', 4000, 24, 0);
    await scroll('scrollV_day', 4000, 0, 18);
    await scroll('scrollDiag_day', 4000, 20, 14);
    out.domAfterScroll = await page.evaluate(() => window.__bench.domNodes());

    const dragTest = async (label, handleSel, dxs, dys) => {
      await page.evaluate(() => window.__bench.goToday());
      await wait(300);
      const box = await page.evaluate((sel) => {
        const B = window.__bench; if (B.locate) return B.locate(sel); const sc = B.scrollEl.getBoundingClientRect();
        for (const b of document.querySelectorAll('.blk')) { const q = b.getBoundingClientRect();
          if (q.left > sc.left + B.NAMEW + 120 && q.right < sc.right - 200 && q.width > 60 && q.height > 24 && q.top > sc.top + B.HEADH + 20 && q.bottom < sc.bottom - 200) {
            const h = sel === 'move' ? [q.left + q.width / 2, q.top + q.height / 2] : sel === 'r' ? [q.right - 2, q.top + q.height / 2] : [q.left + q.width / 2, q.bottom - 2]; return h; } } return null; }, handleSel);
      if (!box) { out[label] = { error: 'no block' }; return; }
      await page.evaluate(() => { const B = window.__bench; B.metrics.moveLatency.length = 0; B.renderCost.length = 0; B.startRec(); for (const k in B.eventDur) delete B.eventDur[k]; });
      await page.mouse.move(box[0], box[1]); await page.mouse.down();
      for (let i = 1; i <= 120; i++) { await page.mouse.move(box[0] + dxs(i), box[1] + dys(i)); await wait(16); }
      await page.mouse.up(); await wait(200);
      const res = await page.evaluate(() => { const B = window.__bench; const s = B.stopRec(); return { ...s, rc: [...B.renderCost], lat: [...B.metrics.moveLatency], ev: JSON.parse(JSON.stringify(B.eventDur)) }; });
      const evAll = Object.values(res.ev).flat();
      out[label] = { ...stats(res.frames), longtasks: res.longtasks.length, renderCost: { p50: pct(res.rc, .5), p95: pct(res.rc, .95), max: Math.max(...res.rc) }, moveToRender: { n: res.lat.length, p50: pct(res.lat, .5), p95: pct(res.lat, .95), max: Math.max(...res.lat) }, eventTiming: { n: evAll.length, max: Math.max(0, ...evAll), p95: pct(evAll, .95) } };
    };
    await dragTest('drag_move', 'move', (i) => i * 5, (i) => (i % 40) * 1.2);
    await dragTest('drag_resizeR', 'r', (i) => i * 3, () => 0);
    await dragTest('drag_height', 'h', () => 0, (i) => -i * 0.3);

    // zoom + today : 6 cycles, mesures internes (clic -> 2 rAF) et INP approximé
    await page.evaluate(() => { const B = window.__bench; B.metrics.zoomMs.length = 0; B.metrics.todayMs.length = 0; for (const k in B.eventDur) delete B.eventDur[k]; });
    for (let c = 0; c < 6; c++) { for (const id of ['#zw', '#zm', '#zd', '#today-btn']) { await page.click(id); await wait(250); } }
    const z = await page.evaluate(() => { const B = window.__bench; return { zoom: [...B.metrics.zoomMs], today: [...B.metrics.todayMs], ev: JSON.parse(JSON.stringify(B.eventDur)) }; });
    const zEv = Object.values(z.ev).flat();
    out.zoom = { n: z.zoom.length, p50: pct(z.zoom, .5), p95: pct(z.zoom, .95), max: Math.max(...z.zoom) };
    out.today = { n: z.today.length, p50: pct(z.today, .5), p95: pct(z.today, .95), max: Math.max(...z.today) };
    out.clickEventTimingMax = Math.max(0, ...zEv);
    out.heapMB_final = await heap();
    out.dom_final = await page.evaluate(() => window.__bench.domNodes());
    runs.push(out);
    await ctx.close();
  }
} finally { await browser.close(); srv.kill(); }
const meta = { date: new Date().toISOString(), cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), kernel: os.release(), throttle: THROTTLE, runs: RUNS, chromium: browser.version?.() };
writeFileSync(`results/${VARIANT}-${VARIANT === 'B' ? 'canvas' : 'dom'}-throttle${THROTTLE}.json`, JSON.stringify({ meta, runs }, null, 1));
console.log('done', meta);
