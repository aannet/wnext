// Gestes tactiles (WCAG 2.5.7) dans un contexte hasTouch, via les événements tactiles réels de Chromium (CDP Input.dispatchTouchEvent) :
// tap = poignées, appui long + glisser = déplacement, balayage rapide = défilement de la grille sans toucher au bloc ; case vide :
// tap = rien, appui long + glisser = drawer de création (RT-043).
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

test.use({ hasTouch: true });

interface Box { key: string; label: string; x: number; y: number; w: number; h: number }
const blocks = (page: Page): Promise<Box[]> => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => {
    const r = e.getBoundingClientRect();
    return { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
  }));
const byKey = async (page: Page, key: string) => (await blocks(page)).find((b) => b.key === key)!;
const pickBlock = async (page: Page, room: number): Promise<Box> => {
  const g = (await page.getByRole("grid").boundingBox())!;
  const b = (await blocks(page)).find((x) => x.x >= g.x + 260 && x.x + x.w + room <= g.x + g.width - 80 && x.y >= g.y + 48 && x.y + x.h <= g.y + g.height - 80
    && x.h >= 30 && x.w >= 60 && !x.label.includes("chaque") && !x.label.includes("tentatif"));
  expect(b, "un bloc visible convenable").toBeTruthy();
  return b!;
};
const pxPerDay = (page: Page) => page.evaluate(() => {
  const xs = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((e) => e.getBoundingClientRect().left).sort((a, b) => a - b);
  return xs[1]! - xs[0]!;
});
const scrollLeft = (page: Page) => page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft);
/** Une case libre (ni bloc, ni congé, ni bande de capacité) d'une ligne visible, avec `room` px libres à sa droite ; nom de la personne. */
const freeCell = (page: Page, room: number): Promise<{ x: number; y: number; person: string } | null> => page.evaluate((room) => {
  const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  const free = (x: number, y: number, r: HTMLElement) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && r.contains(hit) && !hit.closest(".wn-block, .wn-timeoff, .wn-cap, .wn-rowheader");
  };
  const rows = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .map((r) => ({ r, box: r.getBoundingClientRect() })).filter(({ box }) => box.top > grid.top + 40 && box.bottom < grid.bottom - 10);
  const heads = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((h) => h.getBoundingClientRect())
    .filter((h) => h.left > grid.left + 260 && h.right + room < grid.right - 80);
  for (const { r, box } of rows) {
    for (const h of heads) {
      const x = h.left + h.width / 2;
      const y = box.top + 8;
      if (free(x, y, r) && free(x + room, y, r)) return { x, y, person: r.querySelector(".wn-person-name")!.textContent! };
    }
  }
  return null;
}, room);

type Pt = { x: number; y: number };
/** Un doigt : pose en `from`, attend `holdMs`, passe par `steps` points jusqu'à `to`, relâche (`to` absent : simple tap). */
async function finger(page: Page, from: Pt, to: Pt | null, opts: { holdMs?: number; steps?: number } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: string, p?: Pt) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
  await send("touchStart", from);
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  const n = to ? (opts.steps ?? 8) : 0;
  for (let i = 1; i <= n; i++) {
    await send("touchMove", { x: from.x + ((to!.x - from.x) * i) / n, y: from.y + ((to!.y - from.y) * i) / n });
    await page.waitForTimeout(16);
  }
  await send("touchEnd");
  await cdp.detach();
}

test.describe("gestes tactiles (démo)", () => {
  test.beforeEach(async ({ page }) => { await openDemo(page); });

  test("tap sur un bloc : sélection et poignées ; tap ailleurs : désélection", async ({ page }) => {
    const b = await pickBlock(page, 0);
    const sel = page.locator(`.wn-block[data-key="${b.key}"]`);
    expect(await sel.evaluate((e) => getComputedStyle(e).touchAction)).toBe("pan-x pan-y");
    await finger(page, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, null);
    await expect(sel).toHaveAttribute("aria-selected", "true");
    await expect(sel.locator("[data-handle]")).toHaveCount(3);
    const start = (await sel.locator('[data-handle="start"]').boundingBox())!;
    expect(start.width).toBeGreaterThanOrEqual(b.w >= 110 ? 44 : 22);
    expect(start.height).toBeGreaterThanOrEqual(Math.min(44, b.h - 1));
    expect(await sel.evaluate((e) => getComputedStyle(e).touchAction)).toBe("none");
    const g = (await page.getByRole("grid").boundingBox())!;
    await finger(page, { x: g.x + g.width - 20, y: g.y + 20 }, null);
    await expect(sel).not.toHaveAttribute("aria-selected", "true");
    await expect(sel.locator("[data-handle]")).toHaveCount(0);
  });

  test("appui long puis glisser de deux jours : le bloc est déplacé", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, 2 * ppd);
    const from = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await finger(page, from, { x: from.x + 2 * ppd, y: from.y }, { holdMs: 550 });
    await expect(page.locator(".wn-notice")).toContainText("Modification enregistrée.");
    await expect.poll(async () => (await byKey(page, b.key)).label).not.toBe(b.label);
    expect((await byKey(page, b.key)).x - b.x).toBeCloseTo(2 * ppd, 0);
  });

  test("balayage rapide sans appui long : la grille défile, le bloc ne bouge pas", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, 0);
    const before = await scrollLeft(page);
    const from = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await finger(page, from, { x: from.x - 3 * ppd, y: from.y }, { steps: 12 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(before + ppd);
    await expect(page.locator(".wn-notice")).not.toContainText("Modification enregistrée.");
    expect(await page.locator(".wn-block.wn-selected, .wn-block.wn-armed").count()).toBe(0);
  });

  test("appui long sur une case vide ouvre le drawer de création ; un tap sur une case vide ne crée rien (RT-043)", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const cell = await freeCell(page, ppd);
    expect(cell, "une case libre visible").toBeTruthy();
    const dialog = page.getByRole("dialog");

    await finger(page, cell!, null);
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".wn-slot-draft")).toHaveCount(0);

    const before = await scrollLeft(page);
    await finger(page, cell!, { x: cell!.x + ppd, y: cell!.y }, { holdMs: 550, steps: 4 });
    await expect(dialog.getByRole("heading")).toHaveText("Nouvelle allocation");
    await expect(dialog.getByRole("checkbox", { name: cell!.person, exact: true })).toBeChecked();
    const draft = (await page.locator(".wn-slot-draft").boundingBox())!;
    expect(draft.width).toBeCloseTo(2 * ppd, 0);
    expect(await scrollLeft(page)).toBe(before);
  });

  test("balayage rapide depuis une case vide : la grille défile, rien n'est créé", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const cell = await freeCell(page, 0);
    expect(cell, "une case libre visible").toBeTruthy();
    const before = await scrollLeft(page);
    await finger(page, cell!, { x: cell!.x - 3 * ppd, y: cell!.y }, { steps: 12 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(before + ppd);
    await page.waitForTimeout(600);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".wn-slot-draft")).toHaveCount(0);
  });
});
