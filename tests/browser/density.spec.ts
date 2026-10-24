// Densité d'affichage et jauge par personne dans un vrai navigateur (démo ?demo=1, écran de référence 1920 × 1080 ;
// RT-005 à RT-008) : les trois densités montrent ~13 / ~9 / ~7 lignes entières (une de plus depuis l'en-tête sur une ligne), la jauge et son pourcentage sont dans la
// colonne de gauche (▲ pour une personne en dépassement), la densité (menu Affichage) est gardée au rechargement et appliquée par une vue
// sauvegardée, et l'écran reste sans violation axe serious / critical.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo, settle, visibleHeaders } from "./helpers";

test.use({ viewport: { width: 1920, height: 1080 } });

/** Bouton radio de densité, dans le menu Affichage (RT-025) : le menu est ouvert s'il ne l'est pas. */
async function radio(page: Page, name: string) {
  const menu = page.getByRole("dialog", { name: "Affichage" });
  if (!(await menu.isVisible())) await page.getByRole("button", { name: "Affichage", exact: true }).click();
  return menu.getByRole("radiogroup", { name: "Densité" }).getByRole("radio", { name, exact: true });
}

/** Panneau Filtres ouvert (les vues y vivent, RT-058). */
async function openFilters(page: Page) {
  if (await page.locator(".wn-filters-panel").count() === 0) await page.locator(".wn-toolbar").getByRole("button", { name: /^Filtres/ }).click();
  await expect(page.locator(".wn-filters-panel")).toBeVisible();
}

