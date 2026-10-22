import type { Page } from "@playwright/test";

/** Date du jour dans le fuseau de la démo (même calcul que main.tsx : Europe/Paris). */
export const todayParis = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());

export async function openDemo(page: Page, lang: "fr" | "en" = "fr") {
  await page.goto(`/?demo=1&lang=${lang}`);
  await page.getByRole("grid").waitFor();
  await page.getByRole("rowheader").first().waitFor();
}

/** Dates de début des en-têtes de colonne réellement visibles dans la fenêtre de la grille, de gauche à droite. */
export async function visibleHeaders(page: Page): Promise<{ from: string; text: string }[]> {
  return page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]')!;
    const g = grid.getBoundingClientRect();
    const out: { from: string; text: string; left: number }[] = [];
    for (const el of grid.querySelectorAll('[role="columnheader"][data-from]')) {
      const r = el.getBoundingClientRect();
      if (r.right > g.left + 240 && r.left < g.right) out.push({ from: el.getAttribute("data-from")!, text: el.textContent ?? "", left: r.left });
    }
    return out.sort((a, b) => a.left - b.left).map(({ from, text }) => ({ from, text }));
  });
}

export const scrollLeft = (page: Page) => page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft);

/** Attend deux images puis laisse finir l'animation douce (300 ms) : le redessin est planifié par requestAnimationFrame. */
export const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500)))));

/** Une case libre (ni bloc, ni congé, ni bande de capacité) d'une ligne visible, avec `room` px libres à sa droite ; nom de la personne. */
export const freeCell = (page: Page, room: number): Promise<{ x: number; y: number; person: string } | null> => page.evaluate((room) => {
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
