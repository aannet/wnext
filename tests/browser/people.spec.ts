// Écrans Personnes et Réglages (lot L-F2 : RT-012, US-1.1, BR-19, BR-31) dans un vrai navigateur, démo ?demo=1 : création d'une personne
// en trois champs (visible dans la liste puis dans le Planning), horaire modifié « à partir du » (fiche et historique à jour),
// équipe créée dans Réglages puis affectée à la personne, désactivation avec récapitulatif, axe-core sur chaque écran et fiche.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

async function noViolations(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.target.join(" ")}`), `axe [${label}]`).toEqual([]);
}

const nav = (page: Page) => page.getByRole("banner").getByRole("navigation", { name: "Navigation principale" });
const settingsLink = (page: Page) => page.getByRole("banner").getByRole("link", { name: "Réglages" });

test("création en trois champs : la personne est dans la liste, puis dans le Planning", async ({ page }) => {
  await openDemo(page);
  await nav(page).getByRole("link", { name: "Personnes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Personnes" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("button", { name: "Importer" })).toBeVisible(); // owner : import CSV
  await noViolations(page, "personnes-liste");

  await page.getByRole("button", { name: "Nouvelle personne" }).click();
  const drawer = page.getByRole("dialog", { name: "Nouvelle personne" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("Nom", { exact: true })).toBeFocused();
  await expect(drawer.getByLabel("lundi")).toHaveValue("8"); // horaire par défaut du compte
  await noViolations(page, "personnes-creation");
  await drawer.getByRole("button", { name: "Créer la personne" }).click();
  await expect(drawer.getByText("Le nom est obligatoire.")).toBeVisible();
  await drawer.getByLabel("Nom", { exact: true }).fill("Ada Lovelace");
  await drawer.getByLabel("Type", { exact: true }).selectOption("contractor");
  await drawer.getByRole("button", { name: "Créer la personne" }).click();

  // La fiche s'ouvre sur la personne créée ; Échap la ferme et la liste la montre.
  const fiche = page.getByRole("dialog", { name: "Ada Lovelace" });
  await expect(fiche).toBeVisible();
  await noViolations(page, "personnes-fiche");
  await page.keyboard.press("Escape");
  await expect(fiche).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Ada Lovelace/ })).toContainText("Prestataire");
  await expect(page.getByRole("row", { name: /Ada Lovelace/ })).toContainText("40 h par semaine, 5 jours");

  await nav(page).getByRole("link", { name: "Planning" }).click();
  await page.getByRole("grid").waitFor();
  await expect(page.getByRole("rowheader", { name: /Ada Lovelace/ })).toBeVisible();
});

test("horaire modifié à partir d'une date : la fiche et l'historique sont à jour ; refus de saisie hors 0-24", async ({ page }) => {
  await page.goto("/personnes?demo=1&lang=fr");
  await page.getByRole("button", { name: /^(?:\w{2})?Personne 3\b/ }).first().click();
  const fiche = page.getByRole("dialog", { name: "Personne 3" });
  await expect(fiche).toBeVisible();
  await expect(fiche.getByRole("heading", { level: 3, name: "Historique de l’horaire" })).toBeVisible();
  await expect(fiche.locator(".wn-history li")).toHaveCount(1);

  await expect(fiche.getByLabel("À partir du")).toHaveCount(0);
  await fiche.getByLabel("vendredi").fill("0");
  await expect(fiche.getByLabel("À partir du")).toBeVisible();
  await expect(fiche.getByText("Total : 32 h par semaine sur 4 jours")).toBeVisible();
  await fiche.getByLabel("À partir du").fill("2030-01-07");
  await fiche.getByRole("button", { name: "Enregistrer" }).click();
  await expect(fiche.getByText("Modifications enregistrées.")).toBeVisible();
  await expect(fiche.locator(".wn-history li")).toHaveCount(2);
  await expect(fiche.locator(".wn-history li").nth(1)).toContainText("Depuis le 7 janv. 2030");
  await expect(fiche.locator(".wn-history li").nth(1)).toContainText("32 h par semaine");
  await noViolations(page, "personnes-fiche-historique");

  await fiche.getByLabel("lundi").fill("30");
  await fiche.getByRole("button", { name: "Enregistrer" }).click();
  await expect(fiche.getByText("un nombre d’heures entre 0 et 24")).toBeVisible();
});

test("Réglages : une équipe créée est proposée dans la fiche de la personne et l'affecte", async ({ page }) => {
  await page.goto("/reglages?demo=1&lang=fr");
  await expect(page.getByRole("heading", { level: 1, name: "Réglages" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Équipes" })).toHaveAttribute("aria-selected", "true");
  await noViolations(page, "reglages-equipes");
  await page.getByLabel("Nouvelle équipe").fill("Données");
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.getByRole("list").getByText("Données", { exact: true })).toBeVisible();

  for (const tab of ["Rôles", "Clients", "Types de congé", "Jours fériés", "Compte"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await noViolations(page, `reglages-${tab}`);
  }
  await page.getByRole("tab", { name: "Jours fériés" }).click();
  await page.getByLabel("Nom", { exact: true }).fill("Fermeture d’été");
  await page.getByLabel("Date", { exact: true }).fill("2030-08-15");
  await page.getByLabel("Pays (code à 2 lettres)").fill("fr");
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.locator(".wn-row-name", { hasText: "Fermeture d’été" })).toBeVisible();

  // Navigation interne (le rechargement réinitialiserait la démo en mémoire).
  await nav(page).getByRole("link", { name: "Personnes" }).click();
  await page.getByRole("button", { name: /^(?:\w{2})?Personne 1\b/ }).first().click();
  const fiche = page.getByRole("dialog", { name: "Personne 1" });
  await fiche.getByLabel("Équipe", { exact: true }).selectOption({ label: "Données" });
  await expect(fiche.getByLabel("À partir du")).toBeVisible(); // l'équipe est une modification datée (BR-19)
  await fiche.getByRole("button", { name: "Enregistrer" }).click();
  await expect(fiche.getByText("Modifications enregistrées.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("row", { name: /Personne 1 / }).first()).toContainText("Données");

  // Le filtre « Équipe » connaît la nouvelle équipe.
  await page.getByLabel("Équipe", { exact: true }).selectOption({ label: "Données" });
  await expect(page.getByRole("row")).toHaveCount(2);
});

test("désactivation : récapitulatif, choix de réaffectation, la personne quitte le Planning", async ({ page }) => {
  await page.goto("/personnes?demo=1&lang=fr");
  await page.getByRole("button", { name: /^(?:\w{2})?Personne 2\b/ }).first().click();
  const fiche = page.getByRole("dialog", { name: "Personne 2" });
  await fiche.getByRole("button", { name: "Désactiver cette personne" }).click();
  const dialog = page.getByRole("dialog", { name: "Désactiver Personne 2" });
  await expect(dialog.getByText(/allocations? à venir sur \d+ projets?/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Désactiver", exact: true })).toBeDisabled();
  await noViolations(page, "personnes-desactivation");
  await dialog.getByRole("radio", { name: "Les réaffecter à une autre personne" }).check();
  await dialog.getByLabel("Réaffecter à", { exact: true }).selectOption({ label: "Personne 4" });
  await dialog.getByRole("button", { name: "Désactiver", exact: true }).click();
  await expect(fiche.getByText("Personne désactivée.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^(?:\w{2})?Personne 2\b/ })).toHaveCount(0);
  await page.getByLabel("État").selectOption("inactive");
  await expect(page.getByRole("row", { name: /Personne 2/ })).toContainText("Désactivée");

  // Comme l'API, le Planning n'expose plus la personne désactivée (ses allocations sont chez Personne 4).
  await nav(page).getByRole("link", { name: "Planning" }).click();
  await page.getByRole("grid").waitFor();
  await page.getByRole("rowheader").first().waitFor();
  await expect(page.getByRole("rowheader", { name: /Personne 4\b/ })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: /Personne 2\b/ })).toHaveCount(0);
});

test("EN : écrans traduits", async ({ page }) => {
  await page.goto("/personnes?demo=1&lang=en");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New person" })).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("tab", { name: "Teams" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Holidays" })).toBeVisible();
});

test("tri des colonnes et regroupement par équipe (RT-031), axe propre", async ({ page }) => {
  await page.goto("/personnes?demo=1&lang=fr");
  const name = page.getByRole("columnheader", { name: "Nom" });
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await page.getByRole("switch", { name: "Regrouper par équipe" }).click();
  await expect(page.getByRole("rowheader", { name: /^Design \(\d+\)$/ })).toBeVisible();
  await expect(page.locator("tbody")).toHaveCount(3);
  await noViolations(page, "personnes-groupees");
});
