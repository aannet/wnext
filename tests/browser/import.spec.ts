// Import CSV simple (US-1.2) dans un vrai navigateur (démo ?demo=1, import local avec le moteur partagé) : fichier de 3 lignes
// dont 1 en erreur -> aperçu (compteurs, tableau d'erreurs par ligne) -> import des 2 lignes valides (jamais implicite) ->
// résultat ; ré-analyse du même fichier : plus rien à créer (idempotent).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemo } from "./helpers";

const CSV = "Nom;E-mail;Département;Heures/jour\r\nAlice Martin;alice@exemple.fr;Studio;7,5\r\nBruno;pas-un-mail;;8\r\nChloé;chloe@exemple.fr;Studio;\r\n";

test("3 lignes dont 1 en erreur : rapport, import des 2 valides, ré-import sans création", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Importer" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("Importer un fichier CSV");
  await dialog.getByLabel("Fichier CSV").setInputFiles({ name: "personnes.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
  await dialog.getByRole("button", { name: "Analyser" }).click();

  await expect(dialog.getByRole("heading", { level: 3 })).toHaveText("Aperçu : rien n’est encore importé");
  await expect(dialog.locator(".wn-import-counters li")).toHaveText(["3 lignes lues", "2 créations", "0 mise à jour", "0 ligne inchangée", "1 ligne en erreur"]);
  await expect(dialog.getByText("Départements créés : Studio")).toBeVisible();
  const rows = dialog.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("td")).toHaveText(["3", "email", "E-mail invalide", "pas-un-mail"]);
  await expect(dialog.getByRole("button", { name: "Importer", exact: true })).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).include(".wn-import-dialog").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  await dialog.getByRole("button", { name: "Importer les 2 lignes valides" }).click();
  await expect(dialog.getByRole("heading", { level: 3 })).toHaveText("Import terminé");
  await expect(dialog.locator(".wn-import-counters li").nth(1)).toHaveText("2 créations");

  // Ré-import : les 2 lignes déjà importées sont inchangées, seule l'erreur reste.
  await dialog.getByRole("button", { name: "Fermer", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Importer" })).toBeFocused();
  await page.getByRole("button", { name: "Importer" }).click();
  await dialog.getByLabel("Fichier CSV").setInputFiles({ name: "personnes.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
  await dialog.getByRole("button", { name: "Analyser" }).click();
  await expect(dialog.locator(".wn-import-counters li")).toHaveText(["3 lignes lues", "0 création", "0 mise à jour", "2 lignes inchangées", "1 ligne en erreur"]);
  await expect(dialog.getByText("Rien à importer : les lignes sont déjà à jour ou en erreur.")).toBeVisible();
});
