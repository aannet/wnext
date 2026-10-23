// Gestes d'édition dans un vrai navigateur (démo ?demo=1, écritures locales) : pointeur (glisser, poignées, Échap),
// clavier (Entrée, flèche, Entrée) et choix de portée d'une série. Vérifiés par les positions et les aria-label des blocs
// (dates relues depuis le libellé traduit), jamais par des captures.
import { expect, test, type Page } from "@playwright/test";
import { freeCell, openDemo } from "./helpers";

interface Box { key: string; label: string; x: number; y: number; w: number; h: number }
const GUTTER_PX = 240; // colonne des personnes (ux-ui §2.1, lot L-C)
const HEADER_PX = 32;
const ROW_UNIT_PX = 72; // densité Standard, celle de l'écran par défaut (schedule/density.ts)

/** Blocs affichés, en coordonnées de la page. */
const allBlocks = (page: Page): Promise<Box[]> => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => {
    const r = e.getBoundingClientRect();
    return { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
  }));
const blockByKey = async (page: Page, key: string) => (await allBlocks(page)).find((b) => b.key === key) ?? null;
/** Bloc `key` une fois redessiné après l'écriture (son libellé a changé). */
async function changed(page: Page, b: Box): Promise<Box> {
  await expect.poll(async () => (await blockByKey(page, b.key))?.label ?? b.label, { message: `bloc ${b.key} redessiné` }).not.toBe(b.label);
  return (await blockByKey(page, b.key))!;
}

/** Largeur d'un jour, mesurée sur deux en-têtes de colonne consécutifs. */
const pxPerDay = (page: Page) => page.evaluate(() => {
  const xs = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((e) => e.getBoundingClientRect().left).sort((a, b) => a - b);
  return xs[1]! - xs[0]!;
});

/** Bloc entièrement visible, loin des bords qui font défiler (40 px), avec de la place à droite pour `room` px. */
async function pickBlock(page: Page, ok: (b: Box) => boolean, room = 0, minH = 18): Promise<Box> {
  const g = (await page.getByRole("grid").boundingBox())!;
  const found = (await allBlocks(page)).find((b) => b.x >= g.x + GUTTER_PX + 8 && b.x + b.w + room <= g.x + g.width - 80 && b.y >= g.y + HEADER_PX + 8
    && b.y + b.h <= g.y + g.height - 80 && b.h >= minH && ok(b));
  expect(found, "un bloc visible convenable").toBeTruthy();
  return found!;
}

/** Dates ISO d'un libellé de bloc (« du lun. 19 oct. au mar. 20 oct. » ou « le lun. 19 oct. »), formatées comme l'écran. */
const datesOf = (page: Page, label: string) => page.evaluate((l) => {
  const fmt = new Intl.DateTimeFormat("fr", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const iso = new Map<string, string>();
  for (let t = Date.now() - 400 * 864e5, i = 0; i < 800; i++, t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10);
    iso.set(fmt.format(new Date(`${d}T00:00:00Z`)), d);
  }
  const m = /, du (.+?) au (.+?),/.exec(l) ?? /, le (.+?),/.exec(l);
  if (!m) return null;
  return { start: iso.get(m[1]!) ?? m[1]!, end: iso.get(m[2] ?? m[1]!) ?? m[2]! };
}, label);
const hoursOf = (label: string) => Number(/, ([\d,]+) h/.exec(label)![1]!.replace(",", "."));
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function drag(page: Page, x: number, y: number, dx: number, dy: number, release = true) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  if (release) await page.mouse.up();
}
const notice = (page: Page) => page.locator(".wn-notice");
const ghostShown = (page: Page) => page.evaluate(() => {
  const g = document.querySelector<HTMLElement>(".wn-ghost");
  return !!g && g.style.display !== "none";
});
const simple = (b: Box) => !b.label.includes("chaque") && !b.label.includes("tentatif");

