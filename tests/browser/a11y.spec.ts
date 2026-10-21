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
    for (const name of ["+ Allocation", "Aujourd’hui"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.hover();
      await page.waitForTimeout(200); // fin de la transition de couleur
      const r = await new AxeBuilder({ page }).include("[role=toolbar], .wn-subheader").withRules(["color-contrast"]).analyze();
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
  test("FR, saisie rapide avec liste de candidats ouverte", async ({ page }) => {
    await openDemo(page);
    await page.getByRole("grid").focus();
    await page.keyboard.press("/");
    await page.getByRole("combobox", { name: "Allocation en langage simple" }).fill("Projet 4h lun");
    await expect(page.getByRole("listbox")).toBeVisible();
    await scan(page, "fr-saisie-rapide");
  });
});
