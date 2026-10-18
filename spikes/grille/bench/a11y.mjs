// Vérifications d'accessibilité de B3 (overlay DOM) faisables avec Playwright :
// arbre d'accessibilité (CDP + ariaSnapshot), atteignabilité au clavier, navigation flèches, annonce, suivi du scroll.
// NE vérifie PAS le comportement d'un lecteur d'écran réel (NVDA, JAWS, VoiceOver).
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)); const PORT = 5195;
const srv = spawn(process.execPath, [root + 'node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch(); const out = { checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); console.log(ok ? 'OK ' : 'KO ', name, detail ?? ''); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/canvas2.html?a11y=1`); await page.waitForFunction(() => window.__ready);
  const cdp = await ctx.newCDPSession(page);
  const ax = async () => { const { nodes } = await cdp.send('Accessibility.getFullAXTree'); const roles = {}; for (const n of nodes) if (!n.ignored) { const r = n.role?.value; roles[r] = (roles[r] ?? 0) + 1; } return { total: nodes.length, unignored: nodes.filter((n) => !n.ignored).length, roles }; };
  out.axInitial = await ax();
  out.ovNodes = await page.evaluate(() => window.__bench.ovNodes()); out.ovCells = await page.evaluate(() => window.__bench.ovCells());
  out.domTotal = await page.evaluate(() => window.__bench.domNodes());
  check('arbre AX : un grid', out.axInitial.roles.grid === 1, JSON.stringify(out.axInitial.roles));
  check('arbre AX : gridcells = cellules overlay', out.axInitial.roles.gridcell === out.ovCells, `${out.axInitial.roles.gridcell} vs ${out.ovCells}`);
  const snap = await page.locator('#ov').ariaSnapshot(); out.ariaSnapshotHead = snap.split('\n').slice(0, 8);
  check('ariaSnapshot lisible', /grid "Planning/.test(snap) && /gridcell "Allocation/.test(snap), out.ariaSnapshotHead.slice(0, 3).join(' | '));
  // Tab depuis le dernier bouton de la barre
  await page.focus('#today-btn'); await page.keyboard.press('Tab');
  const f0 = await page.evaluate(() => ({ role: document.activeElement.getAttribute('role'), label: document.activeElement.getAttribute('aria-label') }));
  check('Tab atteint une cellule de la grille', f0.role === 'gridcell', f0.label);
  const seq = []; const keys = ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'End', 'Home'];
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(60);
    seq.push(await page.evaluate((k) => { const a = document.activeElement; const r = a.getBoundingClientRect(), s = window.__bench.scrollEl.getBoundingClientRect();
      return { key: k, role: a.getAttribute('role'), label: a.getAttribute('aria-label'), live: document.getElementById('announce').textContent, inView: r.left >= s.left + 159 && r.top >= s.top + 39 && r.left < s.right && r.bottom <= s.bottom + 1 }; }, k)); }
  out.keySeq = seq;
  check('flèches : le focus reste sur des gridcells', seq.every((s) => s.role === 'gridcell'));
  check('flèches : la cellule change à chaque touche', new Set(seq.map((s) => s.label)).size >= 6, `${new Set(seq.map((s) => s.label)).size} libellés distincts / ${seq.length}`);
  check('annonce : la région live reprend le libellé focalisé', seq.every((s) => s.live === s.label));
  check('cellule focalisée visible dans le viewport', seq.every((s) => s.inView), seq.filter((s) => !s.inView).map((s) => s.key).join(','));
  // 40 x ArrowRight : force le scroll horizontal au-delà de la fenêtre initiale
  const sl0 = await page.evaluate(() => window.__bench.scrollEl.scrollLeft);
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  const far = await page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(), s = window.__bench.scrollEl.getBoundingClientRect(); return { role: a.getAttribute('role'), sl: window.__bench.scrollEl.scrollLeft, inView: r.left >= s.left + 159 && r.left < s.right, tab0: document.querySelectorAll('#ov [tabindex="0"]').length }; });
  check('40 x flèche droite : scroll suit, focus conservé', far.role === 'gridcell' && far.sl > sl0 && far.inView, JSON.stringify({ sl0, ...far }));
  check('tabindex itinérant : une seule cellule tabindex=0', far.tab0 === 1, String(far.tab0));
  // 20 x ArrowDown : recyclage des lignes de l'overlay
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  const down = await page.evaluate(() => ({ role: document.activeElement.getAttribute('role'), st: window.__bench.scrollEl.scrollTop, label: document.activeElement.getAttribute('aria-label') }));
  check('20 x flèche bas : scroll vertical, focus conservé', down.role === 'gridcell' && down.st > 0, JSON.stringify(down));
  // scroll souris loin de la cellule focalisée : le focus doit rester dans la grille (pas sur body)
  await page.evaluate(() => { window.__bench.scrollEl.scrollTop += 3000; }); await page.waitForTimeout(150);
  const lost = await page.evaluate(() => ({ id: document.activeElement.id, role: document.activeElement.getAttribute('role') }));
  check('scroll hors de la cellule focalisée : focus replié sur la grille', lost.role === 'grid', JSON.stringify(lost));
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(80);
  const back = await page.evaluate(() => ({ role: document.activeElement.getAttribute('role'), label: document.activeElement.getAttribute('aria-label') }));
  check('reprise au clavier depuis la grille', back.role === 'gridcell', back.label);
  out.kbMs = await page.evaluate(() => window.__bench.metrics.kbMs);
  out.axAfter = await ax();
  out.errors = errors; check('aucune erreur JS', errors.length === 0, errors.join(' ; '));
  await ctx.close();
} finally { await browser.close(); srv.kill(); }
writeFileSync(root + 'results/r2-a11y-B3.json', JSON.stringify(out, null, 1));
