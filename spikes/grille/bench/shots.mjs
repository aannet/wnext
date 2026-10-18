// Captures de contrôle visuel (non mesurées). OUT=dossier de sortie.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)); const OUT = process.env.OUT ?? '/tmp'; const PORT = 5196;
const srv = spawn(process.execPath, [root + 'node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
try {
  for (const [name, p] of [['A2', 'dom-opt.html'], ['B2', 'canvas2.html'], ['B3', 'canvas2.html?a11y=1']]) {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })).newPage();
    page.on('pageerror', (e) => console.log(name, 'ERR', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/${p}`); await page.waitForFunction(() => window.__ready);
    await page.screenshot({ path: `${OUT}/${name}-0.png` });
    await page.evaluate(() => window.__bench.scrollRun(1500, 20, 14)); await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${name}-scrolled.png` });
    await page.click('#zm'); await page.waitForTimeout(200); await page.screenshot({ path: `${OUT}/${name}-month.png` });
  }
} finally { await browser.close(); srv.kill(); }
