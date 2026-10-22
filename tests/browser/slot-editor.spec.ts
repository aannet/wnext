// Éditeur du créneau (lot L-E : RT-011, RT-013 à RT-018 ; drawer depuis L-K : RT-024, Q7, Q8) dans un vrai navigateur, sur la démo (?demo=1, écritures locales) :
// double clic -> passer au projet suivant -> bloc mis à jour, Ctrl+Z le rend ; glisser en zone libre -> bloc provisoire ->
// création pour deux personnes -> deux blocs ; Échap sur un bloc provisoire -> rien ; onglet Congé -> avertissement BR-04 ;
// couleur du projet depuis un bloc -> tous ses blocs changent ; axe-core sans violation sur les deux onglets.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

const GUTTER_PX = 240;
interface Box { key: string; label: string; x: number; y: number; w: number; h: number; bg: string }

/** Blocs visibles de la ligne de rang `index` (de haut en bas). */
const rowBlocks = (page: Page, index = 0): Promise<Box[]> => page.evaluate((i) => {
  const rows = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return [...rows[i]!.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => {
    const r = e.getBoundingClientRect();
    return { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "", x: r.left, y: r.top, w: r.width, h: r.height, bg: e.style.backgroundColor };
  });
}, index);

/** Un bloc simple (ni série ni tentatif) de la première ligne, son début dans la vue. */
async function plainBlock(page: Page): Promise<Box> {
  const g = (await page.getByRole("grid").boundingBox())!;
  const b = (await rowBlocks(page)).find((x) => /^Projet [A-F], (du|le) (lun|mar|mer|jeu|ven)\./.test(x.label) && !x.label.includes("chaque")
    && !x.label.includes("tentatif") && x.x >= g.x + GUTTER_PX + 8 && x.x <= g.x + g.width - 300);
  expect(b, "un bloc simple visible").toBeTruthy();
  return b!;
}

/** Une case libre (ni bloc ni congé) d'une ligne visible : abscisse et ordonnée au milieu du jour, nom de la personne. */
const freeCell = (page: Page): Promise<{ x: number; y: number; person: string; other: string } | null> => page.evaluate((gutter) => {
  const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .map((r) => ({ r, box: r.getBoundingClientRect() })).filter(({ box }) => box.top > grid.top + 40 && box.bottom < grid.bottom - 10)
    .sort((a, b) => a.box.top - b.box.top);
  const heads = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((h) => h.getBoundingClientRect())
    .filter((h) => h.left > grid.left + gutter + 4 && h.right < grid.right - 200);
  for (const [i, { r, box }] of rows.entries()) {
    for (const h of heads) {
      const x = h.left + h.width / 2;
      const y = box.top + 8;
      const hit = document.elementFromPoint(x, y);
      if (hit && r.contains(hit) && !hit.closest(".wn-block, .wn-timeoff, .wn-cap, .wn-rowheader")) {
        const name = (row: HTMLElement) => row.querySelector(".wn-person-name")!.textContent!;
        return { x, y, person: name(r), other: name((rows[i + 1] ?? rows[i - 1])!.r) };
      }
    }
  }
  return null;
}, GUTTER_PX);

const dialog = (page: Page) => page.getByRole("dialog");
const notice = (page: Page) => page.locator(".wn-notice");
const blockCount = (page: Page, prefix = "") => page.evaluate((p) => [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")]
  .filter((e) => e.style.display !== "none" && (e.getAttribute("aria-label") ?? "").startsWith(p)).length, prefix);
const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(r.violations.map((v) => `${v.impact} ${v.id}: ${v.help}`)).toEqual([]);
};

