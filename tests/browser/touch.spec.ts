// Gestes tactiles (WCAG 2.5.7) dans un contexte hasTouch, via les événements tactiles réels de Chromium (CDP Input.dispatchTouchEvent) :
// tap = poignées, appui long + glisser = déplacement, balayage rapide = défilement de la grille sans toucher au bloc ; case vide :
// tap = rien, appui long + glisser = drawer de création (RT-043).
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers";

test.use({ hasTouch: true });

interface Box { key: string; label: string; x: number; y: number; w: number; h: number }
const blocks = (page: Page): Promise<Box[]> => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".wn-block[data-key]")].filter((e) => e.style.display !== "none").map((e) => {
    const r = e.getBoundingClientRect();
    return { key: e.dataset.key!, label: e.getAttribute("aria-label") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
  }));
const byKey = async (page: Page, key: string) => (await blocks(page)).find((b) => b.key === key)!;
const pickBlock = async (page: Page, room: number): Promise<Box> => {
  const g = (await page.getByRole("grid").boundingBox())!;
  const b = (await blocks(page)).find((x) => x.x >= g.x + 260 && x.x + x.w + room <= g.x + g.width - 80 && x.y >= g.y + 48 && x.y + x.h <= g.y + g.height - 80
    && x.h >= 30 && x.w >= 60 && !x.label.includes("chaque") && !x.label.includes("tentatif"));
  expect(b, "un bloc visible convenable").toBeTruthy();
  return b!;
};
const pxPerDay = (page: Page) => page.evaluate(() => {
  const xs = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((e) => e.getBoundingClientRect().left).sort((a, b) => a - b);
  return xs[1]! - xs[0]!;
});
const scrollLeft = (page: Page) => page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft);
/** Une case libre (ni bloc, ni congé, ni bande de capacité) d'une ligne visible, avec `room` px libres à sa droite ; nom de la personne. */
const freeCell = (page: Page, room: number): Promise<{ x: number; y: number; person: string } | null> => page.evaluate((room) => {
  const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  const free = (x: number, y: number, r: HTMLElement) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && r.contains(hit) && !hit.closest(".wn-block, .wn-timeoff, .wn-cap, .wn-rowheader");
  };
  const rows = [...document.querySelectorAll<HTMLElement>(".wn-row")].filter((r) => r.style.display !== "none")
    .map((r) => ({ r, box: r.getBoundingClientRect() })).filter(({ box }) => box.top > grid.top + 40 && box.bottom < grid.bottom - 10);
  const heads = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((h) => h.getBoundingClientRect())
    .filter((h) => h.left > grid.left + 260 && h.right + room < grid.right - 80);
  for (const { r, box } of rows) {
    for (const h of heads) {
      const x = h.left + h.width / 2;
      const y = box.top + 8;
      if (free(x, y, r) && free(x + room, y, r)) return { x, y, person: r.querySelector(".wn-person-name")!.textContent! };
    }
  }
  return null;
}, room);

type Pt = { x: number; y: number };
/** Un doigt : pose en `from`, attend `holdMs`, passe par `steps` points jusqu'à `to`, relâche (`to` absent : simple tap). */
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

type Contact = Pt & { id: number };
/** Plusieurs doigts : chaque étape liste les contacts posés (identifiants stables) puis attend `wait` ms. Un nouvel identifiant
 *  pose un doigt (touchStart), un identifiant absent le relève (CDP relâche les points manquants), une liste vide relève tout. */
async function fingers(page: Page, steps: { pts: Contact[]; wait?: number; check?: () => Promise<void> }[]) {
  const cdp = await page.context().newCDPSession(page);
  let prev = new Set<number>();
  for (const { pts, wait, check } of steps) {
    const ids = new Set(pts.map((p) => p.id));
    const type = pts.length === 0 ? "touchEnd" : [...ids].some((i) => !prev.has(i)) ? "touchStart" : "touchMove";
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
    prev = ids;
    await page.waitForTimeout(wait ?? 16);
    await check?.();
  }
  if (prev.size) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
/** Un point hors de la grille, au-dessus d'elle, sur rien de cliquable (un deuxième doigt qui s'y pose puis se relève ne déclenche rien). */
const offGrid = (page: Page): Promise<Pt> => page.evaluate(() => {
  const g = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  for (let y = g.top - 4; y > 0; y -= 4) {
    for (let x = g.left + 8; x < g.right; x += 16) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('button, a, input, select, textarea, label, [role="tab"], [role="button"], [tabindex], [role="grid"]')) return { x, y };
    }
  }
  throw new Error("aucun point libre au-dessus de la grille");
});
/** Ni drawer ni bloc provisoire visible. */
async function nothingCreated(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".wn-slot-draft")).toBeHidden();
}

