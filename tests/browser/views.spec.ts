// Vues sauvegardées dans un vrai navigateur (démo ?demo=1 : vues en mémoire doublées dans localStorage) : un filtre réduit
// les lignes, la vue s'enregistre, se retrouve après rechargement (?view=<id>), et l'écran reste sans violation axe serious / critical.
// RT-058 (D6) : les vues sont dans le panneau Filtres (« Vue » en tête, enregistrement en pied), le bouton Filtres porte le nom de la
// vue active ; RT-061 : le compteur de personnes est dans le coin de la grille.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

const people = (page: Page) => page.locator(".wn-corner");
const filtersButton = (page: Page) => page.locator(".wn-toolbar").getByRole("button", { name: /^(Filtres|Filters)/ });
/** Ouvre le panneau Filtres s'il est fermé (les vues y vivent). */
async function openFilters(page: Page) {
  if (await page.locator(".wn-filters-panel").count() === 0) await filtersButton(page).click();
  await expect(page.locator(".wn-filters-panel")).toBeVisible();
}

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const blocking = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.help}`), `violations serious/critical [${label}]`).toEqual([]);
}

test("filtre de département, enregistrement, rechargement, axe ; plus de ligne des vues hors du panneau", async ({ page }) => {
  await openDemo(page);
  await expect(people(page)).toHaveText("300 personnes");
  await expect(page.locator(".wn-views-row")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Vue" })).toHaveCount(0); // panneau fermé

  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Vue" })).toHaveValue("");
  await page.getByLabel("Département", { exact: true }).selectOption({ label: "Design" });
  await expect(people(page)).toHaveText("100 personnes");
  await expect(filtersButton(page)).toHaveText("Filtres (1)");
  // Les lignes affichées sont bien celles du département Design (personnes 2, 5, 8... : n modulo 3 = 2).
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[role="rowheader"] .wn-person-name')].map((e) => e.textContent).filter(Boolean).slice(0, 3))).toEqual(["Personne 2", "Personne 5", "Personne 8"]);
  await axe(page, "filtre ouvert");

  await page.locator(".wn-views-actions").getByRole("button", { name: "Enregistrer la vue…" }).click();
  await page.getByLabel("Nom de la vue").fill("Équipe Design");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vue « Équipe Design » enregistrée." })).toBeAttached();
  await expect(filtersButton(page)).toHaveText("Filtres (1) · Équipe Design");
  await expect(page).toHaveURL(/[?&]view=demo-view-\d+/);
  await axe(page, "vue enregistrée");

  await page.reload();
  await page.getByRole("grid").waitFor();
  await expect(filtersButton(page)).toHaveText("Filtres (1) · Équipe Design"); // nom lisible sans ouvrir le panneau
  await expect(people(page)).toHaveText("100 personnes");
  await openFilters(page);
  await expect(page.getByRole("combobox", { name: "Vue" }).locator("option:checked")).toHaveText("Équipe Design");
  await page.getByLabel("Département", { exact: true }).selectOption(["Design", "Produit"]);
  await expect(filtersButton(page)).toHaveText(/^Filtres \(1\) · Équipe Design ● \(vue modifiée\)$/);

  await page.getByRole("combobox", { name: "Vue" }).selectOption({ label: "Tout le monde" });
  await expect(people(page)).toHaveText("300 personnes");
  await expect(page).not.toHaveURL(/view=/);
});

test("vue d'exemple en anglais : choisie dans le panneau, appliquée, zoom restauré", async ({ page }) => {
  await openDemo(page, "en");
  await openFilters(page);
  await page.getByRole("combobox", { name: "View" }).selectOption({ label: "Projet A" });
  await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: /View “Projet A” applied/ })).toBeAttached();
  await expect(filtersButton(page)).toHaveText("Filters (1) · Projet A");
});