/** Lignes de personnes entièrement visibles sous l'en-tête de dates (32 px), et hauteur de cette zone. */
const fullRows = (page: Page) => page.evaluate(() => {
  const grid = document.querySelector<HTMLElement>('[role="grid"]')!;
  const g = grid.getBoundingClientRect();
  const top = g.top + 32;
  const bottom = g.top + grid.clientHeight;
  const rows = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((e) => e.style.display !== "none").map((e) => e.getBoundingClientRect());
  return { count: rows.filter((r) => r.height > 0 && r.top >= top - 0.5 && r.bottom <= bottom + 1.5).length, zone: Math.round(bottom - top) };
});

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const blocking = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.help}`), `violations serious/critical [${label}]`).toEqual([]);
}

test("trois densités : ~13 / ~9 / ~7 lignes visibles à 1920 × 1080, tailles qui grossissent, axe", async ({ page }) => {
  await openDemo(page);
  await expect(await radio(page, "Standard")).toHaveAttribute("aria-checked", "true");
  const measured: Record<string, number> = {};
  let lastName = 0;
  let lastBlock = 0;
  // Une ligne de plus à chaque densité depuis la recette n°4 (une seule ligne au-dessus de la grille au lieu de trois, ~90 px
  // rendus à la grille) ; la tolérance d'une ligne en moins garde les anciens planchers (12, 8, 6).
  for (const [name, expected] of [["Compacte", 13], ["Standard", 9], ["Aérée", 7]] as const) {
    await (await radio(page, name)).click();
    await expect(await radio(page, name)).toHaveAttribute("aria-checked", "true");
    const { count, zone } = await fullRows(page);
    measured[name] = count;
    // Une ligne de la démo peut porter des blocs empilés (plus haute) : une ligne de moins est tolérée.
    expect(count, `${name} (zone de ${zone} px)`).toBeGreaterThanOrEqual(expected - 1);
    expect(count, `${name} (zone de ${zone} px)`).toBeLessThanOrEqual(expected);
    // RT-006, RT-050 : le nom et le texte des blocs grossissent à chaque niveau, pas seulement la hauteur de ligne
    // (strictement : les tailles posées sur la grille elle-même écrasaient celles de la densité).
    const size = await page.locator(".wn-person-name").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    const block = await page.locator(".wn-block[data-key]").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(size, `nom en ${name}`).toBeGreaterThan(lastName);
    expect(block, `bloc en ${name}`).toBeGreaterThan(lastBlock);
    lastName = size;
    lastBlock = block;
  }
  expect(measured["Compacte"]! > measured["Standard"]! && measured["Standard"]! > measured["Aérée"]!).toBe(true);
  await axe(page, "densité aérée");
});

test("jauge par personne : barre et pourcentage, ▲ et +N h en dépassement, infobulle de la période visible", async ({ page }) => {
  await openDemo(page);
  const gauges = page.locator(".wn-rowheader .wn-gauge");
  await expect(gauges.first()).toBeVisible();
  await expect(gauges.first().locator(".wn-gauge-value")).toHaveText(/^\d+\s%$|^▲/);
  await expect(gauges.first()).toHaveAttribute("title", /^Du .+ au .+ : [\d,]+ h planifiées sur [\d,]+ h de capacité$/);
  const over = page.locator(".wn-rowheader .wn-gauge-over").first();
  await expect(over).toBeVisible();
  await expect(over.locator(".wn-gauge-value")).toHaveText(/^▲ .*\+[\d,]+ h$/);
  // Changement de zoom : la période visible s'allonge, l'infobulle suit.
  const before = await gauges.first().getAttribute("title");
  await page.getByRole("button", { name: "Mois", exact: true }).click();
  await expect.poll(() => gauges.first().getAttribute("title")).not.toBe(before);
  await axe(page, "jauges");
});

test("densité gardée au rechargement et appliquée par une vue sauvegardée", async ({ page }) => {
  await openDemo(page);
  await (await radio(page, "Aérée")).click();
  // Les vues sont dans le panneau Filtres (RT-058) : « Enregistrer la vue… » en pied, « Vue » en tête.
  await page.keyboard.press("Escape"); // ferme le menu Affichage
  await openFilters(page);
  await page.getByRole("button", { name: "Enregistrer la vue…" }).click();
  await page.getByLabel("Nom de la vue").fill("Revue aérée");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vue « Revue aérée » enregistrée." })).toBeAttached();

  await (await radio(page, "Compacte")).click();
  await page.reload();
  await page.getByRole("rowheader").first().waitFor();
  // L'URL porte la vue (?view=) : appliquée au chargement, elle remet la densité aérée par-dessus la mémoire locale.
  await expect(await radio(page, "Aérée")).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Escape");
  await openFilters(page);
  await page.getByRole("combobox", { name: "Vue" }).selectOption({ label: "Tout le monde" });
  await (await radio(page, "Compacte")).click();
  await page.goto("/?demo=1&lang=fr");
  await page.getByRole("rowheader").first().waitFor();
  await expect(await radio(page, "Compacte")).toHaveAttribute("aria-checked", "true"); // mémoire locale seule
  await page.keyboard.press("Escape");
  await openFilters(page);
  await page.getByRole("combobox", { name: "Vue" }).selectOption({ label: "Revue aérée" });
  await expect(await radio(page, "Aérée")).toHaveAttribute("aria-checked", "true");
});

test("PO-02 : quitter le Planning puis revenir garde zoom, position et densité (blocs affichés)", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  await (await radio(page, "Aérée")).click();
  await page.getByRole("button", { name: "Période suivante" }).click();
  await settle(page);
  await page.getByRole("grid").evaluate((g) => { g.scrollTop = 900; });
  await settle(page);
  const before = { headers: await visibleHeaders(page), top: await page.getByRole("grid").evaluate((g) => g.scrollTop) };
  const shown = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".wn-block")].filter((b) => b.style.display !== "none").length);
  expect(await shown()).toBeGreaterThan(0);

  const nav = page.getByRole("navigation", { name: "Navigation principale" });
  await nav.getByRole("link", { name: "Projets" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await nav.getByRole("link", { name: "Planning" }).click();
  await page.getByRole("rowheader").first().waitFor();
  await settle(page);

  await expect(page.getByRole("button", { name: "Semaine", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(await radio(page, "Aérée")).toHaveAttribute("aria-checked", "true");
  expect(await visibleHeaders(page)).toEqual(before.headers);
  expect(await page.getByRole("grid").evaluate((g) => g.scrollTop)).toBe(before.top);
  await expect.poll(shown).toBeGreaterThan(0);
});
