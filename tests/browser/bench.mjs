// Banc fps de l'écran Schedule dans un vrai Chromium (ADR-005 §8.4 : objectif >= 55 fps médian sur le poste de référence).
// `npm run bench:browser` (racine). Démo 300 personnes, fenêtre 1600 x 900, un zoom après l'autre :
//   1. défilement horizontal continu programmé (~5 s, 1500 px/s), 2. défilement vertical (aller-retour, ~3 s).
// Mesure : durées d'image (requestAnimationFrame), long tasks (PerformanceObserver "longtask", > 50 ms), et, hors défilement,
// le coût de buildGrid (reconstruction de tranche) chronométré dans le navigateur sur la fenêtre de modèle réelle du zoom.
// Sortie : tests/browser/out/bench.json et un tableau. La VM WSL (rendu logiciel) n'est pas le poste de référence.
// Variables : BENCH_PORT (5184), BENCH_HSEC (5), BENCH_VSEC (3), BENCH_SPEED (px/s horizontal, 1500).
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = fileURLToPath(new URL("./out/", import.meta.url));
const PORT = Number(process.env.BENCH_PORT ?? 5184);
const HSEC = Number(process.env.BENCH_HSEC ?? 5);
const VSEC = Number(process.env.BENCH_VSEC ?? 3);
const SPEED = Number(process.env.BENCH_SPEED ?? 1500);
const base = `http://127.0.0.1:${PORT}`;

const vite = spawn("npm", ["run", "dev", "-w", "@wnext/web", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: root, stdio: "ignore", detached: true });
const stopVite = () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { /* déjà arrêté */ } };
process.on("exit", stopVite);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopVite(); process.exit(130); });

async function waitServer() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/?demo=1`)).ok) return; } catch { /* pas prêt */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Vite n'a pas démarré");
}

/** Exécuté dans la page : défile en continu pendant `sec` secondes et rend les durées d'image et les long tasks. */
function runScroll({ axis, sec, speed }) {
  return new Promise((resolve) => {
    const grid = document.querySelector('[role="grid"]');
    const longtasks = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }); });
    po.observe({ type: "longtask", buffered: false });
    const frames = [];
    const slow = [];
    const t0 = performance.now();
    let last = t0;
    let pos0 = axis === "x" ? grid.scrollLeft : grid.scrollTop;
    const maxV = grid.scrollHeight - grid.clientHeight;
    const step = (now) => {
      const dt = now - last;
      last = now;
      if (frames.length || dt < 1000) frames.push(dt); // première image : intervalle d'amorçage ignoré
      const el = (now - t0) / 1000;
      if (el >= sec) { po.disconnect(); return resolve({ frames: frames.slice(1), longtasks, slow }); }
      if (axis === "x") grid.scrollLeft = pos0 + speed * el;
      else {
        // aller-retour vertical : une montée de speed px/s puis retour
        const half = sec / 2;
        const d = el < half ? el : sec - el;
        grid.scrollTop = Math.min(maxV, pos0 + speed * d);
      }
      if (dt > 50) slow.push({ ms: Math.round(dt), sl: Math.round(grid.scrollLeft), st: Math.round(grid.scrollTop) });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Chronomètre buildGrid (construction du modèle d'une tranche) dans le navigateur, via les modules servis par Vite. */
async function timeBuild(page, zoom) {
  return page.evaluate(async (zoom) => {
    const { demoSchedule } = await import("/src/demo.ts");
    const { buildGrid } = await import("/src/schedule/grid-model.ts");
    const pxPerDay = { day: 96, week: 28, month: 8 }[zoom];
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());
    const data = demoSchedule(today);
    const viewDays = Math.ceil((window.innerWidth - 32 - 140) / pxPerDay);
    const days = Math.min(392, Math.ceil((viewDays * 3) / 28) * 28); // (plafond : plage max 400 j) vue élargie d'une largeur de chaque côté, alignée sur des blocs de 28 j
    const add = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const range = { from: add(today, -Math.floor(days / 2)), to: add(today, Math.ceil(days / 2) - 1) };
    const times = [];
    for (let i = 0; i < 12; i++) { const a = performance.now(); buildGrid(data, range, pxPerDay, zoom); times.push(performance.now() - a); }
    times.shift(); // premier appel (JIT froid) écarté du résumé, conservé à part
    times.sort((x, y) => x - y);
    return { days, medianMs: times[Math.floor(times.length / 2)], maxMs: times[times.length - 1] };
  }, zoom);
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (n) => Math.round(n * 10) / 10;
function summarize(r) {
  const f = r.frames;
  return {
    frames: f.length,
    medianFps: r1(1000 / pct(f, 0.5)),
    p95FrameMs: r1(pct(f, 0.95)),
    maxFrameMs: r1(Math.max(...f)),
    framesOver50ms: f.filter((x) => x > 50).length,
    longTasks: r.longtasks.length,
    longTaskMaxMs: r.longtasks.reduce((m, e) => Math.max(m, e.ms), 0),
    slowFrames: r.slow.slice(0, 12),
  };
}

const results = { env: { viewport: "1600x900", speedPxPerSec: SPEED, hSec: HSEC, vSec: VSEC, note: "Chromium headless, rendu logiciel, VM WSL : pas le poste de référence" }, zooms: {} };
let browser;
try {
  await waitServer();
  browser = await chromium.launch();
  results.env.browser = browser.version();
  for (const zoom of ["day", "week", "month"]) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/?demo=1`);
    await page.getByRole("grid").waitFor();
    await page.getByRole("rowheader").first().waitFor();
    if (zoom !== "day") await page.getByRole("button", { name: zoom === "week" ? "Semaine" : "Mois", exact: true }).click();
    await page.waitForTimeout(1500);
    const horizontal = summarize(await page.evaluate(runScroll, { axis: "x", sec: HSEC, speed: SPEED }));
    await page.waitForTimeout(800);
    const vertical = summarize(await page.evaluate(runScroll, { axis: "y", sec: VSEC, speed: 6000 }));
    const build = await timeBuild(page, zoom);
    results.zooms[zoom] = { horizontal, vertical, buildGrid: build };
    await ctx.close();
  }
} finally {
  await browser?.close();
  stopVite();
}

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}bench.json`, JSON.stringify(results, null, 1));
const rows = [];
for (const [zoom, z] of Object.entries(results.zooms)) {
  for (const axis of ["horizontal", "vertical"]) {
    const s = z[axis];
    rows.push({ zoom, axis, "fps médian": s.medianFps, "p95 image (ms)": s.p95FrameMs, "max (ms)": s.maxFrameMs, "images > 50 ms": s.framesOver50ms, "long tasks": s.longTasks, "long task max (ms)": s.longTaskMaxMs });
  }
}
console.table(rows);
console.table(Object.entries(results.zooms).map(([zoom, z]) => ({ zoom, "buildGrid médian (ms)": r1(z.buildGrid.medianMs), "max (ms)": r1(z.buildGrid.maxMs), "jours du modèle": z.buildGrid.days })));
console.log(JSON.stringify(results));
const ok = Object.values(results.zooms).every((z) => z.horizontal.medianFps >= 55);
console.log(ok ? "Objectif ADR-005 (>= 55 fps médian en défilement horizontal) : atteint sur cette machine" : "Objectif ADR-005 (>= 55 fps médian) : NON atteint sur cette machine (VM WSL, rendu logiciel)");