test.describe("gestes tactiles (démo)", () => {
  test.beforeEach(async ({ page }) => { await openDemo(page); });

  test("tap sur un bloc : sélection et poignées ; tap ailleurs : désélection", async ({ page }) => {
    const b = await pickBlock(page, 0);
    const sel = page.locator(`.wn-block[data-key="${b.key}"]`);
    expect(await sel.evaluate((e) => getComputedStyle(e).touchAction)).toBe("pan-x pan-y");
    await finger(page, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, null);
    await expect(sel).toHaveAttribute("aria-selected", "true");
    await expect(sel.locator("[data-handle]")).toHaveCount(3);
    const start = (await sel.locator('[data-handle="start"]').boundingBox())!;
    expect(start.width).toBeGreaterThanOrEqual(b.w >= 110 ? 44 : 22);
    expect(start.height).toBeGreaterThanOrEqual(Math.min(44, b.h - 1));
    expect(await sel.evaluate((e) => getComputedStyle(e).touchAction)).toBe("none");
    const g = (await page.getByRole("grid").boundingBox())!;
    await finger(page, { x: g.x + g.width - 20, y: g.y + 20 }, null);
    await expect(sel).not.toHaveAttribute("aria-selected", "true");
    await expect(sel.locator("[data-handle]")).toHaveCount(0);
  });

  test("appui long puis glisser de deux jours : le bloc est déplacé", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, 2 * ppd);
    const from = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await finger(page, from, { x: from.x + 2 * ppd, y: from.y }, { holdMs: 550 });
    await expect(page.locator(".wn-notice")).toContainText("Modification enregistrée.");
    await expect.poll(async () => (await byKey(page, b.key)).label).not.toBe(b.label);
    expect((await byKey(page, b.key)).x - b.x).toBeCloseTo(2 * ppd, 0);
  });

  test("balayage rapide sans appui long : la grille défile, le bloc ne bouge pas", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const b = await pickBlock(page, 0);
    const before = await scrollLeft(page);
    const from = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await finger(page, from, { x: from.x - 3 * ppd, y: from.y }, { steps: 12 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(before + ppd);
    await expect(page.locator(".wn-notice")).not.toContainText("Modification enregistrée.");
    expect(await page.locator(".wn-block.wn-selected, .wn-block.wn-armed").count()).toBe(0);
  });

  test("appui long sur une case vide ouvre le drawer de création ; un tap sur une case vide ne crée rien (RT-043)", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const cell = await freeCell(page, ppd);
    expect(cell, "une case libre visible").toBeTruthy();
    const dialog = page.getByRole("dialog");

    await finger(page, cell!, null);
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".wn-slot-draft")).toHaveCount(0);

    const before = await scrollLeft(page);
    await finger(page, cell!, { x: cell!.x + ppd, y: cell!.y }, { holdMs: 550, steps: 4 });
    await expect(dialog.getByRole("heading")).toHaveText("Nouvelle allocation");
    await expect(dialog.getByRole("checkbox", { name: cell!.person, exact: true })).toBeChecked();
    const draft = (await page.locator(".wn-slot-draft").boundingBox())!;
    expect(draft.width).toBeCloseTo(2 * ppd, 0);
    expect(await scrollLeft(page)).toBe(before);
  });

  test("balayage rapide depuis une case vide : la grille défile, rien n'est créé", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const cell = await freeCell(page, 0);
    expect(cell, "une case libre visible").toBeTruthy();
    const before = await scrollLeft(page);
    await finger(page, cell!, { x: cell!.x - 3 * ppd, y: cell!.y }, { steps: 12 });
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(before + ppd);
    await page.waitForTimeout(600);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".wn-slot-draft")).toHaveCount(0);
  });

  test("deux doigts immobiles sur des cases libres, puis pincement : rien n'est créé (RT-043, revue)", async ({ page }) => {
    const ppd = await pxPerDay(page);
    const c = (await freeCell(page, ppd))!;
    expect(c, "une case libre visible").toBeTruthy();
    const a = { id: 1, x: c.x, y: c.y };
    const b = { id: 2, x: c.x + ppd, y: c.y };
    await fingers(page, [{ pts: [a], wait: 50 }, { pts: [a, b], wait: 600 }, { pts: [b], wait: 600 }, { pts: [] }]);
    await nothingCreated(page);
    const spread = (d: number) => [{ ...a, x: a.x - d }, { ...b, x: b.x + d }];
    await fingers(page, [{ pts: [a], wait: 30 }, { pts: [a, b], wait: 30 }, ...[4, 8, 16, 24, 32].map((d) => ({ pts: spread(d) })), { pts: spread(32), wait: 600 }, { pts: [] }]);
    await nothingCreated(page);
  });

  test("deuxième doigt hors de la grille après l'armement : bloc provisoire retiré, relâcher n'ouvre rien (RT-043, revue)", async ({ page }) => {
    const c = (await freeCell(page, 0))!;
    expect(c, "une case libre visible").toBeTruthy();
    const out = await offGrid(page);
    const a = { id: 1, x: c.x, y: c.y };
    await fingers(page, [
      { pts: [a], wait: 550, check: () => expect(page.locator(".wn-slot-draft")).toBeVisible() },
      { pts: [a, { id: 2, ...out }], wait: 50, check: () => expect(page.locator(".wn-slot-draft")).toBeHidden() },
      { pts: [a], wait: 50 }, { pts: [] },
    ]);
    await page.waitForTimeout(300);
    await nothingCreated(page);
  });

  test("après l'armement, glisser vers la colonne des personnes ou au-dessus de la grille : création abandonnée (RT-043, revue)", async ({ page }) => {
    const c = (await freeCell(page, 0))!;
    expect(c, "une case libre visible").toBeTruthy();
    const g = (await page.getByRole("grid").boundingBox())!;
    await finger(page, c, { x: g.x + 120, y: c.y }, { holdMs: 550 });
    await page.waitForTimeout(300);
    await nothingCreated(page);
    await finger(page, c, { x: c.x, y: g.y - 10 }, { holdMs: 550 });
    await page.waitForTimeout(300);
    await nothingCreated(page);
    // Témoin : le même geste resté dans la zone des blocs ouvre bien le drawer.
    await finger(page, c, { x: c.x, y: c.y + 4 }, { holdMs: 550 });
    await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("Nouvelle allocation");
  });
});