test("double clic sur un bloc : drawer à droite, passer au projet suivant, bloc mis à jour ; Ctrl+Z le rend ; axe propre sur les deux onglets", async ({ page }) => {
  await openDemo(page);
  const b = await plainBlock(page);
  const from = /^Projet ([A-F])/.exec(b.label)![1]!;
  const to = String.fromCharCode(from === "F" ? 65 : from.charCodeAt(0) + 1);
  await page.locator(`.wn-block[data-key="${b.key}"]`).dblclick();
  await expect(dialog(page).getByRole("heading")).toHaveText("Modifier l’allocation");
  await expect(dialog(page).getByRole("combobox", { name: "Projet" })).toBeFocused();
  // Drawer (RT-024, Q8) : collé au bord droit, sur toute la hauteur de la fenêtre.
  const vp = page.viewportSize()!;
  await expect.poll(async () => { const p = (await dialog(page).boundingBox())!; return [Math.round(p.x + p.width), Math.round(p.y), Math.round(p.height)]; })
    .toEqual([vp.width, 0, vp.height]); // après l'animation d'entrée
  await axe(page);
  await dialog(page).getByRole("tab", { name: "Congé" }).click();
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouveau congé");
  await axe(page);
  await dialog(page).getByRole("tab", { name: "Projet / tâche" }).click();

  await dialog(page).getByRole("combobox", { name: "Projet" }).fill(`Projet ${to}`);
  await page.keyboard.press("Enter");
  await dialog(page).getByRole("combobox", { name: "Tâche" }).click();
  await page.getByRole("option", { name: "Réalisation" }).click(); // liste dans un portail Base UI, hors du drawer
  await dialog(page).getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText("Allocation modifiée. Ctrl+Z annule.");
  await expect.poll(async () => (await rowBlocks(page)).find((x) => x.key === b.key)?.label).toBe(b.label.replace(`Projet ${from}`, `Projet ${to}`));

  await page.keyboard.press("Control+z");
  await expect(notice(page)).toHaveText("Changement d’allocation annulé.");
  await expect.poll(async () => (await rowBlocks(page)).find((x) => x.key === b.key)?.label).toBe(b.label);
});

