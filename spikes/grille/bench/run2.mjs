// Banc du second tour. VARIANT=A2|B2|B3 (ou B2NB = B2 sans blit) THROTTLE=n RUNS=5 DPR=2
// Ajouts par rapport à run.mjs : DPR configurable, frameWork (rAF -> tâche suivante), métriques CDP
// (TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration) par frame, coût de rendu pendant le drag
// pour toutes les variantes, étirement à gauche, coût de l'overlay a11y.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const VARIANT = process.env.VARIANT ?? 'A2';
const PAGES = { A2: 'dom-opt.html', A2CV: 'dom-opt.html?cv=1', B2: 'canvas2.html', B2NB: 'canvas2.html?blit=0', B3: 'canvas2.html?a11y=1', A: '', B: 'canvas.html' };
const PAGE = PAGES[VARIANT];
const RUNS = +(process.env.RUNS ?? 5), THROTTLE = +(process.env.THROTTLE ?? 1), DPR = +(process.env.DPR ?? 2);
const PORT = 5197;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const stats = (f) => ({ n: f.length, p50: pct(f, .5), p95: pct(f, .95), max: Math.max(...f), over20: f.filter((x) => x > 20).length / f.length, fpsP95: 1000 / pct(f, .95) });
const dist = (a) => ({ n: a.length, p50: pct(a, .5), p95: pct(a, .95), max: a.length ? Math.max(...a) : NaN });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fileURLToPath(new URL('..', import.meta.url));
const srv = spawn(process.execPath, [root + 'node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
await wait(2500);
const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const runs = [];
try {
  for (let r = 0; r < RUNS; r++) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: DPR });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.goto(`http://127.0.0.1:${PORT}/` + PAGE); await page.waitForFunction(() => window.__ready);
    await cdp.send('Performance.enable');
    const cdpm = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdpm()).JSHeapUsedSize / 1048576; };
    const out = {};
    out.env = r === 0 ? await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl'); const e = c?.getExtension('WEBGL_debug_renderer_info'); return { ua: navigator.userAgent, gl: e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : null, dpr: devicePixelRatio }; }) : undefined;
    out.firstRenderMs = await page.evaluate(() => window.__bench.metrics.firstRenderMs);
    out.allocs = await page.evaluate(() => window.__bench.totalAllocs());
    out.heapMB_initial = await heap();
    out.dom_initial = await page.evaluate(() => window.__bench.domNodes());
    out.ov_initial = await page.evaluate(() => window.__bench.ovNodes?.());

    const cdpDelta = (a, b, frames) => { const d = (k) => (b[k] - a[k]) * 1000; return { taskMsPerFrame: d('TaskDuration') / frames, scriptMsPerFrame: d('ScriptDuration') / frames, layoutMsPerFrame: d('LayoutDuration') / frames, styleMsPerFrame: d('RecalcStyleDuration') / frames, layoutCount: b.LayoutCount - a.LayoutCount }; };
    const clear = () => page.evaluate(() => { const B = window.__bench; B.renderCost.length = 0; B.ovCost && (B.ovCost.length = 0); B.metrics.moveLatency.length = 0; for (const k in B.eventDur) delete B.eventDur[k]; B.startRec(); });
    const collect = () => page.evaluate(() => { const B = window.__bench; const s = B.stopRec(); return { ...s, rc: [...B.renderCost], oc: B.ovCost ? [...B.ovCost] : [], lat: [...B.metrics.moveLatency], ev: JSON.parse(JSON.stringify(B.eventDur)) }; });
    const summarize = (res, m0, m1) => ({
      ...stats(res.frames), frameWork: dist(res.frameWork), renderCost: dist(res.rc), ovCost: res.oc.length ? dist(res.oc) : undefined,
      longtasks: res.longtasks.length, longtaskTotal: sum(res.longtasks), longtaskMax: Math.max(0, ...res.longtasks),
      cdp: cdpDelta(m0, m1, Math.max(1, res.frames.length)),
    });

    const scroll = async (label, ms, dx, dy) => {
      await clear(); const m0 = await cdpm();
      await page.evaluate(([m, x, y]) => window.__bench.scrollRun(m, x, y), [ms, dx, dy]);
      const m1 = await cdpm(); const res = await collect();
      out[label] = summarize(res, m0, m1);
    };
    await scroll('scrollH_day', 4000, 24, 0);
    await scroll('scrollV_day', 4000, 0, 18);
    await scroll('scrollDiag_day', 4000, 20, 14);
    out.domAfterScroll = await page.evaluate(() => window.__bench.domNodes());
    out.ovAfterScroll = await page.evaluate(() => window.__bench.ovNodes?.());

    const dragTest = async (label, handleSel, dxs, dys) => {
      await page.evaluate(() => window.__bench.goToday()); await wait(300);
      const box = await page.evaluate((sel) => {
        const B = window.__bench; if (B.locate) return B.locate(sel); const sc = B.scrollEl.getBoundingClientRect();
        for (const b of document.querySelectorAll('.blk')) { const q = b.getBoundingClientRect();
          if (q.left > sc.left + B.NAMEW + 120 && q.right < sc.right - 200 && q.width > 60 && q.height > 24 && q.top > sc.top + B.HEADH + 20 && q.bottom < sc.bottom - 200)
            return sel === 'move' ? [q.left + q.width / 2, q.top + q.height / 2] : sel === 'r' ? [q.right - 2, q.top + q.height / 2] : sel === 'l' ? [q.left + 2, q.top + q.height / 2] : [q.left + q.width / 2, q.bottom - 2]; }
        return null; }, handleSel);
      if (!box) { out[label] = { error: 'no block' }; return; }
      await clear(); const m0 = await cdpm();
      await page.mouse.move(box[0], box[1]); await page.mouse.down();
      for (let i = 1; i <= 120; i++) { await page.mouse.move(box[0] + dxs(i), box[1] + dys(i)); await wait(16); }
      await page.mouse.up(); await wait(200);
      const m1 = await cdpm(); const res = await collect(); const evAll = Object.values(res.ev).flat();
      out[label] = { ...summarize(res, m0, m1), moveToHandler: dist(res.lat), eventTiming: { n: evAll.length, max: Math.max(0, ...evAll), p95: pct(evAll, .95) } };
    };
    await dragTest('drag_move', 'move', (i) => i * 5, (i) => (i % 40) * 1.2);
    await dragTest('drag_resizeR', 'r', (i) => i * 3, () => 0);
    await dragTest('drag_resizeL', 'l', (i) => -i * 3, () => 0);
    await dragTest('drag_height', 'h', () => 0, (i) => -i * 0.3);

    await page.evaluate(() => { const B = window.__bench; B.metrics.zoomMs.length = 0; B.metrics.todayMs.length = 0; for (const k in B.eventDur) delete B.eventDur[k]; });
    for (let c = 0; c < 6; c++) { for (const id of ['#zw', '#zm', '#zd', '#today-btn']) { await page.click(id); await wait(250); } }
    const z = await page.evaluate(() => { const B = window.__bench; return { zoom: [...B.metrics.zoomMs], today: [...B.metrics.todayMs], ev: JSON.parse(JSON.stringify(B.eventDur)) }; });
    out.zoom = dist(z.zoom); out.today = dist(z.today); out.clickEventTimingMax = Math.max(0, ...Object.values(z.ev).flat());
    out.heapMB_final = await heap();
    out.dom_final = await page.evaluate(() => window.__bench.domNodes());
    out.modes = await page.evaluate(() => window.__bench.modes);
    runs.push(out);
    await ctx.close();
  }
} finally { await browser.close(); srv.kill(); }
const meta = { date: new Date().toISOString(), variant: VARIANT, page: PAGE, cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), kernel: os.release(), throttle: THROTTLE, dpr: DPR, runs: RUNS, chromium: browser.version() };
writeFileSync(`${root}results/r2-${VARIANT}-dpr${DPR}-throttle${THROTTLE}.json`, JSON.stringify({ meta, runs }, null, 1));
console.log('done', VARIANT, THROTTLE, DPR);
