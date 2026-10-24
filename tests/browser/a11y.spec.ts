// axe-core sur l'écran : aucune violation serious / critical ; les autres sont listées (sortie + JSON dans out/).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDemo, settle } from "./helpers";

const out = fileURLToPath(new URL("./out/", import.meta.url));

async function scan(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const lines = r.violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length} nœuds) : ${v.help} -> ${v.nodes[0]?.target.join(" ")}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}axe-${label}.json`, JSON.stringify(r.violations, null, 1));
  if (lines.length) console.log(`axe [${label}]\n  ${lines.join("\n  ")}`);
  const blocking = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.help}`), `violations serious/critical [${label}]`).toEqual([]);
}

test.describe("axe-core", () => {
  test("FR, zoom jour", async ({ page }) => {
    await openDemo(page);
    await scan(page, "fr-jour");
  });
  test("boutons survolés (primaire, secondaire) : contraste AA, le survol fonce le fond au lieu de l'éclaircir", async ({ page }) => {
    await openDemo(page);
    // « + Allocation » a disparu (RT-060) : le bouton primaire est celui de la section Réglages > Import (RT-054).
    for (const [path, name] of [["/reglages?demo=1&onglet=import", "Importer un fichier CSV…"], ["/?demo=1", "Aujourd’hui"]] as const) {
      await page.goto(path);
      const button = page.getByRole("button", { name, exact: true });
      await button.hover();
      await page.waitForTimeout(200); // fin de la transition de couleur
      const r = await new AxeBuilder({ page }).include("main").withRules(["color-contrast"]).analyze();
      expect(r.violations.flatMap((v) => v.nodes.map((n) => n.any[0]?.message ?? "")), `survol de « ${name} »`).toEqual([]);
    }
  });
  test("FR, zoom semaine", async ({ page }) => {
    await openDemo(page);
    await page.getByRole("button", { name: "Semaine", exact: true }).click();
    await settle(page);
    await scan(page, "fr-semaine");
  });
  test("FR, après défilement", async ({ page }) => {
    await openDemo(page);
    await page.mouse.move(800, 400);
    await page.mouse.wheel(3000, 0);
    await page.mouse.wheel(0, 1500);
    await settle(page);
    await scan(page, "fr-defile");
  });
  // La saisie rapide est retirée (RT-057) : son scan est remplacé par celui du panneau Filtres, qui porte désormais les vues (RT-058).
  test("FR, panneau Filtres ouvert (vues en tête, enregistrement en pied)", async ({ page }) => {
    await openDemo(page);
    await page.locator(".wn-toolbar").getByRole("button", { name: /^Filtres/ }).click();
    await expect(page.locator(".wn-filters-panel .wn-views-pick select")).toBeVisible();
    await scan(page, "fr-filtres");
  });
  test("FR, menu contextuel d'un bloc ouvert (commandes RT-047 et retrait BR-10)", async ({ page }) => {
    await openDemo(page);
    await page.locator(".wn-block[data-key]").first().click({ button: "right" });
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    // Les gardes de focus de Base UI (span aria-hidden focalisables autour du portail) sont un mécanisme du menu, pas du contenu.
    const r = await new AxeBuilder({ page }).include('[role="menu"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
    expect(r.violations.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
  });
});
