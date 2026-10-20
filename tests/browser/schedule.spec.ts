import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDemo, scrollLeft, settle, todayParis, visibleHeaders } from "./helpers";

const shots = fileURLToPath(new URL("./out/screenshots/", import.meta.url));
const zoomButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

test.describe("écran Schedule (démo 300 personnes)", () => {
  test("FR : la grille a ses rôles", async ({ page }) => {
    await openDemo(page, "fr");
    const grid = page.getByRole("grid", { name: "Planning des personnes" });
    await expect(grid).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Navigation dans le planning" })).toBeVisible();
    await expect(page.getByText("300 personnes")).toBeVisible();
    expect(await grid.getByRole("row").count()).toBeGreaterThan(5);
    expect(await grid.getByRole("rowheader").count()).toBeGreaterThan(5);
    expect(await grid.getByRole("gridcell").count()).toBeGreaterThan(5);
    expect(await grid.getByRole("columnheader").count()).toBeGreaterThan(5);
  });

  test("EN : libellés anglais", async ({ page }) => {
    await openDemo(page, "en");
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
    await expect(zoomButton(page, "Week")).toBeVisible();
    await expect(page.getByRole("rowheader").first()).toBeVisible();
    await expect(page.getByText("300 people")).toBeVisible();
  });

  test("zooms jour / semaine / mois changent les en-têtes", async ({ page }) => {
    await openDemo(page);
    mkdirSync(shots, { recursive: true });
    const seen: Record<string, { from: string; text: string }[]> = {};
    for (const [name, key] of [["Jour", "day"], ["Semaine", "week"], ["Mois", "month"]] as const) {
      await zoomButton(page, name).click();
      await expect(zoomButton(page, name)).toHaveAttribute("aria-pressed", "true");
      await settle(page);
      seen[key] = await visibleHeaders(page);
      expect(seen[key].length).toBeGreaterThan(2);
      await page.screenshot({ path: `${shots}zoom-${key}.png` });
    }
    const gap = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
    expect(seen.day.length).toBeGreaterThan(seen.week.length);
    expect(seen.week.length).toBeGreaterThan(seen.month.length);
    expect(gap(seen.day[0]!.from, seen.day[1]!.from)).toBe(1);
    expect(gap(seen.week[0]!.from, seen.week[1]!.from)).toBe(7);
    expect(gap(seen.month[0]!.from, seen.month[1]!.from)).toBeGreaterThanOrEqual(28);
    expect(new Set([seen.day[0]!.text, seen.week[0]!.text, seen.month[0]!.text]).size).toBe(3);
  });

  test("Aujourd'hui (bouton) et touche T ramènent aujourd'hui dans la vue", async ({ page }) => {
    await openDemo(page);
    const today = todayParis();
    const inView = async () => (await visibleHeaders(page)).some((h) => h.from === today);
    expect(await inView()).toBe(true);
    await page.mouse.move(800, 400);
    await page.mouse.wheel(3000, 0);
    await settle(page);
    expect(await inView()).toBe(false);
    await page.getByRole("button", { name: "Aujourd’hui" }).click();
    await settle(page);
    expect(await inView()).toBe(true);
    await page.mouse.move(800, 400);
    await page.mouse.wheel(4000, 0);
    await settle(page);
    expect(await inView()).toBe(false);
    await page.getByRole("grid").focus();
    await page.keyboard.press("t");
    await settle(page);
    expect(await inView()).toBe(true);
  });

  test("la molette horizontale fait avancer les dates", async ({ page }) => {
    await openDemo(page);
    const before = await visibleHeaders(page);
    const sl0 = await scrollLeft(page);
    await page.mouse.move(800, 400);
    await page.mouse.wheel(1500, 0);
    await settle(page);
    const after = await visibleHeaders(page);
    expect(await scrollLeft(page)).toBeGreaterThan(sl0 + 500);
    expect(after[0]!.from > before[0]!.from).toBe(true);
    await page.mouse.wheel(-1500, 0);
    await settle(page);
    expect((await visibleHeaders(page))[0]!.from).toBe(before[0]!.from);
  });
});
