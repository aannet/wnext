// Réglages > Compte (RT-041, L-O3) dans un vrai navigateur, démo ?demo=1 : le formulaire du compte (owner), un seuil refusé avant
// envoi, le début de semaine enregistré puis vu dans l'en-tête du Planning (zoom semaine), axe-core sur le formulaire.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { settle, visibleHeaders } from "./helpers";

async function noViolations(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.target.join(" ")}`), `axe [${label}]`).toEqual([]);
}

const nav = (page: Page) => page.getByRole("banner").getByRole("navigation", { name: "Navigation principale" });
/** Jour ISO (1 = lundi ... 7 = dimanche) d'une date AAAA-MM-JJ. */
const isoDay = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

async function weekHeaderDays(page: Page): Promise<number[]> {
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  await expect(page.getByRole("button", { name: "Semaine", exact: true })).toHaveAttribute("aria-pressed", "true");
  await settle(page);
  const seen = await visibleHeaders(page);
  expect(seen.length).toBeGreaterThan(2);
  return [...new Set(seen.map((h) => isoDay(h.from)))];
}

test("Compte : début de semaine enregistré, l'en-tête du Planning commence ce jour-là", async ({ page }) => {
  await page.goto("/?demo=1&lang=fr");
  await page.getByRole("grid").waitFor();
  expect(await weekHeaderDays(page)).toEqual([1]); // lundi par défaut

  // Navigation interne (un rechargement réinitialiserait la démo en mémoire).
  await page.getByRole("banner").getByRole("link", { name: "Réglages" }).click();
  await page.getByRole("tab", { name: "Compte" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByLabel("Fuseau horaire")).toHaveValue("Europe/Paris");
  await expect(panel.getByLabel("Début de semaine")).toHaveValue("1");
  await expect(panel.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  await noViolations(page, "reglages-compte");

  // Seuil hors bornes : refusé avant tout envoi, message relié au champ.
  const threshold = panel.getByLabel("Seuil de sous-allocation (%)");
  await threshold.fill("150");
  await panel.getByRole("button", { name: "Enregistrer" }).click();
  await expect(panel.getByText("Saisissez un nombre entre 1 et 100.")).toBeVisible();
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  await noViolations(page, "reglages-compte-erreur");
  await threshold.fill("70");

  await panel.getByLabel("Début de semaine").selectOption({ label: "dimanche" });
  await panel.getByRole("button", { name: "Enregistrer" }).click();
  await expect(panel.getByText("Réglages du compte enregistrés.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Enregistrer" })).toBeDisabled();

  await nav(page).getByRole("link", { name: "Planning" }).click();
  await page.getByRole("grid").waitFor();
  expect(await weekHeaderDays(page)).toEqual([7]); // dimanche
});

test("Compte : le fuseau se choisit dans une liste avec recherche", async ({ page }) => {
  await page.goto("/reglages?demo=1&lang=fr");
  await page.getByRole("tab", { name: "Compte" }).click();
  const zone = page.getByRole("tabpanel").getByLabel("Fuseau horaire");
  await zone.selectText(); // la frappe remplace le fuseau affiché
  await zone.pressSequentially("new_y");
  await page.getByRole("option", { name: "America/New_York" }).click();
  await expect(zone).toHaveValue("America/New_York");
  await page.getByRole("tabpanel").getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("tabpanel").getByText("Réglages du compte enregistrés.")).toBeVisible();
  await expect(zone).toHaveValue("America/New_York");
});

// RT-054 (D9) : l'import n'a plus qu'une entrée, Réglages > Import (owner et admin) ; axe propre sur la section.
test("Import : dernier onglet des Réglages, bouton qui ouvre la boîte d'import ; axe-core", async ({ page }) => {
  await page.goto("/reglages?demo=1&lang=fr");
  const tabs = page.getByRole("tab");
  await expect(tabs.last()).toHaveText("Import");
  await tabs.last().click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Importer des données");
  await noViolations(page, "reglages-import");
  await panel.getByRole("button", { name: "Importer un fichier CSV…" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { level: 2 })).toHaveText("Importer un fichier CSV");
});

// PO-16 : sans ?lang=, la langue de l'écran est celle du compte (le navigateur de test est en anglais) ; la changer dans
// Réglages > Compte change aussitôt la langue de l'écran.
test("Compte : la langue par défaut du compte fixe celle de l'écran", async ({ page }) => {
  await page.goto("/reglages?demo=1");
  await expect(nav(page).getByRole("link", { name: "Planning" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.getByRole("tab", { name: "Compte" }).click();
  const panel = page.getByRole("tabpanel");
  await panel.getByLabel("Langue par défaut").selectOption("en");
  await panel.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("banner").getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Schedule" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("tab", { name: "Account" })).toBeVisible();
});
