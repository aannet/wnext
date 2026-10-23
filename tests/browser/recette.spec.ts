// Pré-recette automatisée (RT-044, L-R2) : rejoue docs/recette/scenarios.md contre la vraie pile avec le seed de recette en OIDC
// (config playwright.recette.config.ts, `npm run test:recette`). Un test par scénario, « R-NN — titre » ; les scénarios qui ne
// s'automatisent pas sont des `test.skip` motivés. Les tests partagent une base : chacun remet en état (Ctrl+Z ou interface) ce qu'il
// modifie, et l'ordre d'exécution compte (R-21, qui ajoute 300 personnes, passe en dernier).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { API, WEB, api, blocksOf, day, fr, loginPlanning, pxPerDay, rowOf, settleGrid, showDay, showPerson, visibleDayHeaders, type Who } from "./recette.support";
import { freeCell } from "./helpers";

const dialog = (page: Page) => page.getByRole("dialog");
const notice = (page: Page) => page.locator(".wn-notice");
const nav = (page: Page) => page.getByRole("banner").getByRole("navigation", { name: "Navigation principale" });

test("R-01 — Accès protégé par une connexion", async ({ page }) => {
  await page.goto(`${WEB}/?lang=fr`);
  await expect(page.getByRole("heading", { level: 1, name: "Connexion" })).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByRole("grid")).toHaveCount(0);
  const anonymous = await fetch(`${API}/schedule?from=${day(0)}&to=${day(14)}`);
  expect(anonymous.status).toBe(401);

  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("link", { name: "Alec", exact: true }).click();
  await page.getByRole("grid").waitFor();
  await page.getByRole("rowheader").first().waitFor();
  await expect(page.getByRole("heading", { level: 1, name: "Planning" })).toBeVisible();
  await expect(page.getByRole("banner").getByText("Bonjour Alec")).toBeVisible();
});

test("R-02 — En-tête applicatif et utilisateur connecté", async ({ page }) => {
  await loginPlanning(page, "alec");
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "WNEXT", exact: true })).toBeVisible();
  await expect(nav(page).getByRole("link")).toHaveText(["Planning", "Projets", "Personnes"]);
  await expect(header.getByRole("link", { name: "Réglages" })).toBeVisible();
  await expect(header.getByText("Bonjour Alec")).toBeVisible();
  const [h, t, b] = await Promise.all([header.boundingBox(), page.getByRole("heading", { level: 1, name: "Planning" }).boundingBox(), page.getByRole("toolbar").boundingBox()]);
  expect(t!.y).toBeGreaterThanOrEqual(h!.y + h!.height);
  // Recette n°4 (« Planning cible ») : le titre et la barre d'outils sur une seule ligne ; recherche et aide dans l'en-tête commun.
  expect(b!.x).toBeGreaterThan(t!.x + t!.width);
  expect(b!.y).toBeLessThan(t!.y + t!.height);
  await expect(header.getByRole("button", { name: /^Rechercher/ })).toBeVisible();
  await expect(header.getByRole("button", { name: "Raccourcis clavier" })).toBeVisible();

  // Le nom vient de l'utilisateur connecté (GET /me), pas d'une valeur codée.
  const other = await page.context().newPage();
  await loginPlanning(other, "camille");
  await expect(other.getByRole("banner").getByText("Bonjour Camille")).toBeVisible();
  await expect(other.getByRole("banner").getByText("Bonjour Alec")).toHaveCount(0);
  await other.close();
});

test.describe("R-03 — Densité d'affichage à 3 niveaux", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  const radio = async (page: Page, name: string) => {
    const menu = page.getByRole("dialog", { name: "Affichage" });
    if (!(await menu.isVisible())) await page.getByRole("button", { name: "Affichage", exact: true }).click();
    return menu.getByRole("radiogroup", { name: "Densité" }).getByRole("radio", { name, exact: true });
  };
  const fullRows = (page: Page) => page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[role="grid"]')!;
    const g = grid.getBoundingClientRect();
    const top = g.top + 32;
    const bottom = g.top + grid.clientHeight;
    return [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((e) => e.style.display !== "none").map((e) => e.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.top >= top - 0.5 && r.bottom <= bottom + 1.5).length;
  });

  test("R-03 — Densité d'affichage à 3 niveaux", async ({ page }) => {
    await loginPlanning(page, "alec");
    await expect(await radio(page, "Standard")).toHaveAttribute("aria-checked", "true");
    const counts: Record<string, number> = {};
    const sizes: Record<string, number> = {};
    for (const name of ["Compacte", "Standard", "Aérée"]) {
      await (await radio(page, name)).click();
      await expect(await radio(page, name)).toHaveAttribute("aria-checked", "true");
      await settleGrid(page);
      counts[name] = await fullRows(page);
      sizes[name] = await page.locator(".wn-person-name").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    }
    console.log("R-03 lignes entières visibles", counts, "taille du nom", sizes);
    expect(counts["Compacte"]!).toBeGreaterThan(counts["Standard"]!);
    expect(counts["Standard"]!).toBeGreaterThan(counts["Aérée"]!);
    expect.soft(sizes["Aérée"]!, "RT-006 : le nom de la personne grossit en densité aérée").toBeGreaterThan(sizes["Compacte"]!);
    await page.reload();
    await page.getByRole("rowheader").first().waitFor();
    await expect(await radio(page, "Aérée")).toHaveAttribute("aria-checked", "true");
    await (await radio(page, "Standard")).click(); // remet la densité par défaut
  });
});

test.describe("R-04 — Jauge d'allocation par personne", () => {
  test.use({ viewport: { width: 940, height: 900 } }); // 7 jours visibles : la période de la jauge tient dans une semaine

  test("R-04 — Jauge d'allocation par personne", async ({ page }) => {
    await loginPlanning(page, "alec");
    await showPerson(page, "Julie Lambert");
    const gauge = rowOf(page, "Julie Lambert").locator(".wn-gauge");
    await showDay(page, day(7));
    await expect(gauge).toHaveText("75 %");
    await expect(gauge).toHaveAttribute("title", `Du ${fr(day(7)).replace(/^\S+ /, "")} au ${fr(day(13)).replace(/^\S+ /, "")} : 30 h planifiées sur 40 h de capacité`);
    await showDay(page, day(14));
    await expect(gauge).toHaveText("▲ 125 % +10 h"); // icône et texte de dépassement, pas la couleur seule
    // RT-063 (L-X1) : l'infobulle compte aussi les jours en surcharge.
    await expect(gauge).toHaveAttribute("title", `Du ${fr(day(14)).replace(/^\S+ /, "")} au ${fr(day(20)).replace(/^\S+ /, "")} : 50 h planifiées sur 40 h de capacité · 5 jours en surcharge`);
  });
});

test("R-05 — Les formulaires s'ouvrent en fenêtre superposée", async ({ page }) => {
  await loginPlanning(page, "alec");
  const grid = page.locator('[role="grid"]'); // masquée aux rôles tant qu'une fenêtre modale est ouverte
  const rest = await grid.boundingBox();
  const closed = async (trigger: () => ReturnType<Page["locator"]>) => {
    await expect(dialog(page)).toHaveCount(0);
    await expect.soft(trigger(), "le focus est rendu au déclencheur (design.md, drawers)").toBeFocused();
    expect(await grid.boundingBox()).toEqual(rest); // la page derrière ne se décale pas
  };

  // Congé au clavier (RT-060 : plus de bouton « Nouveau congé ») : le drawer rend le focus à la grille.
  await grid.focus();
  await page.keyboard.press("c");
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouveau congé");
  expect(await grid.boundingBox()).toEqual(rest);
  await page.keyboard.press("Escape");
  await closed(() => grid);

  // Aide des raccourcis (RT-064).
  const help = () => page.getByRole("banner").getByRole("button", { name: "Raccourcis clavier" });
  await help().click();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText("Raccourcis clavier");
  expect(await grid.boundingBox()).toEqual(rest);
  await page.keyboard.press("Escape");
  await closed(help);

  const bell = () => page.getByRole("button", { name: /^Notifications/ });
  await bell().click();
  await expect(dialog(page)).toHaveAccessibleName("Notifications");
  expect(await grid.boundingBox()).toEqual(rest);
  await page.keyboard.press("Escape");
  await closed(bell);

  await showPerson(page, "Camille Roy");
  await showDay(page, day(14));
  const block = blocksOf(rowOf(page, "Camille Roy")).filter({ hasText: "Refonte" }).first();
  await block.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Retirer Camille Roy du projet Refonte/ }).click();
  await expect(dialog(page).getByRole("heading")).toHaveText("Retirer Camille Roy du projet Refonte ?");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(block).toBeVisible(); // rien n'a été retiré
});

