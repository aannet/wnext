// Palette de recherche du Planning (RT-038, PO-09) dans un vrai navigateur, démo ?demo=1 (300 personnes « Personne N », projets
// « Projet A »…) : Ctrl+K, résultats groupés, personne lointaine amenée dans la vue et mise en évidence, projet ouvert dans
// l'écran Projets par /projets?projet=<id>, Échap rend le focus, mouvement réduit, axe-core.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

const palette = (page: Page) => page.getByRole("dialog", { name: "Rechercher" });
const field = (page: Page) => palette(page).getByRole("combobox", { name: "Rechercher une personne ou un projet" });
const rowOf = (page: Page, name: string) => page.locator(".wn-row[data-person]").filter({ has: page.getByText(name, { exact: true }) });

/** Ligne entièrement visible dans la fenêtre de la grille, sous l'en-tête de dates. */
const inView = (page: Page, name: string) => page.evaluate((n) => {
  const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  const head = document.querySelector('[role="columnheader"]')!.getBoundingClientRect();
  const el = [...document.querySelectorAll<HTMLElement>(".wn-row[data-person]")].find((r) => r.querySelector(".wn-person-name")?.textContent === n);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.top >= head.bottom - 1 && r.bottom <= grid.bottom + 1;
}, name);

test("le bouton « Rechercher » du niveau 1 affiche son raccourci et ouvre la palette", async ({ page }) => {
  await openDemo(page);
  const button = page.locator(".wn-subheader").getByRole("button", { name: /^Rechercher/ });
  await expect(button).toContainText(/Ctrl K|⌘K/);
  await button.click();
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
});

test("Ctrl+K, « per » : personnes groupées ; Entrée sur une personne lointaine : ligne visible, en évidence, focus à la grille", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  await expect(field(page)).toBeFocused();
  await field(page).fill("per");
  await expect(palette(page).getByRole("group", { name: "Personnes" })).toBeVisible();
  await expect(palette(page).getByRole("option")).toHaveCount(8);
  await field(page).fill("PERSONNE 250");
  await expect(palette(page).getByRole("option")).toHaveText(["Personne 250"]);
  await expect(rowOf(page, "Personne 250")).toHaveCount(0); // lointaine : pas encore dessinée
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  const row = rowOf(page, "Personne 250");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-highlight", "");
  await expect.poll(() => inView(page, "Personne 250")).toBe(true);
  await expect(page.getByRole("grid")).toBeFocused();
  await expect(page.locator(".wn-notice")).toContainText("Personne 250 : ligne affichée dans le planning");
  // La mise en évidence s'éteint seule.
  await expect(page.locator(".wn-row[data-highlight]")).toHaveCount(0, { timeout: 6000 });
});

test("mouvement réduit : la ligne est teintée sans animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDemo(page);
  await page.keyboard.press("Control+k");
  await field(page).fill("personne 120");
  await page.keyboard.press("Enter");
  const row = rowOf(page, "Personne 120");
  await expect(row).toHaveAttribute("data-highlight", "");
  expect(await row.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  expect(await row.evaluate((e) => getComputedStyle(e, "::after").boxShadow)).not.toBe("none");
});

test("projet : l'écran Projets s'ouvre sur sa fiche (/projets?projet=), l'adresse est ensuite nettoyée", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Control+k");
  await field(page).fill("projet c");
  await expect(palette(page).getByRole("group", { name: "Projets" })).toBeVisible();
  await page.keyboard.press("Enter");
  const fiche = page.getByRole("dialog").filter({ hasText: "Projet C" });
  await expect(fiche).toBeVisible();
  await expect(page).toHaveURL(/\/projets\?demo=1&lang=fr$/); // paramètre consommé, requête de la démo gardée
  await page.keyboard.press("Escape");
  await expect(fiche).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Projets" })).toBeVisible();
});

