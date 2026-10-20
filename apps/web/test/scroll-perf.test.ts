// @vitest-environment jsdom
// Mesure indicative (jsdom, JS seul : ni style, ni mise en page, ni peinture) du coût d'un redessin pendant le défilement
// continu, sur la démo 300 personnes (src/demo.ts). Hors `make check` : `npm run perf:scroll -w @wnext/web`.
// Le banc réel (60 i/s, navigateur) est un autre lot (Playwright).
import { DEFAULT_PX_PER_DAY, type Zoom } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { demoSchedule } from "../src/demo";
import { buildGrid } from "../src/schedule/grid-model";
import { GUTTER_PX, createScroller, type Clock } from "../src/schedule/scroller";

const TODAY = "2026-10-20";
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const ms = (x: number) => `${x.toFixed(2)} ms`;

function bench(zoom: Zoom, dx: number, dy: number, frames = 600) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let t = 0;
  let queue: (() => void)[] = [];
  let idle: (() => void)[] = [];
  const clock: Partial<Clock> = { raf: (cb) => queue.push(cb), caf: () => {}, now: () => t, setTimer: () => 0, clearTimer: () => {}, idle: (cb) => idle.push(cb) };
  const builds: number[] = [];
  const build: typeof buildGrid = (...a) => { const t0 = performance.now(); const g = buildGrid(...a); builds.push(performance.now() - t0); return g; };
  const s = createScroller({ root, data: demoSchedule(TODAY), today: TODAY, widthPx: GUTTER_PX + 1600, heightPx: 900, label: (c) => c.from, zoom, clock, build });
  const paint: number[] = [];
  for (let i = 0; i < frames; i++) {
    t += 16;
    root.scrollLeft += dx;
    root.scrollTop = Math.max(0, (root.scrollTop + dy) % (300 * 48));
    root.dispatchEvent(new Event("scroll"));
    const fs = queue;
    queue = [];
    const t0 = performance.now();
    for (const f of fs) f();
    paint.push(performance.now() - t0);
    for (const f of idle.splice(0)) f();
  }
  const out = { zoom, dx, dy, p50: pct(paint, 0.5), p95: pct(paint, 0.95), max: Math.max(...paint), builds: builds.length, buildP50: pct(builds, 0.5), nodes: s.stats().nodes };
  s.destroy();
  root.remove();
  return out;
}

describe.skipIf(!process.env.WNEXT_PERF)("coût du redessin, démo 300 personnes × 12 000 allocations", () => {
  it("défilement horizontal, vertical et diagonal aux trois zooms", () => {
    const rows: string[] = [];
    for (const zoom of ["day", "week", "month"] as const) {
      for (const [dx, dy] of [[24, 0], [0, 18], [24, 18]] as const) {
        const r = bench(zoom, dx, dy);
        rows.push(`${zoom.padEnd(5)} dx=${String(dx).padStart(2)} dy=${String(dy).padStart(2)} | redessin p50 ${ms(r.p50)} p95 ${ms(r.p95)} max ${ms(r.max)} | modèle ${r.builds} × ${ms(r.buildP50)} (p50) | nœuds ${r.nodes}`);
        expect(r.nodes).toBeLessThan(3000);
      }
    }
    console.log(`px/jour ${JSON.stringify(DEFAULT_PX_PER_DAY)}, vue 1600 × 900 px, 600 images\n${rows.join("\n")}`);
  }, 120_000);
});
