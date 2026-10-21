// Vues sauvegardées dans un vrai navigateur (démo ?demo=1 : vues en mémoire doublées dans localStorage) : un filtre réduit
// les lignes, la vue s'enregistre, se retrouve après rechargement (?view=<id>), et l'écran reste sans violation axe serious / critical.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

const people = (page: Page) => page.locator("[role=toolbar]").getByText(/\d+ personnes?/);

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const blocking = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.help}`), `violations serious/critical [${label}]`).toEqual([]);
}

test("filtre de département, enregistrement, rechargement, axe", async ({ page }) => {
  await openDemo(page);
  await expect(people(page)).toHaveText("300 personnes");
  await expect(page.getByRole("combobox", { name: "Vue" })).toHaveValue("");

  await page.getByText("Filtres", { exact: true }).click();
  await page.getByLabel("Département", { exact: true }).selectOption({ label: "Design" });
  await expect(people(page)).toHaveText("100 personnes");
  await expect(page.getByText("Filtres (1)")).toBeVisible();
  // Les lignes affichées sont bien celles du département Design (personnes 2, 5, 8... : n modulo 3 = 2).
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[role="rowheader"] .wn-person-name')].map((e) => e.textContent).filter(Boolean).slice(0, 3))).toEqual(["Personne 2", "Personne 5", "Personne 8"]);
  await axe(page, "filtre ouvert");

  await page.getByRole("button", { name: "Enregistrer la vue…" }).click();
  await page.getByLabel("Nom de la vue").fill("Équipe Design");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vue « Équipe Design » enregistrée." })).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=demo-view-\d+/);
  await axe(page, "vue enregistrée");

  await page.reload();
  await page.getByRole("grid").waitFor();
  await expect(page.getByRole("combobox", { name: "Vue" })).toContainText("Équipe Design");
  await expect(page.getByRole("combobox", { name: "Vue" }).locator("option:checked")).toHaveText("Équipe Design");
  await expect(people(page)).toHaveText("100 personnes");

  await page.getByRole("combobox", { name: "Vue" }).selectOption({ label: "Tout le monde" });
  await expect(people(page)).toHaveText("300 personnes");
  await expect(page).not.toHaveURL(/view=/);
});

test("vue d'exemple partagée en anglais : choisie, appliquée, zoom restauré", async ({ page }) => {
  await openDemo(page, "en");
  await page.getByRole("combobox", { name: "View" }).selectOption({ label: "Projet A" });
  await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: /View “Projet A” applied/ })).toBeVisible();
});