test.describe("gestes sur les blocs (démo, édition locale)", () => {
  test.beforeEach(async ({ page }) => { await openDemo(page); });

  test("glisser un bloc de deux jours vers la droite", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, simple, 2 * ppd);
    const before = (await datesOf(page, b.label))!;
    await drag(page, b.x + b.w / 2, b.y + 4, 2 * ppd, 0);
    await expect(notice(page)).toContainText("Modification enregistrée.");
    const after = await changed(page, b);
    expect(after.x - b.x).toBeCloseTo(2 * ppd, 0);
    expect(after.w).toBeCloseTo(b.w, 0);
    expect(await datesOf(page, after.label)).toEqual({ start: shift(before.start, 2), end: shift(before.end, 2) });
  });

  test("étirer la poignée droite d'un jour", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, simple, ppd);
    const before = (await datesOf(page, b.label))!;
    await page.mouse.move(b.x + b.w / 2, b.y + 4); // survol : les poignées se posent dans le bloc
    const handle = (await page.locator(`.wn-block[data-key="${b.key}"] [data-handle="end"]`).boundingBox())!;
    await drag(page, handle.x + handle.width / 2, handle.y + handle.height / 2, ppd, 0);
    await expect(notice(page)).toContainText("Modification enregistrée.");
    const after = await changed(page, b);
    expect(after.x).toBeCloseTo(b.x, 0);
    expect(after.w - b.w).toBeCloseTo(ppd, 0);
    expect(await datesOf(page, after.label)).toEqual({ start: before.start, end: shift(before.end, 1) });
  });

  test("poignée basse : un quart de ligne vers le haut = + 2 h par jour", async ({ page }) => {
    const b = await pickBlock(page, (x) => simple(x) && hoursOf(x.label) <= 5);
    const hours = hoursOf(b.label);
    await page.mouse.move(b.x + b.w / 2, b.y + 4);
    const handle = (await page.locator(`.wn-block[data-key="${b.key}"] [data-handle="height"]`).boundingBox())!;
    await drag(page, handle.x + handle.width / 2, handle.y + handle.height / 2, 0, -ROW_UNIT_PX / 4);
    await expect(notice(page)).toContainText("Modification enregistrée.");
    const after = await changed(page, b);
    expect(hoursOf(after.label)).toBe(hours + 2);
    expect(after.h - b.h).toBeCloseTo(ROW_UNIT_PX / 4, 0);
    expect(after.x).toBeCloseTo(b.x, 0);
  });

  test("Échap pendant un glisser annule : rien n'est écrit, le fantôme disparaît", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, simple, 2 * ppd);
    await drag(page, b.x + b.w / 2, b.y + 4, 2 * ppd, 0, false);
    await expect.poll(() => ghostShown(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => ghostShown(page)).toBe(false);
    await page.mouse.up();
    // Pointeur hors du bloc : son survol le soulève d'1 px (RT-062), ce qui fausserait la mesure de position.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    expect(await blockByKey(page, b.key)).toEqual(b);
    await expect(notice(page)).not.toContainText("enregistrée");
  });

  test("création à la souris : relâcher hors de la zone des blocs n'ouvre rien ; revenir dans la zone ouvre le drawer (RT-046)", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const c = (await freeCell(page, ppd))!;
    expect(c, "une case libre visible").toBeTruthy();
    const g = (await page.getByRole("grid").boundingBox())!;
    const draft = page.locator(".wn-slot-draft");
    for (const out of [{ x: g.x + 120, y: c.y }, { x: c.x, y: g.y - 10 }, { x: c.x, y: g.y + 10 }]) {
      await drag(page, c.x, c.y, ppd, 0, false);
      await expect(draft).toBeVisible();
      await page.mouse.move(out.x, out.y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(draft).toBeHidden();
    }
    await drag(page, c.x, c.y, ppd, 0, false);
    await page.mouse.move(g.x + 120, c.y, { steps: 6 });
    await page.mouse.move(c.x + ppd, c.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("Nouvelle allocation");
    expect((await draft.boundingBox())!.width).toBeCloseTo(2 * ppd, 0);
  });

  test("création à la souris : glisser sur la colonne des personnes borne la plage au premier jour visible (RT-046)", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const c = (await freeCell(page, 0))!;
    expect(c, "une case libre visible").toBeTruthy();
    const g = (await page.getByRole("grid").boundingBox())!;
    const draft = page.locator(".wn-slot-draft");
    await drag(page, c.x, c.y, -ppd, 0, false);
    await page.mouse.move(g.x + 120, c.y, { steps: 6 });
    await page.mouse.move(g.x + 10, c.y, { steps: 6 });
    const box = (await draft.boundingBox())!;
    expect(box.x).toBeGreaterThan(g.x + GUTTER_PX - ppd);
    expect(box.x + box.width).toBeGreaterThan(c.x);
    // Relâcher dans le premier jour visible : la plage créée commence là, pas plus tôt.
    await page.mouse.move(g.x + GUTTER_PX + 2, c.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("Nouvelle allocation");
    const after = (await draft.boundingBox())!;
    expect(after.x).toBeGreaterThan(g.x + GUTTER_PX - ppd);
    expect(after.x).toBeLessThanOrEqual(g.x + GUTTER_PX + 2);
  });

  test("Alt + glisser copie le bloc (RT-047) : l'original reste, la copie prend la place du fantôme ; Ctrl+Z la retire", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, simple, 3 * ppd);
    const before = (await datesOf(page, b.label))!;
    const project = b.label.split(",")[0]!;
    const copies = async () => {
      const out: string[] = [];
      for (const x of await allBlocks(page)) {
        const d = x.key !== b.key && x.label.startsWith(`${project},`) ? await datesOf(page, x.label) : null;
        if (d && d.start === shift(before.start, 3) && d.end === shift(before.end, 3)) out.push(x.key);
      }
      return out.length;
    };
    const already = await copies();
    await page.keyboard.down("Alt");
    await drag(page, b.x + b.w / 2, b.y + 4, 3 * ppd, 0);
    await page.keyboard.up("Alt");
    await expect(notice(page)).toHaveText("Allocation dupliquée. Ctrl+Z annule.");
    expect((await blockByKey(page, b.key))?.label).toBe(b.label);
    await expect.poll(copies).toBe(already + 1);
    await page.keyboard.press("Control+z");
    await expect(notice(page)).toHaveText("Duplication annulée.");
    await expect.poll(copies).toBe(already);
  });

  test("menu contextuel d'un bloc (RT-047) : Dupliquer, Supprimer, puis le retrait du projet ; Supprimer retire le bloc, Ctrl+Z le rend", async ({ page }) => {
    const b = await pickBlock(page, simple);
    await page.locator(`.wn-block[data-key="${b.key}"]`).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await expect(menu.getByRole("menuitem", { name: "Dupliquer", exact: true })).toHaveAttribute("aria-keyshortcuts", "Control+D Meta+D");
    await expect(menu.getByRole("menuitem", { name: "Supprimer", exact: true })).toHaveAttribute("aria-keyshortcuts", "Delete Backspace");
    await expect(menu.getByRole("menuitem").last()).toHaveText(/^Retirer .+ du projet .+…$/);
    await menu.getByRole("menuitem", { name: "Supprimer", exact: true }).click();
    await expect(notice(page)).toHaveText("Allocation supprimée. Ctrl+Z annule.");
    await expect.poll(async () => (await blockByKey(page, b.key)) === null).toBe(true);
    await page.keyboard.press("Control+z");
    await expect(notice(page)).toHaveText("Suppression annulée.");
    await expect.poll(async () => (await allBlocks(page)).some((x) => x.label === b.label && Math.abs(x.x - b.x) < 1)).toBe(true);
  });

  test("clavier : Entrée sur la grille, flèche droite, Entrée ; le focus reste sur le bloc", async ({ page }) => {
    await page.getByRole("grid").focus();
    await page.keyboard.press("Enter");
    const focused = () => page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      return e?.classList.contains("wn-block") ? { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "" } : null;
    });
    const b = (await focused())!;
    expect(b, "Entrée donne le focus à un bloc").not.toBeNull();
    const before = (await datesOf(page, b.label))!;
    await page.keyboard.press("ArrowRight");
    await expect(notice(page)).toContainText("Entrée pour valider");
    await page.keyboard.press("Enter");
    await expect(notice(page)).toContainText("Modification enregistrée.");
    await expect.poll(async () => (await focused())?.key).toBe(b.key);
    expect(await datesOf(page, (await focused())!.label)).toEqual({ start: shift(before.start, 1), end: shift(before.end, 1) });
  });

  test("série : la boîte « cette occurrence / toute la série » apparaît, puis le focus revient au bloc déplacé", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, (x) => x.label.includes("chaque semaine"), ppd, 10);
    const before = (await datesOf(page, b.label))!;
    await drag(page, b.x + b.w / 2, b.y + 3, ppd, 0);
    const dialog = page.getByRole("dialog", { name: "Cette allocation se répète. Que modifier ?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cette occurrence" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(notice(page)).toContainText("Modification enregistrée.");
    const focused = () => page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      return e?.classList.contains("wn-block") ? e.getAttribute("aria-label") : null;
    });
    await expect.poll(focused, { message: "le focus revient au bloc de l'occurrence" }).not.toBeNull();
    const label = (await focused())!;
    expect(label).not.toContain("chaque semaine"); // l'occurrence est sortie de la série
    expect(await datesOf(page, label)).toEqual({ start: shift(before.start, 1), end: shift(before.end, 1) });
  });

  test("série, Échap dans la boîte : rien ne change et le focus revient au bloc", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, (x) => x.label.includes("chaque semaine"), ppd, 10);
    await drag(page, b.x + b.w / 2, b.y + 3, ppd, 0);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(notice(page)).toContainText("Modification annulée.");
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe(b.key);
    expect(await blockByKey(page, b.key)).toEqual(b);
  });
});