test("glisser en zone libre : bloc provisoire, création pour deux personnes -> deux blocs ; Échap sur un bloc provisoire : rien", async ({ page }) => {
  await openDemo(page);
  const cell = await freeCell(page);
  expect(cell, "une case libre visible").toBeTruthy();
  const before = await blockCount(page);
  const beforeC = await blockCount(page, "Projet C, ");

  await page.mouse.click(cell!.x, cell!.y);
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouvelle allocation");
  await expect(page.locator(".wn-slot-draft")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".wn-slot-draft")).toBeHidden();
  expect(await blockCount(page)).toBe(before);

  await page.mouse.move(cell!.x, cell!.y);
  await page.mouse.down();
  await page.mouse.move(cell!.x + 20, cell!.y, { steps: 4 });
  await page.mouse.up();
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouvelle allocation");
  await expect(dialog(page).getByRole("checkbox", { name: cell!.person, exact: true })).toBeChecked();
  await dialog(page).getByRole("searchbox", { name: "Rechercher une personne" }).fill(cell!.other);
  await dialog(page).getByRole("checkbox", { name: cell!.other, exact: true }).check();
  await dialog(page).getByRole("combobox", { name: "Projet" }).fill("Projet C");
  await page.keyboard.press("Enter");
  await dialog(page).getByRole("button", { name: "Créer" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText(/^2 allocations créées \(groupe\)\. Ctrl\+Z annule\./);
  // Deux lignes voisines, toutes deux dans la vue : deux blocs « Projet C » de plus.
  await expect.poll(() => blockCount(page, "Projet C, ")).toBe(beforeC + 2);
});

test("onglet Congé depuis un bloc : congé posé avec l'avertissement BR-04 sur l'allocation recouverte", async ({ page }) => {
  await openDemo(page);
  const b = await plainBlock(page);
  await page.locator(`.wn-block[data-key="${b.key}"]`).dblclick();
  const tab = dialog(page).getByRole("tab", { name: "Projet / tâche" });
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog(page).getByRole("tab", { name: "Congé" })).toBeFocused();
  await expect(dialog(page).getByRole("heading")).toHaveText("Nouveau congé");
  await expect(dialog(page).getByLabel("Personne")).toHaveValue("1");
  await dialog(page).getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog(page).getByRole("heading")).toHaveText("Ce congé recouvre des allocations de Personne 1");
  await dialog(page).getByRole("button", { name: "Garder tel quel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toContainText("Personne 1 est en surcharge");
  await expect(page.locator('.wn-timeoff[aria-label^="Congés payés, "]').first()).toBeVisible();
  expect((await rowBlocks(page)).find((x) => x.key === b.key)?.label).toBe(b.label);
});

test("couleur du projet depuis un bloc : tous les blocs du projet changent", async ({ page }) => {
  await openDemo(page);
  const b = await plainBlock(page);
  const project = /^(Projet [A-F]),/.exec(b.label)![1]!;
  const colors = () => page.evaluate((p) => [...new Set([...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")]
    .filter((e) => e.style.display !== "none" && (e.getAttribute("aria-label") ?? "").startsWith(`${p}, `) && !(e.getAttribute("aria-label") ?? "").includes("tentatif"))
    .map((e) => e.style.backgroundColor))], project);
  const before = await colors();
  expect(before).toHaveLength(1);

  await page.locator(`.wn-block[data-key="${b.key}"]`).dblclick();
  await dialog(page).getByRole("button", { name: "Couleur du projet…" }).click();
  await dialog(page).getByRole("radio", { checked: false }).first().click();
  await dialog(page).getByRole("button", { name: "Appliquer la couleur" }).click();
  await expect(notice(page)).toHaveText(`Couleur du projet ${project} changée : tous ses blocs suivent.`);
  await dialog(page).getByRole("button", { name: "Annuler" }).click();
  await expect.poll(colors).not.toEqual(before);
  expect(await colors()).toHaveLength(1);
});

test("clic sur le voile : formulaire intact, le drawer se ferme ; modifié, « Abandonner les modifications ? » (Q7)", async ({ page }) => {
  await openDemo(page);
  const b = await plainBlock(page);
  await page.locator(`.wn-block[data-key="${b.key}"]`).dblclick();
  await expect(dialog(page).getByRole("heading")).toHaveText("Modifier l’allocation");
  await page.mouse.click(40, 450);
  await expect(dialog(page)).toHaveCount(0);

  await page.locator(`.wn-block[data-key="${b.key}"]`).dblclick();
  await dialog(page).getByRole("spinbutton", { name: "Heures par jour" }).fill("3");
  await page.mouse.click(40, 450);
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByRole("heading")).toHaveText("Abandonner les modifications ?");
  await confirm.getByRole("button", { name: "Continuer" }).click();
  await expect(dialog(page).getByRole("spinbutton", { name: "Heures par jour" })).toHaveValue("3");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "Abandonner" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await rowBlocks(page)).find((x) => x.key === b.key)?.label).toBe(b.label);
});

// Portée à l'enregistrement (RT-042, PO-08, lot L-P) : série ouverte sur une occurrence -> « Cette occurrence » ne change
// qu'elle (découpe annoncée non annulable) ; groupe -> « Tout le groupe » change chaque ligne, Ctrl+Z les rend toutes.
const labels = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")]
  .filter((e) => e.style.display !== "none").map((e) => e.getAttribute("aria-label") ?? ""));
