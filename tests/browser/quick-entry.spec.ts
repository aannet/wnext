// Saisie rapide dans un vrai navigateur (démo ?demo=1, écritures locales) : « / » focalise la barre, une phrase conforme à
// la grammaire du moteur crée un bloc visible, Ctrl+Z le retire. Vérifié par les aria-label des blocs, jamais par des captures.
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

const labels = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => e.getAttribute("aria-label") ?? ""));
const mine = (l: string[]) => l.filter((x) => x.startsWith("Projet A, ") && x.includes("4 h par jour"));

test("« / », phrase, Entrée : bloc visible et annoncé ; Ctrl+Z le retire", async ({ page }) => {
  await openDemo(page);
  const before = mine(await labels(page)).length;
  await page.getByRole("grid").focus();
  await page.keyboard.press("/");
  const input = page.getByRole("combobox", { name: "Allocation en langage simple" });
  await expect(input).toBeFocused();
  await page.getByLabel("Personne cible").selectOption({ index: 1 });
  await input.fill("Projet A 4h lun-mer");
  await expect(page.locator("#wn-quick-preview")).toContainText("Projet A, Personne");
  await page.keyboard.press("Enter");
  await expect(page.locator(".wn-notice")).toHaveText("Allocation créée.");
  await expect(page.getByRole("grid")).toBeFocused();
  await expect.poll(async () => mine(await labels(page)).length).toBe(before + 1);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".wn-notice")).toHaveText("Ajout annulé.");
  await expect.poll(async () => mine(await labels(page)).length).toBe(before);
});

test("projet ambigu : liste de candidats au clavier", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("grid").focus();
  await page.keyboard.press("n");
  await page.getByLabel("Personne cible").selectOption({ index: 1 });
  const input = page.getByRole("combobox", { name: "Allocation en langage simple" });
  await input.fill("Projet 4h lun");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator("#wn-quick-preview")).toContainText("Projet B");
});
