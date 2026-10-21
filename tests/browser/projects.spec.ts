// Écran Projets (lot L-F1 : RT-010, RT-012 Projets, RT-018, US-2.1) dans un vrai navigateur, démo ?demo=1 : création d'un projet avec client
// à la volée et couleur, code dupliqué refusé, fiche dans le Drawer commun (PO-03), changement de couleur répercuté sur les blocs du Planning, axe-core.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

async function noViolations(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.target.join(" ")}`), `axe [${label}]`).toEqual([]);
}

const rgbOf = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const nav = (page: Page) => page.getByRole("banner").getByRole("navigation", { name: "Navigation principale" });

async function openProjects(page: Page) {
  await openDemo(page);
  await nav(page).getByRole("link", { name: "Projets" }).click();
  await expect(page.getByRole("table")).toBeVisible();
}

test("liste, création avec client à la volée, code dupliqué refusé", async ({ page }) => {
  await openProjects(page);
  await expect(page.getByRole("heading", { level: 1, name: "Projets" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(7); // en-tête + 6 projets de la démo
  await noViolations(page, "projets-liste");

  await page.getByRole("button", { name: "Nouveau projet" }).click();
  const panel = page.getByRole("dialog", { name: "Nouveau projet" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2, name: "Nouveau projet" })).toBeVisible();
  await expect(panel.getByLabel("Nom du projet")).toBeFocused(); // le Drawer commun donne le focus au premier champ
  await panel.getByLabel("Nom du projet").fill("Portail RH");
  await panel.getByLabel("Client").selectOption({ label: "Nouveau client…" });
  await panel.getByLabel("Nom du nouveau client").fill("Initech");
  await panel.getByLabel("Code projet").fill("RH-1");
  await panel.getByRole("radio", { name: /^Couleur #/ }).nth(4).click();
  await noViolations(page, "projets-formulaire");
  await panel.getByRole("button", { name: "Créer le projet" }).click();

  // Le projet apparaît dans la liste, son panneau s'ouvre (client créé, code et couleur conservés).
  await expect(page.getByRole("row", { name: /Portail RH/ })).toContainText("Initech");
  await expect(page.getByRole("row", { name: /Portail RH/ })).toContainText("RH-1");
  const detail = page.getByRole("dialog", { name: "Portail RH" });
  await expect(detail.getByLabel("Code projet")).toHaveValue("RH-1");
  await expect(detail.getByLabel("Client")).toHaveValue(/.+/);
  await detail.getByRole("button", { name: "Fermer" }).click();
  await expect(page.getByRole("dialog", { name: "Portail RH" })).toHaveCount(0);

  // Code déjà utilisé : refusé avec un message clair, rien n'est créé.
  await page.getByRole("button", { name: "Nouveau projet" }).click();
  const again = page.getByRole("dialog", { name: "Nouveau projet" });
  await again.getByLabel("Nom du projet").fill("Doublon");
  await again.getByLabel("Code projet").fill("RH-1");
  await again.getByRole("button", { name: "Créer le projet" }).click();
  await expect(again.getByText("Ce code est déjà utilisé par un autre projet.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Doublon/ })).toHaveCount(0);

  // Dates incohérentes.
  await again.getByLabel("Code projet").fill("RH-2");
  await again.getByLabel("Début").fill("2026-06-10");
  await again.getByLabel("Fin").fill("2026-06-01");
  await again.getByRole("button", { name: "Créer le projet" }).click();
  await expect(again.getByText("La fin ne peut pas précéder le début.")).toBeVisible();
  await noViolations(page, "projets-formulaire-erreurs");
});

test("panneau : changer la couleur d'un projet la répercute sur ses blocs du Planning", async ({ page }) => {
  await openProjects(page);
  await page.getByRole("button", { name: "Projet A", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Projet A" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2, name: "Projet A" })).toBeVisible();
  await expect(panel.getByLabel("Nom du projet")).toBeFocused();
  await expect(panel.getByRole("heading", { level: 3, name: "Équipe" })).toBeVisible();
  await expect(panel.getByRole("heading", { level: 3, name: "Tâches" })).toBeVisible();

  // Tâche : ajout puis renommage.
  await panel.getByLabel("Nom de la nouvelle tâche").fill("Maquettes");
  await panel.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(panel.getByText("Maquettes", { exact: true })).toBeVisible();
  await noViolations(page, "projets-panneau");

  const swatch = panel.getByRole("radio", { name: /^Couleur #/ }).nth(9);
  const hex = (await swatch.getAttribute("aria-label"))!.replace("Couleur ", "");
  await swatch.click();
  await panel.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(panel.getByText("Modifications enregistrées.")).toBeVisible();
  await page.keyboard.press("Escape"); // le Drawer est modal : il se ferme avant de changer de page
  await expect(panel).toHaveCount(0);

  await nav(page).getByRole("link", { name: "Planning" }).click();
  await page.getByRole("grid").waitFor();
  await page.getByRole("rowheader").first().waitFor();
  const expected = rgbOf(hex);
  await expect.poll(() => page.evaluate((rgb) => [...document.querySelectorAll<HTMLElement>(".wn-block")].filter((b) => getComputedStyle(b).backgroundColor === rgb).length, expected)).toBeGreaterThan(0);
});

test("la fiche est un Drawer : Échap ferme, le focus revient au projet ; EN traduit", async ({ page }) => {
  await page.goto("/projets?demo=1&lang=en");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  const opener = page.getByRole("button", { name: "Projet B", exact: true });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "Projet B" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Projet B" })).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByRole("button", { name: "New project" })).toBeVisible();
});
