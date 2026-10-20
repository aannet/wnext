// Parcours complet contre `dev:stack --oidc` (configuration playwright.oidc.config.ts) : portail de connexion WNEXT (pas de
// redirection automatique), bouton « Se connecter » vers le fournisseur, choix de l'utilisateur « Alec », retour avec URL nettoyée,
// « Bonjour Alec » (GET /me), GET /schedule 200 avec jeton porteur, temps réel connecté et reçu, renouvellement du jeton avant
// expiration, reprise après rechargement sans redirection, Déconnexion qui ramène au portail, puis un membre (droits réduits).
import { createHash, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { todayParis } from "./helpers";
import { OIDC_PORTS, TOKEN_TTL_SEC } from "./playwright.oidc.config";

const IDP = `http://127.0.0.1:${OIDC_PORTS.idp}`;
const API = `http://127.0.0.1:${OIDC_PORTS.api}`;
const REDIRECT = `http://127.0.0.1:${OIDC_PORTS.web}/`;

/** Jeton d'accès obtenu hors navigateur (même flux PKCE, auto-connexion par login_hint) : joue « un autre client ». */
async function tokenFor(subject: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: "wnext-web", redirect_uri: REDIRECT, state: "s", nonce: "n", login_hint: subject,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const back = await fetch(`${IDP}/authorize?${q}`, { redirect: "manual" });
  const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
  const res = await fetch(`${IDP}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: "wnext-web", code_verifier: verifier }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

test("connexion OIDC PKCE de bout en bout", async ({ page }) => {
  const scheduleOk = page.waitForResponse((r) => r.url().includes("/api/v1/schedule?") && r.request().method() === "GET");
  await page.goto("/?lang=fr");
  // Portail de connexion : on reste sur WNEXT tant qu'on n'a pas cliqué.
  await expect(page.getByRole("heading", { level: 1, name: "Connexion" })).toBeVisible();
  expect(page.url()).toBe(`${REDIRECT}?lang=fr`);
  await expect(page.getByRole("banner")).toHaveCount(0);
  const gateAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(gateAxe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(new RegExp(`^${IDP}/authorize\\?.*code_challenge_method=S256`));
  await page.getByRole("link", { name: "Alec", exact: true }).click();

  const schedule = await scheduleOk;
  expect(schedule.status()).toBe(200);
  expect(await schedule.request().headerValue("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  await page.getByRole("rowheader").first().waitFor();
  expect(page.url()).toBe(`${REDIRECT}?lang=fr`); // code, state et iss retirés
  // Profil (GET /me) : « Bonjour Alec » à droite de l'en-tête ; owner : Réglages et Importer visibles.
  const header = page.getByRole("banner");
  await expect(header.getByText("Bonjour Alec")).toBeVisible();
  await expect(header.getByRole("link", { name: "WNEXT", exact: true })).toBeVisible();
  await expect(header.getByRole("link", { name: "Réglages" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Importer" })).toBeVisible();
  await expect(page.locator(".wn-realtime")).toHaveText("Temps réel : connecté");

  // Temps réel : une allocation créée par un autre client apparaît sans rechargement.
  const today = todayParis();
  const created = await fetch(`${API}/api/v1/allocations`, {
    method: "POST",
    headers: { authorization: `Bearer ${await tokenFor("dev-admin")}`, "content-type": "application/json" },
    body: JSON.stringify({ personId: "1", projectId: "2", startDate: today, endDate: today, load: { mode: "hours", hoursPerDay: 7.25 } }),
  });
  expect(created.status).toBe(201);
  await expect(page.locator('.wn-block[aria-label*="7,25 h"]').first()).toBeAttached({ timeout: 10_000 });

  // Renouvellement avant expiration (jetons de TOKEN_TTL_SEC s) : refresh_token envoyé au fournisseur, puis l'API accepte le nouveau jeton.
  const renewed = await page.waitForRequest((r) => r.url() === `${IDP}/token` && (r.postData() ?? "").includes("grant_type=refresh_token"), { timeout: TOKEN_TTL_SEC * 1000 + 5000 });
  expect((await renewed.response())!.status()).toBe(200);

  // Rechargement : reprise par le refresh_token (sessionStorage), sans repasser par le fournisseur.
  const again = page.waitForResponse((r) => r.url().includes("/api/v1/schedule?"));
  await page.reload();
  expect((await again).status()).toBe(200);
  expect(page.url()).toBe(`${REDIRECT}?lang=fr`);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(["wnext.oidc.refresh"]);

  // Déconnexion (menu utilisateur) : session effacée, retour au portail de connexion.
  await page.getByRole("button", { name: "Menu utilisateur de Alec" }).click();
  await page.getByRole("menuitem", { name: "Déconnexion" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Connexion" })).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);

  // Un membre : « Bonjour Membre », ni Réglages ni Importer, planning en lecture seule.
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("link", { name: "Membre Dev" }).click();
  await expect(page.getByRole("banner").getByText("Bonjour Membre")).toBeVisible();
  await page.getByRole("rowheader").first().waitFor();
  await expect(page.getByRole("banner").getByRole("link", { name: "Réglages" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Importer" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nouveau congé" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Aujourd’hui" })).toBeVisible();
});
