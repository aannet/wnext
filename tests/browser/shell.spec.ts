// Coque applicative (lot L-B, RT-001 à RT-003) dans un vrai navigateur, démo ?demo=1 : en-tête WNEXT, navigation Planning / Projets
// (adresse et retour), « Bonjour » à droite, sous-header de l'écran, axe-core sans violation sur les pages.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

async function noViolations(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.target.join(" ")}`), `axe [${label}]`).toEqual([]);
}

test("en-tête WNEXT, « Bonjour », navigation Planning -> Projets -> Planning avec l'adresse", async ({ page }) => {
  await openDemo(page);
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "WNEXT", exact: true })).toBeVisible();
  await expect(header.getByText("Bonjour Alec")).toBeVisible();
  const nav = header.getByRole("navigation", { name: "Navigation principale" });
  await expect(nav.getByRole("link")).toHaveText(["Planning", "Projets", "Personnes"]);
  await expect(header.getByRole("link", { name: "Réglages" })).toBeVisible(); // hors navigation principale
  await expect(nav.getByRole("link", { name: "Réglages" })).toHaveCount(0);

  // Sous-header : titre + barre d'outils côte à côte, sous l'en-tête.
  const title = page.getByRole("heading", { level: 1, name: "Planning" });
  const toolbar = page.getByRole("toolbar");
  const [h, t, b] = await Promise.all([header.boundingBox(), title.boundingBox(), toolbar.boundingBox()]);
  expect(t!.y).toBeGreaterThanOrEqual(h!.y + h!.height);
  expect(Math.abs((t!.y + t!.height / 2) - (b!.y + b!.height / 2))).toBeLessThan(40);
  await noViolations(page, "planning");

  await nav.getByRole("link", { name: "Projets" }).click();
  await expect(page).toHaveURL(/\/projets\?demo=1/);
  await expect(page.getByRole("heading", { level: 1, name: "Projets" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible(); // écran Projets (lot L-F1) ; Personnes reste « Bientôt disponible »
  await expect(nav.getByRole("link", { name: "Projets" })).toHaveAttribute("aria-current", "page");
  await expect(header.getByText("Bonjour Alec")).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await noViolations(page, "projets");

  await nav.getByRole("link", { name: "Planning" }).click();
  await expect(page).toHaveURL(/\/\?demo=1/);
  await page.getByRole("grid").waitFor();
  await page.getByRole("rowheader").first().waitFor();

  // Précédent / suivant du navigateur.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Projets" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("grid")).toBeVisible();
});

test("adresse directe /personnes?demo=1, Réglages, rechargement : la page reste", async ({ page }) => {
  await page.goto("/personnes?demo=1&lang=fr");
  await expect(page.getByRole("heading", { level: 1, name: "Personnes" })).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "Réglages" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Réglages" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Réglages" })).toBeVisible();
  await noViolations(page, "reglages");
});

test("EN : en-tête traduit", async ({ page }) => {
  await openDemo(page, "en");
  await expect(page.getByRole("banner").getByText("Hello Alec")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link")).toHaveText(["Schedule", "Projects", "People"]);
});