test("projet choisi au clic : même fiche ; adresse /projets?projet=<id> ouverte directement", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Control+k");
  await field(page).fill("projet b");
  await palette(page).getByRole("option", { name: "Projet B" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "Projet B" })).toBeVisible();

  await page.goto("/projets?demo=1&projet=2");
  await expect(page.getByRole("dialog").filter({ hasText: "Projet B" })).toBeVisible();
  await page.goto("/projets?demo=1&projet=inconnu");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Échap ferme la palette et rend le focus à l'endroit d'où elle est venue", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  await field(page).fill("zzz");
  await expect(palette(page)).toContainText("Aucun résultat");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByRole("grid")).toBeFocused();

  const button = page.locator(".wn-subheader").getByRole("button", { name: /^Rechercher/ });
  await button.click();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("Ctrl+K est ignoré quand une autre fenêtre modale est ouverte", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "+ Allocation" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(palette(page)).toHaveCount(0);
});

const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.target.join(" ")}`);
};

test("axe-core : palette ouverte, avec résultats groupés", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Control+k");
  await field(page).fill("p");
  await expect(palette(page).getByRole("group", { name: "Projets" })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test("personne masquée par un vrai filtre : option signalée, confirmation, zéro résultat (axe à chaque étape), retrait puis rétablissement", async ({ page }) => {
  await openDemo(page);
  // Filtre « Département : Produit » posé par le panneau : Personne 2 (département Design) est écartée.
  await page.getByRole("button", { name: "Filtres", exact: true }).click();
  await page.getByRole("group", { name: "Filtres" }).getByRole("listbox", { name: "Département" }).selectOption({ label: "Produit" });
  await expect(page.getByRole("button", { name: /^Filtres \(1\)/ })).toBeVisible();
  await expect(rowOf(page, "Personne 2")).toHaveCount(0);

  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  await field(page).fill("personne 2");
  const hidden = palette(page).getByRole("option", { name: /^Personne 2 masquée par les filtres/ });
  await expect(hidden).toBeVisible();
  await expect(field(page)).toHaveAttribute("aria-expanded", "true");
  expect(await axe(page), "axe, option masquée").toEqual([]);

  // Confirmation : rien n'a bougé, Échap revient à la liste, Entrée sur le bouton confirme.
  await page.keyboard.press("Enter");
  const confirm = palette(page).getByRole("button", { name: "Retirer les filtres et afficher Personne 2" });
  await expect(confirm).toBeFocused();
  await expect(page.locator(".wn-toolbar button", { hasText: /^Filtres \(1\)/ })).toBeVisible(); // la page derrière la fenêtre est masquée aux rôles : sélecteur CSS
  expect(await axe(page), "axe, confirmation").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();

  // Zéro résultat : plus de liste annoncée, message dans la région de statut.
  await field(page).fill("zzz");
  await expect(palette(page).getByRole("status")).toHaveText("Aucun résultat");
  await expect(field(page)).toHaveAttribute("aria-expanded", "false");
  await expect(palette(page).getByRole("listbox")).toHaveCount(0);
  expect(await axe(page), "axe, zéro résultat").toEqual([]);

  // Retrait confirmé : ligne montrée, filtres retirés, bouton « Rétablir les filtres ».
  await field(page).fill("personne 2");
  await page.keyboard.press("Enter");
  await confirm.click();
  await expect(palette(page)).toHaveCount(0);
  await expect(rowOf(page, "Personne 2")).toHaveAttribute("data-highlight", "");
  await expect(page.getByRole("button", { name: "Filtres", exact: true })).toBeVisible();
  const restore = page.getByRole("button", { name: "Rétablir les filtres" });
  await expect(restore).toBeVisible();
  await restore.click();
  await expect(page.getByRole("button", { name: /^Filtres \(1\)/ })).toBeVisible();
  await expect(restore).toHaveCount(0);
  await expect(page.getByRole("grid")).toBeFocused();
});
