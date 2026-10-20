// Notifications in-app (US-7.3) dans un vrai navigateur (démo ?demo=1, notifications locales) : cloche -> liste -> marquer lu ->
// tout marquer lu -> compteur à 0 ; préférences par type ; Échap rend le focus à la cloche ; axe-core sans violation grave.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openDemo } from "./helpers";

test("cloche : liste, marquer lu, tout marquer lu, compteur à 0 (axe sans violation grave)", async ({ page }) => {
  await openDemo(page);
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell.locator(".wn-badge")).toHaveText("2");
  await expect(page.getByTestId("notifications-live")).toHaveText("2 notifications non lues");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-expanded", "true");

  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByRole("listitem")).toHaveCount(3);
  await expect(panel.getByRole("listitem").first()).toContainText("Camille Durand a modifié vos allocations");
  await expect(panel.getByRole("listitem").first()).toContainText("2 allocations créées · 1 allocation modifiée");
  const axe = await new AxeBuilder({ page }).include(".wn-appheader").include("#wn-notifications-panel").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  await panel.getByRole("listitem").first().getByRole("button", { name: "Marquer comme lue" }).click();
  await expect(bell.locator(".wn-badge")).toHaveText("1");
  await expect(page.getByTestId("notifications-live")).toHaveText("1 notification non lue");
  await panel.getByRole("button", { name: "Tout marquer comme lu" }).click();
  await expect(bell.locator(".wn-badge")).toHaveCount(0);
  await expect(page.getByTestId("notifications-live")).toHaveText("Aucune notification non lue");
  await expect(panel.getByRole("button", { name: "Marquer comme lue" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Tout marquer comme lu" })).toBeDisabled();

  const pref = panel.getByRole("checkbox", { name: "les décisions sur mes congés" });
  await expect(pref).toBeChecked();
  await pref.uncheck();
  await expect(pref).not.toBeChecked();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(bell).toBeFocused();
});

test("anglais : textes du catalogue EN", async ({ page }) => {
  await openDemo(page, "en");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByRole("listitem").nth(1)).toContainText("Camille Durand handled your time off request");
  await expect(panel.getByRole("button", { name: "Mark all as read" })).toBeEnabled();
});
