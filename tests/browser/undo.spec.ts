// Annuler / Rétablir dans un vrai navigateur (démo ?demo=1, écritures locales) : glisser un bloc, Ctrl+Z le remet à sa
// place, Ctrl+Maj+Z le redéplace ; boutons de la barre d'outils et annonces aria-live. Vérifié par les positions et
// l'aria-label des blocs, jamais par des captures.
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

interface Box { key: string; label: string; x: number; y: number; w: number; h: number }
const GUTTER_PX = 140;
const HEADER_PX = 32;

const allBlocks = (page: Page): Promise<Box[]> => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => {
    const r = e.getBoundingClientRect();
    return { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
  }));
const blockByKey = async (page: Page, key: string) => (await allBlocks(page)).find((b) => b.key === key) ?? null;
const pxPerDay = (page: Page) => page.evaluate(() => {
  const xs = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((e) => e.getBoundingClientRect().left).sort((a, b) => a - b);
  return xs[1]! - xs[0]!;
});
const toolbarButton = (page: Page, name: string) => page.getByRole("toolbar").getByRole("button", { name, exact: true });
const notice = (page: Page) => page.locator(".wn-notice");

test("glisser un bloc, Ctrl+Z le remet, Ctrl+Maj+Z le redéplace ; boutons et annonces", async ({ page }) => {
  await openDemo(page);
  await expect(toolbarButton(page, "Annuler")).toBeDisabled();
  await expect(toolbarButton(page, "Rétablir")).toBeDisabled();
  const ppd = await pxPerDay(page);
  const g = (await page.getByRole("grid").boundingBox())!;
  const b = (await allBlocks(page)).find((x) => !x.label.includes("chaque") && !x.label.includes("tentatif") && x.h >= 18
    && x.x >= g.x + GUTTER_PX + 8 && x.x + x.w + 2 * ppd <= g.x + g.width - 80 && x.y >= g.y + HEADER_PX + 8 && x.y + x.h <= g.y + g.height - 80);
  expect(b, "un bloc visible convenable").toBeTruthy();

  await page.mouse.move(b!.x + b!.w / 2, b!.y + 4);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.w / 2 + ppd, b!.y + 4, { steps: 4 });
  await page.mouse.move(b!.x + b!.w / 2 + 2 * ppd, b!.y + 4, { steps: 4 });
  await page.mouse.up();
  await expect(notice(page)).toContainText("Modification enregistrée.");
  await expect.poll(async () => (await blockByKey(page, b!.key))?.label).not.toBe(b!.label);
  const moved = (await blockByKey(page, b!.key))!;
  expect(moved.x - b!.x).toBeCloseTo(2 * ppd, 0);
  await expect(toolbarButton(page, "Annuler")).toBeEnabled();

  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Déplacement annulé.");
  await expect.poll(async () => (await blockByKey(page, b!.key))?.label).toBe(b!.label);
  expect((await blockByKey(page, b!.key))!.x).toBeCloseTo(b!.x, 0);
  await expect(toolbarButton(page, "Annuler")).toBeDisabled();
  await expect(toolbarButton(page, "Rétablir")).toBeEnabled();

  await page.keyboard.press("Control+Shift+z");
  await expect(notice(page)).toHaveText("Déplacement rétabli.");
  await expect.poll(async () => (await blockByKey(page, b!.key))?.label).toBe(moved.label);
  expect((await blockByKey(page, b!.key))!.x).toBeCloseTo(moved.x, 0);

  // Les boutons font la même chose que les raccourcis.
  await toolbarButton(page, "Annuler").click();
  await expect(notice(page)).toHaveText("Déplacement annulé.");
  await expect.poll(async () => (await blockByKey(page, b!.key))?.label).toBe(b!.label);
});
