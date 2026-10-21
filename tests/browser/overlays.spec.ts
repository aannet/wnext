// Fenêtres superposées (RT-009) dans un vrai navigateur : le formulaire de congé et la boîte BR-10 sont de vraies pop-in
// (position fixed, au-dessus de la grille, voile, page non défilable), la grille ne bouge pas à l'ouverture, axe-core sans
// violation sur la fenêtre ouverte, Échap ferme et rend le focus (à la grille pour le congé, au bloc pour BR-10).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

const GUTTER_PX = 240; // colonne des personnes (ux-ui §2.1, lot L-C)

const firstRowBlock = (page: Page): Promise<string> => page.evaluate((gutter) => {
  const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  const row = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
  const ok = [...row.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").find((e) => {
    const r = e.getBoundingClientRect();
    return /^Projet [A-F], (du|le) (lun|mar|mer|jeu|ven)\./.test(e.getAttribute("aria-label") ?? "") && r.left >= grid.left + gutter + 8 && r.left <= grid.right - 300;
  });
  return ok!.dataset.key!;
}, GUTTER_PX);

/** La fenêtre est superposée : ancêtre en position fixed, couvrant le viewport, au-dessus de la grille, page non défilable. */
async function expectOverlay(page: Page, dialog: Locator) {
  // Mesure après l'animation d'entrée (glissement du drawer) : pendant, le panneau dépasse du bord droit.
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const info = await dialog.evaluate((el) => {
    let fixed: HTMLElement | null = null;
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) if (getComputedStyle(n).position === "fixed") { fixed = n; break; }
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
    // Base UI : le voile est un frère du panneau (data-slot=dialog-overlay), en position fixed sur tout le viewport.
    const scrim = [...document.querySelectorAll<HTMLElement>("[data-slot=dialog-overlay]")].find((s) => getComputedStyle(s).position === "fixed");
    return {
      fixed: fixed !== null,
      coversViewport: scrim ? scrim.getBoundingClientRect().width === innerWidth && scrim.getBoundingClientRect().height === innerHeight : false,
      topmost: hit !== null && el.contains(hit),
      insideViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      scrollLocked: getComputedStyle(document.body).overflow === "hidden",
      inBody: el.closest("body > div") !== null,
    };
  });
  expect(info).toEqual({ fixed: true, coversViewport: true, topmost: true, insideViewport: true, scrollLocked: true, inBody: true });
  // Au-dessus de la grille : un point de la grille, hors fenêtre, est recouvert par le voile (pas par la grille).
  const covered = await page.evaluate(() => {
    const g = document.querySelector('[role="grid"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(g.left + 20, g.top + 20);
    return hit !== null && !document.querySelector('[role="grid"]')!.contains(hit);
  });
  expect(covered, "le voile recouvre la grille").toBe(true);
}

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
}

test("formulaire de congé : pop-in superposée, la grille ne bouge pas, axe propre, Échap rend le focus à la grille", async ({ page }) => {
  await openDemo(page);
  const key = await firstRowBlock(page);
  const block = page.locator(`.wn-block[data-key="${key}"]`);
  // Par sélecteur et non par rôle : derrière une fenêtre modale, la grille sort de l'arbre d'accessibilité (Base UI, inert).
  const grid = page.locator('[role="grid"]');
  const before = await grid.boundingBox();
  const scrollBefore = await page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft);

  await block.focus();
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "Nouveau congé" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Fermer la fenêtre" })).toBeVisible();
  await expect(dialog.getByLabel("Personne")).toBeFocused();

  expect(await grid.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft)).toBe(scrollBefore);
  await expectOverlay(page, dialog);
  await axeClean(page);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await grid.boundingBox()).toEqual(before);
  await expect(grid).toBeFocused(); // contrat existant du congé : le focus revient à la grille
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("formulaire de congé : le bouton Fermer (×) ferme sans enregistrer", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("grid").focus();
  await page.getByRole("button", { name: "Nouveau congé" }).click();
  const dialog = page.getByRole("dialog", { name: "Nouveau congé" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Fermer la fenêtre" }).click();
  await expect(dialog).toHaveCount(0);
});

test("BR-10 : la boîte de retrait est une pop-in superposée, la grille ne bouge pas, axe propre", async ({ page }) => {
  await openDemo(page);
  const key = await firstRowBlock(page);
  // Par sélecteur et non par rôle : derrière une fenêtre modale, la grille sort de l'arbre d'accessibilité (Base UI, inert).
  const grid = page.locator('[role="grid"]');
  const before = await grid.boundingBox();

  await page.locator(`.wn-block[data-key="${key}"]`).click({ button: "right" });
  await page.getByRole("menuitem").click();
  const dialog = page.getByRole("dialog", { name: /^Retirer Personne 1 du projet / });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retirer du projet" })).toBeFocused();

  expect(await grid.boundingBox()).toEqual(before);
  await expectOverlay(page, dialog);
  await axeClean(page);

  await dialog.getByRole("button", { name: "Fermer la fenêtre" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await grid.boundingBox()).toEqual(before);
  await expect(page.locator(`.wn-block[data-key="${key}"]`)).toBeFocused();
});
