// Rend apps/web/public/favicon.svg en PNG 16 × 16 (repli des navigateurs sans favicon SVG) avec le Chromium de Playwright.
// Ponctuel : à relancer seulement si favicon.svg change. Usage : node scripts/render-favicon.mjs
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync(new URL("../apps/web/public/favicon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1, colorScheme: "light" });
await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:16px;height:16px}</style>${svg}`);
await page.screenshot({ path: new URL("../apps/web/public/favicon-16.png", import.meta.url).pathname, omitBackground: true, clip: { x: 0, y: 0, width: 16, height: 16 } });
await browser.close();
