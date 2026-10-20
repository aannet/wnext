// Parcours complet contre `dev:stack --oidc` (configuration playwright.oidc.config.ts) : redirection vers le fournisseur,
// choix de l'utilisateur, retour avec URL nettoyée, GET /schedule 200 avec jeton porteur, temps réel connecté et reçu,
// renouvellement du jeton avant expiration, reprise après rechargement sans redirection, déconnexion.
import { createHash, randomBytes } from "node:crypto";
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
  await expect(page).toHaveURL(new RegExp(`^${IDP}/authorize\\?.*code_challenge_method=S256`));
  await page.getByRole("link", { name: "Admin Dev" }).click();

  const schedule = await scheduleOk;
  expect(schedule.status()).toBe(200);
  expect(await schedule.request().headerValue("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  await page.getByRole("rowheader").first().waitFor();
  expect(page.url()).toBe(`${REDIRECT}?lang=fr`); // code, state et iss retirés
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

  // Déconnexion : session effacée, retour à l'écran qui redemande une connexion.
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(new RegExp(`^${IDP}/authorize`));
  await expect(page.getByRole("link", { name: "Membre Dev" })).toBeVisible();
});
