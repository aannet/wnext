import { readFileSync } from 'node:fs';
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (v) => (+v).toFixed(1);
const get = (r, p) => p.split('.').reduce((o, k) => o?.[k], r);
const rows = [['firstRenderMs','premier rendu (ms)'],['heapMB_initial','heap initial (Mo)'],['heapMB_final','heap final (Mo)'],['dom_initial','noeuds DOM initial'],['domAfterScroll','noeuds DOM apres scroll'],
 ['scrollH_day.p95','scroll H frame p95 (ms)'],['scrollH_day.over20','scroll H part >20ms'],['scrollH_day.renderCost.p95','scroll H cout render p95 (ms)'],['scrollH_day.renderCost.max','scroll H cout render max'],
 ['scrollV_day.p95','scroll V frame p95'],['scrollV_day.renderCost.p95','scroll V cout render p95'],['scrollV_day.renderCost.max','scroll V cout render max'],
 ['scrollDiag_day.p95','scroll diag frame p95'],['scrollDiag_day.over20','scroll diag part >20ms'],['scrollDiag_day.renderCost.p95','scroll diag cout render p95'],['scrollDiag_day.renderCost.max','scroll diag cout render max'],['scrollDiag_day.longtasks','scroll diag longtasks (n)'],
 ['drag_move.p95','drag move frame p95'],['drag_move.over20','drag move part >20ms'],['drag_move.moveToRender.p95','drag move event->rendu p95'],['drag_move.renderCost.p95','drag move cout render p95'],['drag_move.eventTiming.max','drag move Event Timing max'],
 ['drag_resizeR.p95','resize frame p95'],['drag_resizeR.moveToRender.p95','resize event->rendu p95'],['drag_resizeR.eventTiming.max','resize Event Timing max'],
 ['drag_height.p95','hauteur frame p95'],['drag_height.moveToRender.p95','hauteur event->rendu p95'],
 ['zoom.p50','zoom clic->2 rAF p50'],['zoom.max','zoom clic->2 rAF max'],['today.p50','Aujourd hui p50'],['today.max','Aujourd hui max'],['clickEventTimingMax','click Event Timing max (INP approx)']];
const data = {}; for (const t of [1,4,6]) data[t] = JSON.parse(readFileSync(`results/${process.env.V==='B'?'B-canvas':'A-dom'}-throttle${t}.json`)).runs;
console.log('| mesure | CPU x1 | CPU x4 | CPU x6 |\n|---|---|---|---|');
for (const [p, l] of rows) console.log(`| ${l} | ` + [1,4,6].map((t) => { const v = data[t].map((r) => get(r, p)).filter((x) => x !== undefined && isFinite(x)); return v.length ? `${f(med(v))} [${f(Math.min(...v))}-${f(Math.max(...v))}]` : 'n/a'; }).join(' | ') + ' |');
