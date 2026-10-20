// Retrait d'une personne d'un projet (BR-10) dans un vrai navigateur (démo ?demo=1, écritures locales) : clic droit sur un
// bloc de la première personne -> « Retirer … du projet … » -> récapitulatif -> « Retirer du projet » -> plus aucun bloc de ce
// projet sur sa ligne, les autres restent ; annonce aria-live. Clavier : Maj+F10 ouvre le même menu, Échap le referme.
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

// @BR-10
const firstRowLabels = (page: Page): Promise<{ key: string; label: string }[]> => page.evaluate(() => {
  const row = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
  return [...row.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none")
    .map((e) => ({ key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "" }));
});
const projectOf = (label: string) => /^(Projet [A-Z])/.exec(label)?.[1] ?? "";

test("clic droit sur un bloc : récapitulatif puis retrait ; les blocs de ce projet quittent la ligne, les autres restent", async ({ page }) => {
  await openDemo(page);
  const blocks = await firstRowLabels(page);
  const target = blocks.find((b) => projectOf(b.label) !== "");
  expect(target, "un bloc visible de la première personne").toBeTruthy();
  const project = projectOf(target!.label);
  const others = blocks.filter((b) => projectOf(b.label) !== project);

  await page.locator(`.wn-block[data-key="${target!.key}"]`).click({ button: "right" });
  const item = page.getByRole("menuitem");
  await expect(item).toHaveText(new RegExp(`^Retirer Personne 1 du projet ${project}…$`));
  await item.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(`Retirer Personne 1 du projet ${project} ?`);
  await expect(dialog.getByRole("listitem").first()).toHaveText(/^\d+ allocations? supprimées? \(du .+ au .+\)$/);
  await expect(dialog.getByRole("listitem").nth(1)).toHaveText("Aucun temps saisi supprimé");
  await dialog.getByRole("button", { name: "Retirer du projet" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".wn-notice")).toHaveText(new RegExp(`^Personne 1 n’est plus sur le projet ${project} : \\d+ allocations? et 0 temps saisi supprimés\\.$`));
  await expect.poll(async () => (await firstRowLabels(page)).filter((b) => projectOf(b.label) === project).length).toBe(0);
  const left = (await firstRowLabels(page)).map((b) => b.key);
  for (const o of others) expect(left).toContain(o.key);
});

test("clavier : Maj+F10 sur un bloc ouvre le menu, Échap le referme et rend le focus au bloc", async ({ page }) => {
  await openDemo(page);
  const target = (await firstRowLabels(page))[0]!;
  const block = page.locator(`.wn-block[data-key="${target.key}"]`);
  await block.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(block).toBeFocused();
});