const frDay = (iso: string) => new Intl.DateTimeFormat("fr", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

test("série : le drawer s'ouvre sur l'occurrence, « Cette occurrence » ne change qu'elle ; axe propre sur l'étape", async ({ page }) => {
  await openDemo(page);
  const g = (await page.getByRole("grid").boundingBox())!;
  let b: Box | undefined;
  for (let i = 0; i < 6 && !b; i++) {
    b = (await rowBlocks(page, i)).find((x) => x.label.includes("chaque semaine") && !/:0$/.test(x.key) && x.x >= g.x + GUTTER_PX + 8 && x.x + x.w <= g.x + g.width - 8);
  }
  expect(b, "une occurrence (rang >= 1) d'une série visible").toBeTruthy();
  const series = (await labels(page)).filter((l) => l.includes("chaque semaine")).length;
  const others = (await labels(page)).filter((l) => l !== b!.label);

  await page.locator(`.wn-block[data-key="${b!.key}"]`).dblclick();
  await expect(dialog(page).getByText("Série répétée : les dates sont celles de cette occurrence.", { exact: false })).toBeVisible();
  const start = await dialog(page).getByRole("textbox", { name: "Du", exact: true }).inputValue();
  expect(b!.label).toContain(frDay(start));
  await dialog(page).getByRole("spinbutton", { name: "Heures par jour" }).fill("3");
  await dialog(page).getByRole("button", { name: "Enregistrer" }).click();
  const group = dialog(page).getByRole("radiogroup", { name: "Cette allocation se répète. Que modifier ?" });
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio", { name: "Cette occurrence" })).toBeFocused();
  await expect(group.getByRole("radio", { name: "Cette occurrence" })).toBeChecked();
  await axe(page);
  await dialog(page).getByRole("button", { name: "Confirmer" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText(/^Occurrence modifiée\. La découpe d’une occurrence ne peut pas être annulée\./);
  const expected = b!.label.replace(", chaque semaine", "").replace(/, \d+ h/, ", 3 h");
  await expect.poll(async () => (await labels(page)).includes(expected)).toBe(true);
  // Les autres occurrences de la série gardent leur charge et leur répétition : une seule est sortie de la série.
  expect((await labels(page)).filter((l) => l.includes("chaque semaine")).length).toBe(series - 1);
  for (const l of others) expect(await labels(page)).toContain(l);
});

test("groupe : « Tout le groupe » change chaque ligne ; Ctrl+Z les rend toutes", async ({ page }) => {
  await openDemo(page);
  const cell = await freeCell(page);
  expect(cell, "une case libre visible").toBeTruthy();
  await page.mouse.click(cell!.x, cell!.y);
  await dialog(page).getByRole("searchbox", { name: "Rechercher une personne" }).fill(cell!.other);
  await dialog(page).getByRole("checkbox", { name: cell!.other, exact: true }).check();
  await dialog(page).getByRole("combobox", { name: "Projet" }).fill("Projet C");
  await page.keyboard.press("Enter");
  await dialog(page).getByRole("button", { name: "Créer" }).click();
  await expect(notice(page)).toHaveText(/^2 allocations créées \(groupe\)\./);
  const beforeC = await blockCount(page, "Projet C, ");
  const beforeD = await blockCount(page, "Projet D, ");

  const key = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y)?.closest(".wn-block") as HTMLElement | null)?.dataset.key ?? null, cell!);
  expect(key, "le bloc créé sous la case").toBeTruthy();
  await page.locator(`.wn-block[data-key="${key}"]`).dblclick();
  await dialog(page).getByRole("combobox", { name: "Projet" }).fill("Projet D");
  await page.keyboard.press("Enter");
  await dialog(page).getByRole("button", { name: "Enregistrer" }).click();
  const group = dialog(page).getByRole("radiogroup", { name: "Cette allocation fait partie d’un groupe de 2 personnes. Que modifier ?" });
  await expect(group.getByRole("radio", { name: "Cette ligne" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(group.getByRole("radio", { name: "Tout le groupe" })).toBeChecked();
  await axe(page);
  await dialog(page).getByRole("button", { name: "Confirmer" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText(/^Groupe modifié : 2 allocations\. Ctrl\+Z annule\./);
  await expect.poll(() => blockCount(page, "Projet D, ")).toBe(beforeD + 2);
  expect(await blockCount(page, "Projet C, ")).toBe(beforeC - 2);

  await page.keyboard.press("Control+z");
  await expect.poll(() => blockCount(page, "Projet C, ")).toBe(beforeC);
  expect(await blockCount(page, "Projet D, ")).toBe(beforeD);
});
