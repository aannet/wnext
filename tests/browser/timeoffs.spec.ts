// Congés et BR-04 dans un vrai navigateur (démo ?demo=1, écritures locales) : touche C sur un bloc de la première personne
// -> congé journée entière sur son premier jour -> avertissement -> « Reprogrammer… » -> « Reporter » -> le bloc est
// décalé, le congé est dessiné ; Ctrl+Z défait le tout. Vérifié par les libellés et positions, jamais par des captures.
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

interface Box { key: string; label: string; x: number; y: number; w: number; h: number }
const GUTTER_PX = 240; // colonne des personnes (ux-ui §2.1, lot L-C)

const firstRowBlocks = (page: Page): Promise<Box[]> => page.evaluate(() => {
  const row = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
  return [...row.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => {
    const r = e.getBoundingClientRect();
    return { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
  });
});
const notice = (page: Page) => page.locator(".wn-notice");
const dialog = (page: Page) => page.getByRole("dialog");
/** Le congé posé par le test : un seul jour (« le … »), les congés de la démo durent plusieurs jours ou sont des RTT. */
const posed = (page: Page) => page.locator('.wn-timeoff[data-timeoff][aria-label^="Congés payés, le "]');

test("congé journée entière sur un bloc : avertissement, reporter, bloc décalé ; Ctrl+Z défait tout", async ({ page }) => {
  await openDemo(page);
  const g = (await page.getByRole("grid").boundingBox())!;
  // Un bloc simple de la première personne, commençant un jour ouvré, son début dans la vue.
  const b = (await firstRowBlocks(page)).find((x) => /^Projet [A-F], (du|le) (lun|mar|mer|jeu|ven)\./.test(x.label) && !x.label.includes("chaque")
    && x.x >= g.x + GUTTER_PX + 8 && x.x <= g.x + g.width - 300);
  expect(b, "un bloc visible convenable").toBeTruthy();

  await page.locator(`.wn-block[data-key="${b!.key}"]`).focus();
  await page.keyboard.press("c");
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouveau congé");
  await expect(dialog(page).getByLabel("Personne")).toHaveValue("1");
  await dialog(page).getByRole("button", { name: "Enregistrer" }).click();

  await expect(dialog(page).getByRole("heading")).toHaveText("Ce congé recouvre des allocations de Personne 1");
  await expect(dialog(page).getByRole("listitem").first()).toContainText("h planifiées pour 0 h disponibles");
  await dialog(page).getByRole("button", { name: "Reprogrammer…" }).click();
  await expect(dialog(page).getByRole("heading")).toHaveText("Reprogrammer les allocations");
  await expect(dialog(page).getByRole("radio", { name: "Reporter" }).first()).toBeChecked();
  await expect(dialog(page).getByRole("radio", { name: "Reporter" }).first()).toBeFocused();
  await dialog(page).getByRole("button", { name: "Appliquer" }).click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText("Congé enregistré et allocations reprogrammées. Ctrl+Z annule le tout.");
  await expect(posed(page)).toBeVisible();
  await expect.poll(async () => (await firstRowBlocks(page)).find((x) => x.key === b!.key)?.label).not.toBe(b!.label);
  const moved = (await firstRowBlocks(page)).find((x) => x.key === b!.key)!;
  expect(moved.x).toBeGreaterThan(b!.x); // la journée de congé n'est plus couverte : le bloc commence après
  expect((await posed(page).boundingBox())!.x).toBeCloseTo(b!.x, 0);

  await page.locator(`.wn-block[data-key="${b!.key}"]`).focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Pose du congé et reprogrammation annulée.");
  await expect.poll(async () => (await firstRowBlocks(page)).find((x) => x.key === b!.key)?.label).toBe(b!.label);
  await expect(posed(page)).toHaveCount(0);
});
