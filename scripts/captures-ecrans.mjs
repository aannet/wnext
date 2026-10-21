#!/usr/bin/env node
// Captures d'écran de la démo (?demo=1) pour comparer un rendu avant / après un changement de CSS global (L-G, preflight).
// Usage : node scripts/captures-ecrans.mjs <dossier> [url de base, défaut http://localhost:5173]
// Hors make check : il faut un serveur Vite lancé (npm run dev -w @wnext/web). Viewport 1600 × 900, comme les tests navigateur.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [dir, base = "http://localhost:5173"] = process.argv.slice(2);
if (!dir) { console.error("usage : node scripts/captures-ecrans.mjs <dossier> [url]"); process.exit(2); }
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: join(dir, `${name}.png`) }); console.log(name); };
const open = async (path) => { await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}demo=1&lang=fr`); await page.waitForLoadState("networkidle"); };

await open("/");
await shot("01-planning");
for (const [zoom, name] of [["Semaine", "01b-planning-semaine"], ["Mois", "01c-planning-mois"], ["Jour", null]]) {
  await page.getByRole("button", { name: zoom, exact: true }).click();
  if (name) await shot(name);
}
await page.getByRole("button", { name: "Nouveau congé" }).click();
await shot("02-planning-conge");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "+ Allocation" }).click();
await shot("03-planning-creneau");
await page.keyboard.press("Escape");

await open("/projets");
await shot("04-projets");
await page.getByRole("button", { name: "Nouveau projet" }).first().click();
await shot("05-projets-nouveau");
await page.keyboard.press("Escape");
await page.locator("tbody th button").first().click();
await shot("06-projets-fiche");
await page.keyboard.press("Escape");

await open("/personnes");
await shot("07-personnes");
await page.locator("tbody th button").first().click();
await shot("08-personnes-fiche");
await page.keyboard.press("Escape");

await open("/reglages");
await shot("09-reglages");
for (const tab of await page.getByRole("tab").all()) {
  const name = (await tab.textContent())?.trim() ?? "";
  await tab.click();
  await shot(`10-reglages-${name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
}
await browser.close();
