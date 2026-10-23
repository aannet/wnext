// Création au clavier et en-tête du Planning dans un vrai navigateur (démo ?demo=1, écritures locales ; recette n°4) :
//  * RT-057, RT-060 (D1) : ni barre de saisie rapide ni boutons de création ; N sur la grille ouvre le drawer prérempli (première
//    ligne visible, aujourd'hui), la création est annoncée et Ctrl+Z la retire ; Échap rend le focus à la grille.
//  * RT-061 : compteur de personnes dans le coin de la grille, collé au défilement.
//  * RT-064 : « ? » ouvre l'aide des raccourcis ; axe-core sans violation sur la fenêtre.
// Vérifié par les aria-label des blocs, jamais par des captures.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

// Horloge de la page sur un jeudi connu : « aujourd'hui » est un jour ouvré, test indépendant de la date réelle.
test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date("2026-10-22T10:00:00+02:00") }); });

const blockCount = (page: Page, prefix: string) => page.evaluate((p) => [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")]
  .filter((e) => e.style.display !== "none" && (e.getAttribute("aria-label") ?? "").startsWith(p)).length, prefix);
const firstVisiblePerson = (page: Page) => page.evaluate(() => {
  const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none" && r.getBoundingClientRect().bottom > grid.top + 32)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return rows[0]!.querySelector(".wn-person-name")!.textContent!;
});

test("en-tête du Planning : ni saisie rapide ni boutons de création ; N et C annoncés sur la grille ; compteur dans le coin", async ({ page }) => {
  await openDemo(page);
  await expect(page.locator(".wn-quick")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Allocation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nouveau congé" })).toHaveCount(0);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-keyshortcuts", /\bN\b.*\bC\b/);
  const corner = page.locator(".wn-corner");
  await expect(corner).toHaveText(/^\d+ personnes$/);
  const before = (await corner.boundingBox())!;
  await page.mouse.move(800, 400);
  await page.mouse.wheel(600, 800);
  await expect.poll(async () => (await corner.boundingBox())!.y).toBe(before.y); // collé en haut et à gauche
  expect((await corner.boundingBox())!.x).toBe(before.x);
});

test("N sur la grille : drawer prérempli (première ligne visible, aujourd'hui), création annoncée, Ctrl+Z la retire ; Échap rend le focus à la grille", async ({ page }) => {
  await openDemo(page);
  const person = await firstVisiblePerson(page);
  const beforeC = await blockCount(page, "Projet C, ");
  await page.getByRole("grid").focus();
  await page.keyboard.press("n");
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading")).toHaveText("Nouvelle allocation");
  await expect(drawer.getByRole("checkbox", { name: person, exact: true })).toBeChecked();
  await expect(drawer.getByLabel("Du", { exact: true })).toHaveValue("2026-10-22");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("grid")).toBeFocused();

  await page.keyboard.press("n");
  await drawer.getByRole("combobox", { name: "Projet" }).fill("Projet C");
  await page.keyboard.press("Enter");
  await drawer.getByRole("button", { name: "Créer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".wn-notice")).toHaveText(/Ctrl\+Z annule/);
  await expect.poll(() => blockCount(page, "Projet C, ")).toBe(beforeC + 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => blockCount(page, "Projet C, ")).toBe(beforeC);
});

test("« ? » ouvre l'aide des raccourcis (N, C, Ctrl K…) ; axe-core sans violation ; Échap la ferme", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("grid").focus();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Raccourcis clavier" });
  await expect(help).toBeVisible();
  await expect(help).toContainText("Nouvelle allocation");
  await expect(help).toContainText("Nouveau congé");
  await expect(help).toContainText("Rechercher une personne ou un projet");
  const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});