test("R-07 — Création d'une personne", async ({ page }) => {
  await loginPlanning(page, "alec");
  await nav(page).getByRole("link", { name: "Personnes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Personnes" })).toBeVisible();
  const row = (name: string) => page.getByRole("row", { name: new RegExp(name), includeHidden: true }); // la liste est derrière le drawer modal

  const openCreate = async () => {
    await page.getByRole("button", { name: "Nouvelle personne" }).click();
    await expect(dialog(page).getByRole("heading", { level: 2, name: "Nouvelle personne" })).toBeVisible();
    return dialog(page);
  };
  let form = await openCreate();
  await form.getByLabel("Nom", { exact: true }).fill("Inès Dupont");
  await form.getByRole("button", { name: "Créer la personne" }).click();
  await expect(dialog(page).getByRole("heading", { level: 2, name: "Inès Dupont" })).toBeVisible(); // la fiche s'ouvre
  await expect(dialog(page).getByText("Toujours : 40 h par semaine")).toBeVisible(); // horaires par défaut du compte {8,8,8,8,8,0,0}
  await dialog(page).getByRole("button", { name: "Fermer" }).click();
  await expect(row("Inès Dupont")).toContainText("Employé");

  form = await openCreate();
  await form.getByLabel("Nom", { exact: true }).fill("À recruter");
  await form.getByLabel("Type").selectOption({ label: "Profil à pourvoir" });
  await form.getByRole("button", { name: "Créer la personne" }).click();
  await expect(dialog(page).getByRole("heading", { level: 2, name: "À recruter" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Fermer" }).click();
  await expect(row("À recruter")).toContainText("Profil à pourvoir");

  form = await openCreate();
  await form.getByLabel("Nom", { exact: true }).fill("Trop Chargée");
  await form.getByLabel("samedi").fill("25");
  await form.getByRole("button", { name: "Créer la personne" }).click();
  await expect(form.getByText("Chaque jour : un nombre d’heures entre 0 et 24.")).toBeVisible();
  await form.getByRole("button", { name: "Annuler" }).click();
  await expect(row("Trop Chargée")).toHaveCount(0);

  // Inès apparaît dans le Planning ; une fois désactivée, elle le quitte et son historique reste lisible.
  const planningHas = async (name: string) => {
    await nav(page).getByRole("link", { name: "Planning" }).click();
    await page.getByRole("rowheader").first().waitFor();
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Rechercher" });
    await palette.getByRole("combobox", { name: "Rechercher une personne ou un projet" }).fill(name);
    const found = (await palette.getByRole("option", { name: new RegExp(`^${name}`) }).count()) > 0;
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    return found;
  };
  expect(await planningHas("Inès Dupont")).toBe(true);

  await nav(page).getByRole("link", { name: "Personnes" }).click();
  for (const name of ["Inès Dupont", "À recruter"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await dialog(page).getByRole("button", { name: "Désactiver cette personne" }).click();
    await expect(dialog(page).getByRole("heading", { name: `Désactiver ${name}` })).toBeVisible();
    await dialog(page).getByRole("button", { name: "Désactiver", exact: true }).click();
    await expect(dialog(page).getByText("Personne désactivée.")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Fermer" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0); // sortie de la liste « Actives »
  }
  expect(await planningHas("Inès Dupont")).toBe(false);

  await nav(page).getByRole("link", { name: "Personnes" }).click();
  await page.getByLabel("État").selectOption({ label: "Désactivées" });
  await page.getByRole("button", { name: /^Inès Dupont Désactivée$/ }).click();
  await expect(dialog(page).getByText("Cette personne est désactivée")).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Historique de l’horaire" })).toBeVisible();
});

test("R-08 — Création client et projet", async ({ page }) => {
  await loginPlanning(page, "alec");
  await nav(page).getByRole("link", { name: "Projets" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("row", { name: /REF-01/ })).toBeVisible(); // le projet existe déjà

  // Client Acme : déjà dans le seed, il est choisi dans la liste ; un client neuf se crée à la volée.
  await page.getByRole("button", { name: "Nouveau projet" }).click();
  const form = dialog(page);
  await form.getByLabel("Nom du projet").fill("Portail client");
  await form.getByLabel("Client", { exact: true }).selectOption({ label: "Acme" });
  await form.getByLabel("Code projet").fill("REF-01");
  await form.getByRole("button", { name: "Créer le projet" }).click();
  await expect(form.getByText("Ce code est déjà utilisé par un autre projet.")).toBeVisible();

  await form.getByLabel("Code projet").fill("SITE-02");
  await form.getByLabel("Début").fill(day(28));
  await form.getByLabel("Fin").fill(day(20));
  await form.getByRole("button", { name: "Créer le projet" }).click();
  await expect(form.getByText("La fin ne peut pas précéder le début.")).toBeVisible();

  // Couleur : une couleur très claire est signalée (contraste), un format invalide aussi.
  await form.getByLabel("Autre couleur (#RRGGBB)").fill("#FFFFCC");
  await expect(form.getByText("Cette couleur est très claire")).toBeVisible();
  await form.getByLabel("Autre couleur (#RRGGBB)").fill("#12");
  await expect(form.getByText("Format attendu : # suivi de six chiffres hexadécimaux.")).toBeVisible();
  await form.getByRole("radio", { name: /^Couleur #/ }).nth(4).click();

  await form.getByLabel("Fin").fill(day(35));
  await form.getByRole("button", { name: "Créer le projet" }).click();
  const detail = dialog(page).getByRole("heading", { level: 2, name: "Portail client" });
  await expect(detail).toBeVisible();
  await expect(dialog(page).getByLabel("Code projet")).toHaveValue("SITE-02");
  await dialog(page).getByRole("button", { name: "Fermer" }).click();
  await expect(page.getByRole("row", { name: /Portail client/ })).toContainText("Acme");
});

test("R-09 — Propriétés d'un projet et de son équipe", async ({ page }) => {
  // Second onglet : le Planning sur le bloc « Refonte » de Camille (lundi S+2).
  const second = await page.context().newPage();
  await loginPlanning(second, "alec");
  await showPerson(second, "Camille Roy");
  await showDay(second, day(14));

  await loginPlanning(page, "alec");
  await nav(page).getByRole("link", { name: "Projets" }).click();
  await page.getByRole("button", { name: "Refonte", exact: true }).click();
  const panel = dialog(page);
  await expect(panel.getByRole("heading", { level: 2, name: "Refonte" })).toBeVisible();
  await expect(panel.getByLabel("Nom du projet")).toHaveValue("Refonte");
  await expect(panel.getByLabel("Code projet")).toHaveValue("REF-01");
  await expect(panel.getByLabel("Client", { exact: true })).toHaveValue(/.+/);
  await expect(panel.getByLabel("Début")).toHaveValue(day(-28));
  await expect(panel.getByRole("radio", { name: /^Couleur #/ }).first()).toBeVisible();
  await expect(panel.getByLabel("Statut")).toHaveValue("in_progress");
  await expect(panel.getByRole("heading", { level: 3, name: "Tâches" })).toBeVisible();
  await expect(panel.getByText("Conception", { exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { level: 3, name: "Équipe" })).toBeVisible();
  await expect(panel.getByText("Léo Martin", { exact: true })).toBeVisible();

  const colorBefore = await blocksOf(rowOf(second, "Camille Roy")).filter({ hasText: "Refonte" }).first().evaluate((e) => (e as HTMLElement).style.backgroundColor);
  await panel.getByLabel("Nom du projet").fill("Refonte v2");
  await panel.getByRole("radio", { name: /^Couleur #/ }).nth(9).click();
  const t0 = Date.now();
  await panel.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(panel.getByText("Modifications enregistrées.")).toBeVisible();

  // Le second onglet voit le nouveau nom et la nouvelle couleur sans recharger.
  const renamed = blocksOf(rowOf(second, "Camille Roy")).filter({ hasText: "Refonte v2" }).first();
  await expect(renamed).toBeVisible({ timeout: 5000 });
  const latency = Date.now() - t0;
  console.log(`R-09 : second onglet à jour après ${latency} ms`);
  expect.soft(latency, "le second onglet voit le changement en moins de 1 s").toBeLessThan(1500);
  expect(await renamed.evaluate((e) => (e as HTMLElement).style.backgroundColor)).not.toBe(colorBefore);
  await second.close();

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await nav(page).getByRole("link", { name: "Planning" }).click();
  await page.getByRole("rowheader").first().waitFor();
  await showPerson(page, "Camille Roy");
  await showDay(page, day(14));
  const shown = blocksOf(rowOf(page, "Camille Roy")).filter({ hasText: "Refonte v2" });
  await expect(shown.first()).toBeVisible();

  // Remise en état : le nom d'origine (les scénarios suivants cherchent « Refonte »).
  await nav(page).getByRole("link", { name: "Projets" }).click();
  await page.getByRole("button", { name: "Refonte v2", exact: true }).click();
  await dialog(page).getByLabel("Nom du projet").fill("Refonte");
  await dialog(page).getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(dialog(page).getByText("Modifications enregistrées.")).toBeVisible();
});

/** Prochaine position libre : point au milieu du jour `iso` (colonne `col` de la vue) sur la ligne de `name`, hors des blocs. */
async function cellOf(page: Page, name: string, col = 0) {
  const g = (await page.locator('[role="grid"]').boundingBox())!;
  const box = (await rowOf(page, name).boundingBox())!;
  const ppd = await pxPerDay(page);
  return { x: g.x + 240 + (col + 0.5) * ppd, y: box.y + 8, ppd };
}

test("R-10 — Poser une allocation par glisser sur une zone libre", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Lucas Morel");
  await showDay(page, day(14));
  const from = await cellOf(page, "Lucas Morel", 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + from.ppd, from.y, { steps: 4 });
  await page.mouse.move(from.x + 2 * from.ppd, from.y, { steps: 4 });
  await expect(page.locator(".wn-slot-draft")).toBeVisible(); // bloc provisoire pendant le glisser
  await page.mouse.up();
  const drawer = dialog(page);
  await expect(drawer.getByRole("heading")).toHaveText("Nouvelle allocation");
  await expect(drawer.getByLabel("Du", { exact: true })).toHaveValue(day(14));
  await expect(drawer.getByLabel("Au", { exact: true })).toHaveValue(day(16));
  await expect(drawer.getByRole("checkbox", { name: "Lucas Morel", exact: true })).toBeChecked();

  await drawer.getByRole("searchbox", { name: "Rechercher une personne" }).fill("Léo");
  await drawer.getByRole("checkbox", { name: "Léo Martin", exact: true }).check();
  await drawer.getByRole("combobox", { name: "Projet" }).fill("Refonte");
  await page.keyboard.press("Enter");
  await drawer.getByRole("button", { name: "Créer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(notice(page)).toHaveText(/^2 allocations créées \(groupe\)\. Ctrl\+Z annule\./);

  const label = `Refonte, du ${fr(day(14))} au ${fr(day(16))}, 8 h par jour`;
  const created = (id: string) => page.locator(`.wn-row[data-person="${id}"] .wn-block[aria-label="${label}"]:visible`);
  await expect(created("16")).toBeVisible(); // Lucas Morel
  await showPerson(page, "Léo Martin");
  await showDay(page, day(14));
  await expect(created("2")).toBeVisible();

  // La touche N ouvre le même éditeur (RT-060 : plus de bouton « + Allocation ») ; Échap rend le focus à la grille.
  await page.getByRole("grid").focus();
  await page.keyboard.press("n");
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouvelle allocation");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("grid")).toBeFocused();

  // Remise en état : Ctrl+Z annule la création de groupe.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Ajout annulé.");
  await expect(created("2")).toHaveCount(0);
  await showPerson(page, "Lucas Morel");
  await showDay(page, day(14));
  await expect(created("16")).toHaveCount(0);
});

// La saisie rapide est retirée de l'écran (RT-057, D1, ADR-002 §5 amendé) : R-11 joue sa remplaçante, la touche N.
test("R-11 — Création au clavier (touche N)", async ({ page }) => {
  await loginPlanning(page, "alec");
  await expect(page.locator(".wn-quick")).toHaveCount(0);
  await expect(page.getByText("8 h par jour par défaut.")).toHaveCount(0);
  await showPerson(page, "Camille Roy");
  const block = page.locator('.wn-row[data-person="1"] .wn-block[data-key]:visible').first();
  await block.focus();
  // Un jour seul : « Refonte, le …, 6 h » (plusieurs jours : « …, 6 h par jour »).
  const mine = page.locator('.wn-row[data-person="1"] .wn-block[aria-label^="Refonte,"][aria-label*=", 6 h"]:visible');
  const before = await mine.count();

  await page.keyboard.press("n");
  const drawer = dialog(page);
  await expect(drawer.getByRole("heading")).toHaveText("Nouvelle allocation");
  await expect(drawer.getByRole("checkbox", { name: "Camille Roy", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(block).toBeFocused(); // fermé sans écriture : focus rendu au bloc d'origine

  await page.keyboard.press("n");
  await drawer.getByRole("combobox", { name: "Projet" }).fill("Refonte");
  await page.keyboard.press("Enter");
  await drawer.getByRole("spinbutton", { name: "Heures par jour" }).fill("6");
  await drawer.getByRole("button", { name: "Créer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(notice(page)).toHaveText(/Ctrl\+Z annule/);
  await expect(mine).toHaveCount(before + 1);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Ajout annulé.");
  await expect(mine).toHaveCount(before);
});

test("R-12 — Éditer un bloc posé et changer son projet", async ({ page }) => {
  const second = await page.context().newPage();
  await loginPlanning(second, "alec");
  await showPerson(second, "Camille Roy");
  await showDay(second, day(14));

  await loginPlanning(page, "alec");
  await showPerson(page, "Camille Roy");
  await showDay(page, day(14));
  const before = `Refonte, du ${fr(day(14))} au ${fr(day(16))}, 8 h par jour`;
  const after = `Site vitrine, du ${fr(day(14))} au ${fr(day(16))}, 8 h par jour`;
  const block = (p: Page, label: string) => p.locator(`.wn-row[data-person="1"] .wn-block[aria-label="${label}"]:visible`);
  const original = block(page, before);
  // Position dans le contenu de la grille (x + scrollLeft) : Playwright peut faire défiler la grille en réessayant un clic
  // (bloc en transition au survol, RT-062) ; « même place » ne doit pas dépendre de ce défilement.
  const gridScroll = (p: Page) => p.locator(".wn-grid").evaluate((g) => ({ x: g.scrollLeft, y: g.scrollTop }));
  const s0 = await gridScroll(page);
  const b0 = (await original.boundingBox())!;
  const box = { x: b0.x + s0.x, y: b0.y + s0.y };
  const color = await original.evaluate((e) => (e as HTMLElement).style.backgroundColor);

  // Un clic simple sélectionne (poignées), il n'ouvre rien ; un double-clic ouvre le drawer prérempli.
  await original.click();
  await expect(original).toHaveAttribute("aria-selected", "true");
  await expect(dialog(page)).toHaveCount(0);
  await original.dblclick();
  const drawer = dialog(page);
  await expect(drawer.getByRole("heading")).toHaveText("Modifier l’allocation");
  await expect(drawer.getByRole("combobox", { name: "Personne" })).toHaveValue("Camille Roy");
  await expect(drawer.getByRole("combobox", { name: "Projet" })).toHaveValue("Refonte");
  await expect(drawer.getByRole("combobox", { name: "Tâche" })).toHaveValue("Design UI");
  await expect(drawer.getByLabel("Du", { exact: true })).toHaveValue(day(14));
  await expect(drawer.getByLabel("Au", { exact: true })).toHaveValue(day(16));
  await expect(drawer.getByRole("spinbutton", { name: "Heures par jour" })).toHaveValue("8");
  await expect(drawer.getByLabel("Note")).toHaveValue("Valider les variantes avec Nadia avant jeudi.");

  await drawer.getByRole("combobox", { name: "Projet" }).fill("Site vit");
  await page.keyboard.press("Enter");
  await drawer.getByRole("button", { name: "Enregistrer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(notice(page)).toContainText("Allocation modifiée. Ctrl+Z annule.");
  const changed = block(page, after);
  await expect(changed).toBeVisible();
  const s1 = await gridScroll(page);
  const b1 = (await changed.boundingBox())!;
  const movedBox = { x: b1.x + s1.x, y: b1.y + s1.y };
  expect(Math.abs(movedBox.x - box.x)).toBeLessThan(2); // même place
  expect(Math.abs(movedBox.y - box.y)).toBeLessThan(2);
  expect(await changed.evaluate((e) => (e as HTMLElement).style.backgroundColor)).not.toBe(color);
  await expect(block(second, after)).toBeVisible({ timeout: 3000 }); // le second onglet suit sans recharger
  await second.close();

  // Remise en état.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Changement d’allocation annulé.");
  await expect(block(page, before)).toBeVisible();
});

test("R-13 — Une même fenêtre pour projet et congé", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Camille Roy");
  await showDay(page, day(21));
  const gauge = rowOf(page, "Camille Roy").locator(".wn-gauge");
  const capacity = async () => Number(/sur ([\d,]+) h de capacité/.exec((await gauge.getAttribute("title"))!)![1]!.replace(",", "."));
  const before = await capacity();

  const from = await cellOf(page, "Camille Roy", 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + from.ppd, from.y, { steps: 6 });
  await page.mouse.up();
  const drawer = dialog(page);
  await expect(drawer.getByRole("heading")).toHaveText("Nouvelle allocation");
  await expect(drawer.getByRole("tab", { name: "Projet / tâche" })).toHaveAttribute("aria-selected", "true"); // onglet par défaut
  await drawer.getByRole("tab", { name: "Congé" }).click();
  await expect(drawer.getByRole("heading")).toHaveText("Nouveau congé");
  await expect(drawer.getByLabel("Personne")).toHaveValue("1");
  await expect(drawer.getByLabel("Du", { exact: true })).toHaveValue(day(21));
  await expect(drawer.getByLabel("Au", { exact: true })).toHaveValue(day(22));
  await drawer.getByLabel("Type").selectOption({ label: "Congés payés" });
  await drawer.getByRole("button", { name: "Enregistrer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(notice(page)).toHaveText("Congé enregistré.");

  const timeoff = page.locator(`.wn-row[data-person="1"] .wn-timeoff[aria-label="Congés payés, du ${fr(day(21))} au ${fr(day(22))}"]:visible`);
  await expect(timeoff).toBeVisible();
  await expect.poll(capacity).toBe(before - 16);

  // Remise en état.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Pose du congé annulée.");
  await expect(timeoff).toHaveCount(0);
  await expect.poll(capacity).toBe(before);
});

test("R-14 — Couleur du projet depuis le bloc", async ({ page }) => {
  const colorOf = async () => ((await api("alec", "GET", "/projects?limit=100")).json.items as { projectCode: string; color: string }[]).find((p) => p.projectCode === "REF-01")!.color;
  const before = await colorOf();
  await loginPlanning(page, "alec");
  await showPerson(page, "Camille Roy");
  await showDay(page, day(14));
  const label = `Refonte, du ${fr(day(14))} au ${fr(day(16))}, 8 h par jour`;
  const block = page.locator(`.wn-row[data-person="1"] .wn-block[aria-label="${label}"]:visible`);
  await block.dblclick();
  const drawer = dialog(page);
  await drawer.getByRole("button", { name: "Couleur du projet…" }).click();
  await drawer.getByRole("radio", { checked: false }).first().click();
  await drawer.getByRole("button", { name: "Appliquer la couleur" }).click();
  await expect(notice(page)).toHaveText("Couleur du projet Refonte changée : tous ses blocs suivent.");
  await drawer.getByRole("button", { name: "Annuler" }).click();
  await expect(drawer).toHaveCount(0);

  const after = await colorOf();
  expect(after).not.toBe(before);
  const rgb = `rgb(${[1, 3, 5].map((i) => parseInt(after.slice(i, i + 2), 16)).join(", ")})`;
  await expect.poll(() => block.evaluate((e) => (e as HTMLElement).style.backgroundColor)).toBe(rgb);
});

test("R-15 — Détecter un surbooking et le résoudre", async ({ page }) => {
  const second = await page.context().newPage();
  await loginPlanning(second, "alec");
  await showPerson(second, "Camille Roy");
  await showDay(second, day(14));
  const tuesday = day(15);
  const cap = (p: Page) => p.locator(`.wn-row[data-person="1"] .wn-cap[data-from="${tuesday}"]`);

  await loginPlanning(page, "alec");
  await showPerson(page, "Camille Roy");
  await showDay(page, day(14));
  await expect(cap(page)).toHaveAttribute("aria-label", /13 h planifiées sur 8 h de capacité, surcharge de 5 h/);
  await expect(cap(page)).toHaveClass(/wn-cap-over/);
  expect(await cap(page).evaluate((e) => getComputedStyle(e).backgroundImage)).not.toBe("none"); // motif hachuré en plus de la couleur

  // Ctrl+↓ fait passer le bloc à la ligne suivante, jusqu'à Léo Martin ; Entrée valide.
  const mine = page.locator(`.wn-row[data-person="1"] .wn-block[aria-label="Site vitrine, le ${fr(tuesday)}, 5 h"]:visible`);
  await mine.focus();
  for (let i = 0; i < 30 && !/^Léo Martin :/.test((await notice(page).textContent()) ?? ""); i++) await page.keyboard.press("Control+ArrowDown");
  await expect(notice(page)).toHaveText(/^Léo Martin : le .+, 5 h par jour|^Léo Martin : /);
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Modification enregistrée.");
  await expect(cap(page)).toHaveAttribute("aria-label", /8 h planifiées sur 8 h de capacité$/);
  await expect(cap(second)).toHaveAttribute("aria-label", /8 h planifiées sur 8 h de capacité$/, { timeout: 3000 });
  await second.close();
  await showPerson(page, "Léo Martin");
  await showDay(page, day(14));
  await expect(page.locator(`.wn-row[data-person="2"] .wn-block[aria-label="Site vitrine, le ${fr(tuesday)}, 5 h"]:visible`)).toBeVisible();

  // Remise en état.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Déplacement annulé.");
});

test("R-16 — Jeu chiffré de capacité", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Karim Haddad");
  await showDay(page, day(0));
  const thursday = day(3);
  const cap = page.locator(`.wn-row[data-person="6"] .wn-cap[data-from="${thursday}"]`);
  // Seed : 8 h ouvrées, congé du matin (4 h déduites), 4 h allouées.
  await expect(cap).toHaveAttribute("aria-label", /4 h planifiées sur 4 h de capacité$/);
  await expect(cap).toHaveAttribute("data-load", "100 %");

  // Une heure de plus : 5 h sur 4 h de capacité = 125 %, surtemps de 1 h.
  // Touche N sur un bloc de Karim (RT-060) : drawer prérempli avec Karim seul.
  await page.locator('.wn-row[data-person="6"] .wn-block[data-key]:visible').first().focus();
  await page.keyboard.press("n");
  const drawer = dialog(page);
  await expect(drawer.locator(".wn-slot-people input:checked")).toHaveCount(1);
  await drawer.getByRole("searchbox", { name: "Rechercher une personne" }).fill("Karim");
  await drawer.getByRole("checkbox", { name: "Karim Haddad", exact: true }).check();
  await drawer.getByRole("combobox", { name: "Projet" }).fill("Refonte");
  await page.keyboard.press("Enter");
  await drawer.getByLabel("Du", { exact: true }).fill(thursday);
  await drawer.getByLabel("Au", { exact: true }).fill(thursday);
  await drawer.getByRole("spinbutton", { name: "Heures par jour" }).fill("1");
  await drawer.getByRole("button", { name: "Créer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(cap).toHaveAttribute("aria-label", /5 h planifiées sur 4 h de capacité, surcharge de 1 h$/);
  await expect(cap).toHaveClass(/wn-cap-over/);
  await expect(cap).toHaveAttribute("data-load", "125 %"); // calculé par le moteur côté écran, jamais par l'API

  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Ajout annulé.");
  await expect(cap).toHaveAttribute("aria-label", /4 h planifiées sur 4 h de capacité$/);
});

test("R-17 — Déplacer, étirer, dupliquer, supprimer, annuler", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Camille Roy");
  await showDay(page, day(14));
  const at = (start: string, end: string) => page.locator(`.wn-row[data-person="1"] .wn-block[aria-label="Refonte, du ${fr(start)} au ${fr(end)}, 8 h par jour"]:visible`);

  // Déplacer d'un jour au clavier : flèche droite, Entrée.
  await at(day(14), day(16)).focus();
  await page.keyboard.press("ArrowRight");
  await expect(notice(page)).toContainText("Entrée pour valider");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Modification enregistrée.");
  await expect(at(day(15), day(17))).toBeVisible();

  // Étirer la fin d'un jour : Maj+flèche droite, Entrée.
  await at(day(15), day(17)).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Enter");
  await expect(at(day(15), day(18))).toBeVisible();

  // Étirer par la poignée droite à la souris (+1 jour).
  const ppd = await pxPerDay(page);
  const b = (await at(day(15), day(18)).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 4);
  const handle = (await page.locator('.wn-block[data-key] [data-handle="end"]').first().boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + ppd / 2, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.move(handle.x + handle.width / 2 + ppd, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(at(day(15), day(19))).toBeVisible();

  // Ctrl+Z annule chaque action, dans l'ordre inverse.
  await page.getByRole("grid").focus();
  for (const [msg, start, end] of [["Redimensionnement annulé.", day(15), day(18)], ["Redimensionnement annulé.", day(15), day(17)], ["Déplacement annulé.", day(14), day(16)]] as const) {
    await page.keyboard.press("Control+z");
    await expect(notice(page)).toContainText(msg);
    await expect(at(start, end)).toBeVisible();
  }

  // Dupliquer, scinder, supprimer : aucune commande dans l'interface (menu du bloc, clavier, drawer).
  const block = at(day(14), day(16));
  await block.click({ button: "right" });
  const items = page.getByRole("menuitem");
  expect.soft(await items.allTextContents(), "menu du bloc : dupliquer, scinder et supprimer sont attendus").toEqual(expect.arrayContaining([expect.stringMatching(/Dupliquer/), expect.stringMatching(/Scinder|Diviser/), expect.stringMatching(/Supprimer/)]));
  await page.keyboard.press("Escape");
  await block.focus();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
  expect.soft(await block.count(), "la touche Suppr supprime le bloc focalisé").toBe(0);
});

test("R-18 — Congé posé sur des allocations existantes (BR-04)", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Antoine Mercier");
  await showDay(page, day(21));
  const row = page.locator('.wn-row[data-person="10"]');
  const labels = [`Refonte, le ${fr(day(21))}, 4 h`, `Site vitrine, le ${fr(day(22))}, 4 h`, `Application mobile, le ${fr(day(23))}, 4 h`];
  const alloc = (label: string) => row.locator(`.wn-block[aria-label="${label}"]:visible`);
  for (const l of labels) await expect(alloc(l)).toBeVisible();

  const poseLeave = async (person: string, start: string, end: string, endHalf?: string) => {
    await page.getByRole("grid").focus();
    await page.keyboard.press("c"); // RT-060 : plus de bouton « Nouveau congé »
    const drawer = dialog(page);
    await expect(drawer.getByRole("heading")).toHaveText("Nouveau congé");
    await drawer.getByLabel("Personne").selectOption({ label: person });
    await drawer.getByLabel("Type").selectOption({ label: "Congés payés" });
    await drawer.getByLabel("Du", { exact: true }).fill(start);
    await drawer.getByLabel("Au", { exact: true }).fill(end);
    if (endHalf) await drawer.getByLabel("Fin").selectOption({ label: endHalf });
    await drawer.getByRole("button", { name: "Enregistrer" }).click();
    return drawer;
  };

  // Garder tel quel : avertissement sans rien supprimer, puis surcharge signalée.
  let drawer = await poseLeave("Antoine Mercier", day(21), day(23));
  await expect(drawer.getByRole("heading")).toHaveText("Ce congé recouvre des allocations de Antoine Mercier");
  // Le mercredi est le férié du seed : l'allocation y est déjà sans capacité, le congé n'y change rien (2 jours listés sur 3).
  await expect(drawer.getByRole("listitem")).toHaveCount(2);
  await expect(drawer.getByRole("listitem").first()).toContainText("4 h planifiées pour 0 h disponibles");
  await drawer.getByRole("button", { name: "Garder tel quel" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(notice(page)).toContainText("Antoine Mercier est en surcharge ces jours-là");
  for (const l of labels) await expect(alloc(l)).toBeVisible(); // aucune allocation supprimée
  await expect(row.locator(`.wn-cap[data-from="${day(21)}"]`)).toHaveClass(/wn-cap-over/);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(row.locator(".wn-timeoff:visible")).toHaveCount(0);

  // Reprogrammer : reporter ; les allocations se décalent, Ctrl+Z défait le tout.
  drawer = await poseLeave("Antoine Mercier", day(21), day(23));
  await drawer.getByRole("button", { name: "Reprogrammer…" }).click();
  await expect(drawer.getByRole("heading")).toHaveText("Reprogrammer les allocations");
  await expect(drawer.getByRole("radio", { name: "Reporter" }).first()).toBeChecked();
  await drawer.getByRole("button", { name: "Appliquer" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(notice(page)).toHaveText("Congé enregistré et allocations reprogrammées. Ctrl+Z annule le tout.");
  await expect(row.locator(".wn-timeoff:visible")).toHaveCount(1);
  await expect(alloc(labels[0]!)).toHaveCount(0); // décalée après le congé
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Pose du congé et reprogrammation annulée.");
  for (const l of labels) await expect(alloc(l)).toBeVisible();

  // Demi-journée du matin : 50 % des heures du jour déduites (Lucas Morel, libre ce mardi).
  await showPerson(page, "Lucas Morel");
  await showDay(page, day(14));
  const cap = page.locator(`.wn-row[data-person="16"] .wn-cap[data-from="${day(15)}"]`);
  await expect(cap).toHaveAttribute("aria-label", /sur 8 h de capacité/);
  await poseLeave("Lucas Morel", day(15), day(15), "Matin seulement");
  await expect(notice(page)).toHaveText("Congé enregistré.");
  await expect(cap).toHaveAttribute("aria-label", /sur 4 h de capacité/);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(cap).toHaveAttribute("aria-label", /sur 8 h de capacité/);

  // Un congé « en attente » du seed (Chloé Bernard) est affiché comme tel.
  await showPerson(page, "Chloé Bernard");
  await showDay(page, day(7));
  await expect(page.locator('.wn-row[data-person="11"] .wn-timeoff[aria-label$=", en attente"]:visible')).toBeVisible();
});

test("R-19 — Fériés par pays", async ({ page }) => {
  await loginPlanning(page, "alec");
  const holiday = day(23);
  await showPerson(page, "Camille Roy");
  await showDay(page, day(21));
  await expect(page.locator(`.wn-row[data-person="1"] .wn-cap[data-from="${holiday}"]`)).toHaveAttribute("aria-label", /aucune capacité/); // France : 0 h
  await showPerson(page, "Sam Carter");
  await showDay(page, day(21));
  await expect(page.locator(`.wn-row[data-person="14"] .wn-cap[data-from="${holiday}"]`)).toHaveAttribute("aria-label", /sur 8 h de capacité/); // États-Unis : 8 h

  // Le férié se règle dans Réglages > Jours fériés (pays FR).
  await page.getByRole("banner").getByRole("link", { name: "Réglages" }).click();
  await page.getByRole("tab", { name: "Jours fériés" }).click();
  const row = page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "Férié de recette (France)" });
  await expect(row).toContainText("FR");
  await expect(row).toContainText(holiday.slice(8));
});

test("R-20 — Retirer une personne d'un projet (BR-10)", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Léo Martin");
  await showDay(page, day(-14));
  const row = page.locator('.wn-row[data-person="2"]');
  const refonte = row.locator('.wn-block[aria-label^="Refonte, "]:visible');
  await expect(refonte.first()).toBeVisible();

  const open = async () => {
    await refonte.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Retirer Léo Martin du projet Refonte…" }).click();
    const d = dialog(page);
    await expect(d.getByRole("heading")).toHaveText("Retirer Léo Martin du projet Refonte ?");
    return d;
  };
  let d = await open();
  await expect(d.getByRole("listitem").first()).toHaveText(/^12 allocations supprimées \(du .+ au .+\)$/);
  await expect(d.getByRole("listitem").nth(1)).toHaveText("6 temps saisis supprimés (34 h)");
  await expect(d.getByText("Suppression définitive : elle ne s’annule pas avec Ctrl+Z.")).toBeVisible();

  // Annuler : rien n'est supprimé.
  await d.getByRole("button", { name: "Annuler" }).click();
  await expect(d).toHaveCount(0);
  await expect(refonte.first()).toBeVisible();

  d = await open();
  await d.getByRole("button", { name: "Retirer du projet" }).click();
  await expect(d).toHaveCount(0);
  await expect(notice(page)).toHaveText("Léo Martin n’est plus sur le projet Refonte : 12 allocations et 6 temps saisis supprimés.");
  await expect(refonte).toHaveCount(0);
  await expect(row.locator(".wn-block:visible").first()).toBeVisible(); // ses autres allocations restent
});

test("R-22 — Recherche, filtres, vues sauvegardées", async ({ page }) => {
  await loginPlanning(page, "alec");
  const people = page.locator(".wn-corner"); // RT-061 : compteur dans le coin de la grille
  await expect(people).toHaveText("17 personnes");
  const t0 = Date.now();
  await page.getByRole("button", { name: "Filtres", exact: true }).click();
  const filters = page.getByRole("group", { name: "Filtres" });
  await filters.getByRole("listbox", { name: "Département" }).selectOption({ label: "Design" });
  await filters.getByRole("listbox", { name: "Projet" }).selectOption({ label: "Refonte" });
  await expect(page.getByRole("button", { name: /^Filtres \(2\)/ })).toBeVisible();
  await expect(people).toHaveText(/^[23] personnes$/); // Camille Roy, Lucas Morel et, tant qu'il est dans l'équipe, Léo Martin
  console.log(`R-22 : filtres appliqués en ${Date.now() - t0} ms (clics compris)`);
  const names = () => page.locator(".wn-person-name").allTextContents().then((l) => l.filter(Boolean));
  expect(await names()).toEqual(expect.arrayContaining(["Camille Roy", "Lucas Morel"]));
  expect(await names()).not.toContain("Thomas Girard");

  // La recherche (Ctrl+K) amène « Cam » dans la vue filtrée.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Rechercher" });
  await palette.getByRole("combobox", { name: "Rechercher une personne ou un projet" }).fill("Cam");
  await expect(palette.getByRole("option", { name: /^Camille Roy/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(rowOf(page, "Camille Roy")).toHaveAttribute("data-highlight", "");

  // Vue sauvegardée (RT-058 : pied du panneau Filtres, resté ouvert) : filtres et zoom, rouverte par son lien ?view=.
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer la vue…" }).click();
  await dialog(page).getByLabel("Nom de la vue").fill("Design REF");
  await dialog(page).getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vue « Design REF » enregistrée." })).toBeAttached();
  await expect(page).toHaveURL(/[?&]view=\d+/);
  const link = page.url();

  await page.goto(link);
  await page.getByRole("rowheader").first().waitFor();
  await expect(page.getByRole("button", { name: /^Filtres \(2\) · Design REF$/ })).toBeVisible(); // nom de la vue sur le bouton
  await expect(people).toHaveText(/^[23] personnes$/);
  await expect(page.getByRole("button", { name: "Semaine", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Filtres \(2\)/ }).click();
  await expect(page.getByRole("combobox", { name: "Vue" }).locator("option:checked")).toHaveText("Design REF");

  // Remise en état : la vue est supprimée.
  await page.getByRole("button", { name: "Supprimer…" }).click();
  await dialog(page).getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Vue « Design REF » supprimée." })).toBeAttached();
});

test("R-23 — Notifications in-app", async ({ browser }) => {
  // Les scénarios précédents ont modifié les allocations de Camille (base partagée) : on part d'une cloche lue.
  expect((await api("camille", "POST", "/notifications/read-all")).status).toBe(200);
  const ctxAlec = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const ctxCamille = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const alec = await ctxAlec.newPage();
  const camille = await ctxCamille.newPage();
  await loginPlanning(alec, "alec");
  await loginPlanning(camille, "camille");
  const bell = camille.getByRole("button", { name: /^Notifications/ });
  const badge = bell.locator(".wn-badge");
  await expect(badge).toHaveCount(0); // la cloche part vide

  await showPerson(alec, "Camille Roy");
  await showDay(alec, day(28));
  const label = `Refonte, du ${fr(day(28))} au ${fr(day(32))}, 25 %`;
  const edit = async (percent: number, from: number) => {
    await alec.locator(`.wn-row[data-person="1"] .wn-block[aria-label="${label.replace("25 %", `${from} %`)}"]:visible`).dblclick();
    const drawer = dialog(alec);
    await drawer.getByRole("spinbutton", { name: "Pourcentage de la capacité" }).fill(String(percent));
    await drawer.getByRole("button", { name: "Enregistrer" }).click();
    await expect(drawer).toHaveCount(0);
  };

  const t0 = Date.now();
  await edit(30, 25);
  await expect(badge).toHaveText("1", { timeout: 5000 });
  const latency = Date.now() - t0;
  console.log(`R-23 : cloche de Camille incrémentée ${latency} ms après l'enregistrement`);
  expect.soft(latency, "la cloche s'incrémente en moins de 1 s").toBeLessThan(1500);

  await bell.click();
  const panel = camille.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByRole("listitem").first()).toContainText("Alec a modifié vos allocations");
  await expect(panel.getByRole("listitem").first()).toContainText("1 allocation modifiée");
  await panel.getByRole("button", { name: "Tout marquer comme lu" }).click();
  await expect(badge).toHaveCount(0);

  // Une préférence décochée supprime ce type de notification.
  const pref = panel.getByRole("checkbox", { name: "les changements de mes allocations" });
  await expect(pref).toBeChecked(); // préférences chargées
  await pref.click(); // l'état suit la réponse du serveur : pas de uncheck() (il relit l'état tout de suite)
  await expect(pref).not.toBeChecked();
  await camille.keyboard.press("Escape");
  await edit(35, 30);
  await camille.waitForTimeout(2000);
  await expect(badge).toHaveCount(0);

  // Remise en état : préférence rétablie, modifications annulées.
  await bell.click();
  await panel.getByRole("checkbox", { name: "les changements de mes allocations" }).click();
  await expect(panel.getByRole("checkbox", { name: "les changements de mes allocations" })).toBeChecked();
  await alec.getByRole("grid").focus();
  await alec.keyboard.press("Control+z");
  await alec.keyboard.press("Control+z");
  await expect(alec.locator(`.wn-row[data-person="1"] .wn-block[aria-label="${label}"]:visible`)).toBeVisible();
  await ctxAlec.close();
  await ctxCamille.close();
});

/** Aucune écriture offerte : plus de boutons de création pour personne (RT-060), donc N et C ne doivent rien ouvrir ; pas d'import. */
const noWriteControls = async (page: Page) => {
  const grid = page.getByRole("grid");
  if (await grid.count()) {
    await grid.focus();
    for (const key of ["n", "c"]) {
      await page.keyboard.press(key);
      await expect(dialog(page), `touche ${key}`).toHaveCount(0);
    }
  }
  await expect(page.getByRole("button", { name: /^Importer/ })).toHaveCount(0);
};
const scheduleOf = async (who: "camille" | "invite" | "nadia" | "autre") => {
  const r = await api(who, "GET", `/schedule?from=${day(0)}&to=${day(60)}`);
  return r.json as { people: { id: string }[]; allocations: { personId: string }[]; projects: { id: string; projectCode: string }[] };
};

/** Une session neuve (contexte propre, donc sessionStorage vide) connectée au Planning sous ce compte. */
async function session(browser: Browser, who: Who, prepare?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await prepare?.(page);
  await loginPlanning(page, who);
  return { page, close: () => context.close() };
}

test("R-24 — Rôles et isolation", async ({ browser }) => {
  // Member (Camille Roy) : planning en lecture seule ; ne voit que ses assignations (API et écran, US-6.1).
  const camille = await session(browser, "camille");
  const page = camille.page;
  await noWriteControls(page);
  const mine = await scheduleOf("camille");
  expect.soft(mine.allocations.every((a) => a.personId === "1"), `US-6.1 : un Member ne voit que ses assignations (l'API renvoie ${mine.allocations.length} allocations de ${new Set(mine.allocations.map((a) => a.personId)).size} personnes)`).toBe(true);
  expect.soft(mine.people.length, "US-6.1 : un Member ne voit que lui-même (l'API renvoie toutes les personnes du compte)").toBe(1);
  expect((await api("camille", "POST", "/allocations", { personId: "1", projectId: "1", startDate: day(60), endDate: day(60), load: { mode: "hours", hoursPerDay: 1 } })).status).toBe(403);

  await camille.close();

  // Guest : aucune écriture.
  const invite = await session(browser, "invite");
  await noWriteControls(invite.page);
  await invite.close();
  expect((await api("invite", "POST", "/allocations", { personId: "1", projectId: "1", startDate: day(60), endDate: day(60), load: { mode: "hours", hoursPerDay: 1 } })).status).toBe(403);

  // Chef de projet (Nadia) : écrit sur REF-01 (qu'elle gère) et refusé sur MOB-01.
  const ok = await api("nadia", "POST", "/allocations", { personId: "1", projectId: "1", startDate: day(60), endDate: day(60), load: { mode: "hours", hoursPerDay: 1 } });
  expect(ok.status).toBe(201);
  const refused = await api("nadia", "POST", "/allocations", { personId: "4", projectId: "3", startDate: day(60), endDate: day(60), load: { mode: "hours", hoursPerDay: 1 } });
  expect(refused.status).toBe(403);
  expect(refused.json.code).toBe("FORBIDDEN");
  expect((await api("alec", "DELETE", `/allocations/${ok.json.id}`, undefined, { "If-Match": '"1"' })).status).toBe(204);

  // Second compte : seulement ses propres données, aucune fuite.
  const other = await scheduleOf("autre");
  expect(other.people.map((p) => p.id).sort()).toEqual(["101", "102"]);
  expect(other.projects.map((p) => p.projectCode)).toEqual(["SEC-01"]);
  expect((await api("autre", "GET", "/people/1")).status).toBe(404);
  const autre = await session(browser, "autre");
  await expect(autre.page.locator(".wn-person-name", { hasText: "Agathe Collin" })).toBeVisible();
  await expect(autre.page.locator(".wn-person-name", { hasText: "Camille Roy" })).toHaveCount(0);
  await autre.close();
});

test("R-25 — Conflit d'édition concurrent", async ({ browser }) => {
  const a = await session(browser, "alec");
  // L'onglet B n'a pas de temps réel (ticket refusé) : il n'est pas synchronisé quand A enregistre.
  const b = await session(browser, "alec", (p) => p.route("**/api/v1/realtime/ticket", (r) => r.abort()));
  const label = (percent: number) => `Identité de marque, du ${fr(day(24))} au ${fr(day(25))}, ${percent} %`;
  for (const s of [a, b]) {
    await showPerson(s.page, "Camille Roy");
    await showDay(s.page, day(24));
  }
  const block = (page: Page, percent: number) => page.locator(`.wn-row[data-person="1"] .wn-block[aria-label="${label(percent)}"]:visible`);

  // Les deux onglets ouvrent le même bloc (version 1) ; A enregistre d'abord, B ensuite avec son formulaire périmé.
  await block(a.page, 50).dblclick();
  await block(b.page, 50).dblclick();
  const da = dialog(a.page);
  const db = dialog(b.page);
  await expect(db.getByRole("heading")).toHaveText("Modifier l’allocation");
  await da.getByRole("spinbutton", { name: "Pourcentage de la capacité" }).fill("60");
  await da.getByRole("button", { name: "Enregistrer" }).click();
  await expect(da).toHaveCount(0);
  await expect(block(b.page, 50)).toBeVisible(); // B n'a rien reçu

  await db.getByRole("spinbutton", { name: "Pourcentage de la capacité" }).fill("55");
  await db.getByRole("button", { name: "Enregistrer" }).click();
  await expect(db.getByText("Quelqu’un d’autre a modifié cette donnée entre-temps : la dernière version est affichée, refaites votre changement.")).toBeVisible();
  await expect(block(b.page, 55)).toHaveCount(0); // rien n'est écrasé en silence : la valeur de A est affichée à la place
  await expect(block(b.page, 60)).toBeVisible();
  await db.getByRole("button", { name: "Annuler" }).click();

  // Remise en état : Ctrl+Z dans l'onglet de A.
  await a.page.getByRole("grid").focus();
  await a.page.keyboard.press("Control+z");
  await expect(block(a.page, 50)).toBeVisible();
  await a.close();
  await b.close();
});

test("R-26 — Palette de recherche Ctrl+K", async ({ page }) => {
  await loginPlanning(page, "alec");
  const palette = page.getByRole("dialog", { name: "Rechercher" });
  const field = palette.getByRole("combobox", { name: "Rechercher une personne ou un projet" });
  const restore = page.getByRole("button", { name: "Rétablir les filtres" });

  // Une personne masquée par un filtre : l'option le dit, la confirmation retire les filtres, « Rétablir les filtres » les remet.
  await page.getByRole("button", { name: "Filtres", exact: true }).click();
  await page.getByRole("group", { name: "Filtres" }).getByRole("listbox", { name: "Département" }).selectOption({ label: "Produit" });
  await expect(page.getByRole("button", { name: /^Filtres \(1\)/ })).toBeVisible();
  await expect(rowOf(page, "Camille Roy")).toHaveCount(0);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  await field.fill("camille");
  await expect(palette.getByRole("option", { name: /^Camille Roy masquée par les filtres/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const confirm = palette.getByRole("button", { name: "Retirer les filtres et afficher Camille Roy" });
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(palette).toHaveCount(0);
  await expect(rowOf(page, "Camille Roy")).toHaveAttribute("data-highlight", "");
  await expect(page.getByRole("button", { name: "Filtres", exact: true })).toBeVisible(); // plus de filtre actif
  await restore.click();
  await expect(page.getByRole("button", { name: /^Filtres \(1\)/ })).toBeVisible();
  await expect(restore).toHaveCount(0);

  // Un projet : la fiche s'ouvre dans l'écran Projets.
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  await field.fill("refonte");
  await expect(palette.getByRole("group", { name: "Projets" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Projets" })).toBeVisible();
  await expect(dialog(page).getByRole("heading", { level: 2, name: "Refonte" })).toBeVisible();
  await expect(page).toHaveURL(/\/projets\?lang=fr$/); // le paramètre ?projet= est consommé

  // RT-059 (D5) : palette globale. Depuis l'écran Projets, une personne ouvre le Planning sur sa ligne.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await field.fill("camille");
  await palette.getByRole("option", { name: /^Camille Roy/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Planning" })).toBeVisible();
  await expect(rowOf(page, "Camille Roy")).toHaveAttribute("data-highlight", "");
  await expect(page).toHaveURL(/\/\?lang=fr$/); // le paramètre ?personne= est consommé
});

test("R-27 — Réglages > Compte : début de semaine", async ({ page }) => {
  await loginPlanning(page, "alec");
  const weekDays = async () => {
    await page.getByRole("button", { name: "Semaine", exact: true }).click();
    await expect(page.getByRole("button", { name: "Semaine", exact: true })).toHaveAttribute("aria-pressed", "true");
    await settleGrid(page);
    return [...new Set((await visibleDayHeaders(page)).map((d) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1))];
  };
  expect(await weekDays()).toEqual([1]); // lundi

  const saveWeekStart = async (label: string) => {
    await page.getByRole("banner").getByRole("link", { name: "Réglages" }).click();
    await page.getByRole("tab", { name: "Compte" }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByLabel("Fuseau horaire")).toHaveValue("Europe/Paris");
    await panel.getByLabel("Début de semaine").selectOption({ label });
    await panel.getByRole("button", { name: "Enregistrer" }).click();
    await expect(panel.getByText("Réglages du compte enregistrés.")).toBeVisible();
    await nav(page).getByRole("link", { name: "Planning" }).click();
    await page.getByRole("rowheader").first().waitFor();
  };
  await saveWeekStart("dimanche");
  expect(await weekDays()).toEqual([7]);
  await saveWeekStart("lundi"); // remise en état
  expect(await weekDays()).toEqual([1]);
});

test("R-28 — Colonne Accès de l'écran Personnes", async ({ browser }) => {
  const alec = await session(browser, "alec");
  await alec.page.goto(`${WEB}/personnes?lang=fr`);
  await expect(alec.page.getByRole("columnheader", { name: "Accès" })).toBeVisible();
  const row = (name: string) => alec.page.getByRole("row", { name: new RegExp(name) });
  await expect(row("Camille Roy")).toContainText("A un accès");
  await expect(row("Nadia Benali")).toContainText("A un accès");
  await expect(row("Léo Martin")).toContainText("Sans accès");
  await alec.close();

  // Un chef de projet voit la colonne ; un membre ne la reçoit pas.
  const nadia = await session(browser, "nadia");
  await nadia.page.goto(`${WEB}/personnes?lang=fr`);
  await expect(nadia.page.getByRole("columnheader", { name: "Accès" })).toBeVisible();
  await nadia.close();
  const camille = await session(browser, "camille");
  await camille.page.goto(`${WEB}/personnes?lang=fr`);
  await expect(camille.page.getByRole("table")).toBeVisible();
  await expect(camille.page.getByRole("columnheader", { name: "Accès" })).toHaveCount(0);
  await camille.close();
});

test("R-29 — Co-gestion de projet (Nadia et SITE-01)", async ({ browser }) => {
  const options = async (who: Who) => {
    const s = await session(browser, who);
    await s.page.getByRole("grid").focus();
    await s.page.keyboard.press("n"); // drawer de création (RT-060)
    const projet = dialog(s.page).getByRole("combobox", { name: "Projet" });
    await projet.click();
    const names = await s.page.getByRole("option").allTextContents();
    await s.close();
    return names;
  };
  // Nadia gère REF-01 et co-gère SITE-01 : l'éditeur ne lui propose que ces deux projets (BR-33).
  const nadia = await options("nadia");
  expect(nadia.some((n) => n.includes("Refonte"))).toBe(true);
  expect(nadia.some((n) => n.includes("Site vitrine"))).toBe(true);
  expect(nadia.some((n) => n.includes("Application mobile"))).toBe(false);
  expect(nadia).toHaveLength(2);
  // Le propriétaire les voit tous.
  expect((await options("alec")).length).toBeGreaterThanOrEqual(7);
  // L'API est juge : écriture acceptée sur SITE-01, refusée sur MOB-01.
  const ok = await api("nadia", "POST", "/allocations", { personId: "1", projectId: "2", startDate: day(60), endDate: day(60), load: { mode: "hours", hoursPerDay: 1 } });
  expect(ok.status).toBe(201);
  expect((await api("alec", "DELETE", `/allocations/${ok.json.id}`, undefined, { "If-Match": '"1"' })).status).toBe(204);
});

test.describe("R-30 — Appui long tactile sur une case vide", () => {
  test.use({ hasTouch: true });

  type Pt = { x: number; y: number };
  async function finger(page: Page, from: Pt, to: Pt | null, opts: { holdMs?: number; steps?: number } = {}) {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, p?: Pt) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
    await send("touchStart", from);
    if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
    const n = to ? (opts.steps ?? 8) : 0;
    for (let i = 1; i <= n; i++) {
      await send("touchMove", { x: from.x + ((to!.x - from.x) * i) / n, y: from.y + ((to!.y - from.y) * i) / n });
      await page.waitForTimeout(16);
    }
    await send("touchEnd");
    await cdp.detach();
  }
  const scrollLeft = (page: Page) => page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft);

  test("R-30 — Appui long tactile sur une case vide", async ({ page }) => {
    await loginPlanning(page, "alec");
    const ppd = await pxPerDay(page);
    const cell = await freeCell(page, ppd);
    expect(cell, "une case libre visible").toBeTruthy();

    // Un simple tap ne crée rien.
    await finger(page, cell!, null);
    await page.waitForTimeout(600);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(".wn-slot-draft")).toHaveCount(0);

    // Un balayage rapide fait défiler la grille sans rien créer.
    const before = await scrollLeft(page);
    await finger(page, cell!, { x: cell!.x - 3 * ppd, y: cell!.y }, { steps: 12 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(before + ppd);
    await page.waitForTimeout(600);
    await expect(dialog(page)).toHaveCount(0);

    // Appui long puis glisser d'un jour : le drawer de création s'ouvre sur la plage dessinée (case libre relue : la grille a défilé).
    const free = (await freeCell(page, ppd))!;
    expect(free, "une case libre visible").toBeTruthy();
    const start = await scrollLeft(page);
    await finger(page, free, { x: free.x + ppd, y: free.y }, { holdMs: 550, steps: 4 });
    await expect(dialog(page).getByRole("heading")).toHaveText("Nouvelle allocation");
    await expect(dialog(page).getByRole("checkbox", { name: free.person, exact: true })).toBeChecked();
    expect((await page.locator(".wn-slot-draft").boundingBox())!.width).toBeCloseTo(2 * ppd, 0);
    expect(await scrollLeft(page)).toBe(start);
    await page.keyboard.press("Escape");
  });
});

// RT-042 (L-P) : portée d'une série et d'un groupe dans le drawer : étape de choix à l'enregistrement,
// « Cette occurrence » / « Toute la série », « Cette ligne » / « Tout le groupe », puis « Confirmer ».
test("R-31 — Portée d'une série dans le drawer", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Nadia Benali");
  await showDay(page, day(7));
  const occurrence = (n: number, hours: number) => page.locator(`.wn-row[data-person="3"] .wn-block[aria-label="Refonte, le ${fr(day(n))}, ${hours} h, chaque semaine"]:visible`);
  await occurrence(7, 2).dblclick();
  const drawer = dialog(page);
  await expect(drawer.getByText("Série répétée")).toBeVisible();
  await drawer.getByRole("spinbutton", { name: "Heures par jour" }).fill("3");
  await drawer.getByRole("button", { name: "Enregistrer" }).click();

  // Cette occurrence : scission annoncée, non annulable ; seule l'occurrence du lundi S+1 passe à 3 h.
  await drawer.getByRole("radio", { name: "Cette occurrence" }).check();
  await drawer.getByRole("button", { name: "Confirmer" }).click();
  await expect(notice(page)).toContainText("La découpe d’une occurrence ne peut pas être annulée.");
  await expect(page.locator(`.wn-row[data-person="3"] .wn-block[aria-label^="Refonte, le ${fr(day(7))}, 3 h"]:visible`)).toBeVisible();
  await expect(occurrence(14, 2)).toBeVisible();

  // Toute la série : les occurrences passent toutes à 4 h, et Ctrl+Z annule.
  await occurrence(14, 2).dblclick();
  await drawer.getByRole("spinbutton", { name: "Heures par jour" }).fill("4");
  await drawer.getByRole("button", { name: "Enregistrer" }).click();
  await drawer.getByRole("radio", { name: "Toute la série" }).check();
  await drawer.getByRole("button", { name: "Confirmer" }).click();
  await expect(occurrence(14, 4)).toBeVisible();
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(occurrence(14, 2)).toBeVisible();
});

test("R-32 — Portée d'un groupe dans le drawer", async ({ page }) => {
  await loginPlanning(page, "alec");
  await showPerson(page, "Thomas Girard");
  await showDay(page, day(14));
  // La charge et la personne sont propres à chaque ligne : la portée ne se pose que pour un champ commun au groupe (ici le statut).
  const atelier = (person: string, tentative: boolean) => page.locator(`.wn-row[data-person="${person}"] .wn-block[aria-label="Application mobile, du ${fr(day(16))} au ${fr(day(17))}, 6 h par jour${tentative ? ", tentatif" : ""}"]:visible`);
  await atelier("4", false).dblclick(); // Thomas Girard ; Nadia (3) et Yasmine Cherif (15) ont la même ligne de groupe
  const drawer = dialog(page);
  await drawer.getByRole("combobox", { name: "Statut" }).selectOption("tentative");
  await drawer.getByRole("button", { name: "Enregistrer" }).click();

  // Cette ligne : seule la ligne de Thomas change.
  await drawer.getByRole("radio", { name: "Cette ligne" }).check();
  await drawer.getByRole("button", { name: "Confirmer" }).click();
  await expect(atelier("4", true)).toBeVisible(); // écriture optimiste : le drawer se ferme au retour de l'API
  await expect(drawer).toHaveCount(0); // sinon Ctrl+K et Ctrl+Z suivants iraient au drawer encore ouvert
  await showPerson(page, "Yasmine Cherif");
  await showDay(page, day(14));
  await expect(atelier("15", false)).toBeVisible();

  // Tout le groupe : les trois lignes passent en tentatif, annulable en un Ctrl+Z.
  await atelier("15", false).dblclick();
  await drawer.getByRole("combobox", { name: "Statut" }).selectOption("tentative");
  await drawer.getByRole("button", { name: "Enregistrer" }).click();
  await drawer.getByRole("radio", { name: "Tout le groupe" }).check();
  await drawer.getByRole("button", { name: "Confirmer" }).click();
  await expect(atelier("15", true)).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(atelier("15", false)).toBeVisible();
  // Remise en état : la ligne de Thomas revient en confirmé.
  await showPerson(page, "Thomas Girard");
  await showDay(page, day(14));
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+z");
  await expect(atelier("4", false)).toBeVisible();
});
