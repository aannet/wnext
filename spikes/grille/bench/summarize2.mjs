// Résumé du second tour : médiane [min-max] sur les runs. Usage : node bench/summarize2.mjs A2 B2 B3 [DPR=2]
import { readFileSync, existsSync } from 'node:fs';
const DPR = process.env.DPR ?? 2; const vs = process.argv.slice(2).length ? process.argv.slice(2) : ['A2', 'B2', 'B3'];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (v) => (Math.abs(v) >= 100 ? Math.round(v) : (+v).toFixed(1));
const get = (r, p) => p.split('.').reduce((o, k) => o?.[k], r);
const rows = [
 ['firstRenderMs', 'premier rendu'], ['dom_initial', 'noeuds DOM initial'], ['domAfterScroll', 'noeuds DOM après scroll'], ['ovAfterScroll', 'noeuds overlay après scroll'], ['heapMB_final', 'heap final (Mo)'],
 ...['scrollH_day', 'scrollV_day', 'scrollDiag_day'].flatMap((s) => [[`${s}.p95`, `${s} frame p95`], [`${s}.fpsP95`, `${s} i/s p95`], [`${s}.frameWork.p95`, `${s} frameWork p95`], [`${s}.frameWork.max`, `${s} frameWork max`], [`${s}.renderCost.p95`, `${s} render JS p95`], [`${s}.renderCost.max`, `${s} render JS max`], [`${s}.ovCost.p95`, `${s} overlay JS p95`], [`${s}.cdp.taskMsPerFrame`, `${s} CDP tâche/frame`], [`${s}.cdp.layoutMsPerFrame`, `${s} CDP layout/frame`], [`${s}.longtasks`, `${s} longtasks n`], [`${s}.longtaskTotal`, `${s} longtasks total ms`]]),
 ...['drag_move', 'drag_resizeR', 'drag_resizeL', 'drag_height'].flatMap((s) => [[`${s}.p95`, `${s} frame p95`], [`${s}.frameWork.p95`, `${s} frameWork p95`], [`${s}.renderCost.p95`, `${s} render JS p95`], [`${s}.renderCost.max`, `${s} render JS max`], [`${s}.moveToHandler.p95`, `${s} evt->handler p95`], [`${s}.eventTiming.max`, `${s} Event Timing max`], [`${s}.cdp.taskMsPerFrame`, `${s} CDP tâche/frame`]]),
 ['zoom.p50', 'zoom p50'], ['zoom.max', 'zoom max'], ['today.p50', 'Aujourd hui p50'], ['today.max', 'Aujourd hui max'], ['clickEventTimingMax', 'clic Event Timing max'],
];
for (const v of vs) {
  console.log(`\n### ${v} (DPR ${DPR})\n| mesure | x1 | x4 | x6 |\n|---|---|---|---|`);
  const d = {}; for (const t of [1, 4, 6]) { const p = `results/r2-${v}-dpr${DPR}-throttle${t}.json`; d[t] = existsSync(p) ? JSON.parse(readFileSync(p)).runs : []; }
  for (const [p, l] of rows) {
    const cells = [1, 4, 6].map((t) => { const x = d[t].map((r) => get(r, p)).filter((y) => y !== undefined && y !== null && isFinite(y)); return x.length ? `${f(med(x))} [${f(Math.min(...x))}-${f(Math.max(...x))}]` : 'n/a'; });
    if (cells.every((c) => c === 'n/a')) continue; console.log(`| ${l} | ${cells.join(' | ')} |`);
  }
}
