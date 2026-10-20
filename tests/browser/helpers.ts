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
      if (r.right > g.left + 140 && r.left < g.right) out.push({ from: el.getAttribute("data-from")!, text: el.textContent ?? "", left: r.left });
    }
    return out.sort((a, b) => a.left - b.left).map(({ from, text }) => ({ from, text }));
  });
}

export const scrollLeft = (page: Page) => page.evaluate(() => document.querySelector('[role="grid"]')!.scrollLeft);

/** Attend deux images puis laisse finir l'animation douce (300 ms) : le redessin est planifié par requestAnimationFrame. */
export const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500)))));
