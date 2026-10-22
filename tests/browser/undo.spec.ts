// Annuler / Rétablir dans un vrai navigateur (démo ?demo=1, écritures locales) : glisser un bloc, Ctrl+Z le remet à sa
// place, Ctrl+Maj+Z le redéplace ; boutons de la barre d'outils et annonces aria-live. Vérifié par les positions et
// l'aria-label des blocs, jamais par des captures.
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

interface Box { key: string; label: string; x: number; y: number; w: number; h: number }
const GUTTER_PX = 240; // colonne des personnes (ux-ui §2.1, lot L-C)
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

// Commandes d'un bloc (RT-047, US-3.2) : Suppr, Ctrl+D et Scinder, chacune annulée par Ctrl+Z.
const usable = async (page: Page, ok: (b: Box) => boolean = () => true) => {
  const g = (await page.getByRole("grid").boundingBox())!;
  const ppd = await pxPerDay(page);
  const b = (await allBlocks(page)).find((x) => !x.label.includes("chaque") && x.h >= 18 && x.x >= g.x + GUTTER_PX + 8 && x.x + x.w + 4 * ppd <= g.x + g.width - 80
    && x.y >= g.y + HEADER_PX + 8 && x.y + x.h <= g.y + g.height - 80 && ok(x));
  expect(b, "un bloc visible convenable").toBeTruthy();
  return b!;
};
/** Nombre de blocs affichés dans la ligne (personne) du bloc `key`. */
const rowCount = (page: Page, key: string) => page.evaluate((k) => {
  const row = document.querySelector(`.wn-block[data-key="${k}"]`)?.closest(".wn-row");
  return row ? [...row.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").length : -1;
}, key);

test("Suppr supprime le bloc (annoncé), Ctrl+Z le rend à sa place, Ctrl+Maj+Z le resupprime", async ({ page }) => {
  await openDemo(page);
  const b = await usable(page);
  await page.locator(`.wn-block[data-key="${b.key}"]`).focus();
  await page.keyboard.press("Delete");
  await expect(notice(page)).toHaveText("Allocation supprimée. Ctrl+Z annule.");
  await expect.poll(async () => (await blockByKey(page, b.key)) === null).toBe(true);
  await expect(page.getByRole("grid")).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Suppression annulée.");
  await expect.poll(async () => (await allBlocks(page)).filter((x) => x.label === b.label && Math.abs(x.x - b.x) < 1).length).toBe(1);
  await page.keyboard.press("Control+Shift+z");
  await expect(notice(page)).toHaveText("Suppression rétablie.");
  await expect.poll(async () => (await allBlocks(page)).filter((x) => x.label === b.label && Math.abs(x.x - b.x) < 1).length).toBe(0);
});

test("Ctrl+D duplique le bloc juste après lui (copie focalisée et sélectionnée), Ctrl+Z retire la copie", async ({ page }) => {
  await openDemo(page);
  const b = await usable(page, (x) => / du /.test(x.label));
  const before = await rowCount(page, b.key);
  await page.locator(`.wn-block[data-key="${b.key}"]`).focus();
  await page.keyboard.press("Control+d");
  await expect(notice(page)).toHaveText("Allocation dupliquée. Ctrl+Z annule.");
  const copy = page.locator(".wn-block[data-key]:focus");
  await expect(copy).toHaveAttribute("aria-selected", "true");
  const box = (await copy.boundingBox())!;
  expect(box.x).toBeCloseTo(b.x + b.w, 0);
  expect(box.width).toBeCloseTo(b.w, 0);
  expect(await rowCount(page, b.key)).toBe(before + 1);
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Duplication annulée.");
  await expect.poll(() => rowCount(page, b.key)).toBe(before);
});

test("S ouvre l'étape « Scinder » (date au milieu) ; Scinder donne deux blocs côte à côte, Ctrl+Z les refond", async ({ page }) => {
  await openDemo(page);
  const ppd = await pxPerDay(page);
  const b = await usable(page, (x) => x.w >= 2 * ppd - 1);
  await page.locator(`.wn-block[data-key="${b.key}"]`).focus();
  await page.keyboard.press("s");
  const dialog = page.getByRole("dialog", { name: "Scinder l’allocation" });
  await expect(dialog.getByLabel("Début de la seconde partie")).toBeFocused();
  await dialog.getByRole("button", { name: "Scinder", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(notice(page)).toHaveText("Allocation scindée en deux. Ctrl+Z annule.");
  const before = b.label.split(",")[0]!;
  await expect.poll(async () => (await blockByKey(page, b.key))?.w ?? b.w).toBeLessThan(b.w - 1);
  const first = (await blockByKey(page, b.key))!;
  expect(first.x).toBeCloseTo(b.x, 0);
  const second = (await allBlocks(page)).find((x) => x.key !== b.key && Math.abs(x.x - (first.x + first.w)) < 1 && x.label.startsWith(`${before},`));
  expect(second, "seconde partie juste après la première").toBeTruthy();
  expect(first.w + second!.w).toBeCloseTo(b.w, 0);
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Scission annulée.");
  await expect.poll(async () => (await blockByKey(page, b.key))?.w ?? 0).toBeCloseTo(b.w, 0);
});
