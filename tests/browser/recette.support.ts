// Outils de la pré-recette (recette.spec.ts) : connexion à l'IdP local par l'interface, jetons d'API (même flux PKCE par login_hint),
// dates relatives au lundi de la semaine du semis (S0), navigation dans la grille et lecture des blocs.
import { createHash, randomBytes } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { RECETTE_PORTS } from "./playwright.recette.config";

export const WEB = `http://127.0.0.1:${RECETTE_PORTS.web}`;
export const API = `http://127.0.0.1:${RECETTE_PORTS.api}/api/v1`;
const IDP = `http://127.0.0.1:${RECETTE_PORTS.idp}`;

/** Comptes de scripts/seed-recette.mjs : nom affiché par l'IdP, sujet OIDC. */
export const USERS = {
  alec: { name: "Alec", subject: "dev-alec" },
  admin: { name: "Admin Recette", subject: "recette-admin" },
  camille: { name: "Camille Roy", subject: "recette-camille" },
  nadia: { name: "Nadia Benali", subject: "recette-nadia" },
  invite: { name: "Invité Recette", subject: "recette-invite" },
  autre: { name: "Admin Autre Société", subject: "recette-autre" },
} as const;
export type Who = keyof typeof USERS;

/** Ouvre l'application, passe par le portail de connexion et le choix de l'IdP local ; attend le Planning. */
export async function login(page: Page, who: Who, path = "/") {
  await page.goto(`${WEB}${path}${path.includes("?") ? "&" : "?"}lang=fr`);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("link", { name: USERS[who].name, exact: true }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}
export async function loginPlanning(page: Page, who: Who) {
  await login(page, who);
  await page.getByRole("grid").waitFor();
  await page.getByRole("rowheader").first().waitFor();
}

export async function token(who: Who): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: "wnext-web", redirect_uri: `${WEB}/`, state: "s", nonce: "n", login_hint: USERS[who].subject,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const back = await fetch(`${IDP}/authorize?${q}`, { redirect: "manual" });
  const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
  const res = await fetch(`${IDP}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${WEB}/`, client_id: "wnext-web", code_verifier: verifier }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Appel d'API au nom d'un compte de recette (vérifications et remises en état hors interface). */
export async function api(who: Who, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(who)}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, etag: res.headers.get("etag") };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Lundi de la semaine du semis (S0) : `current_date` de PostgreSQL, ici la date locale de la machine. */
export function mondayS0(now = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}
/** Jour décalé de `n` jours depuis le lundi S0 : day(14) = lundi S+2. */
export const day = (n: number) => iso(new Date(Date.parse(`${mondayS0()}T00:00:00Z`) + n * 864e5));
const FMT = new Intl.DateTimeFormat("fr", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** Date telle que les libellés de l'écran l'écrivent : « lun. 2 nov. ». */
export const fr = (isoDate: string) => FMT.format(new Date(`${isoDate}T00:00:00Z`));

export const rowOf = (page: Page, name: string) => page.locator(".wn-row[data-person]").filter({ has: page.locator(".wn-person-name", { hasText: new RegExp(`^${name}$`) }) });
export const blocksOf = (row: Locator) => row.locator(".wn-block[data-key]:visible");

/** Largeur d'un jour en px (zoom Jour). */
export const pxPerDay = (page: Page) => page.evaluate(() => {
  const xs = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')].map((e) => e.getBoundingClientRect().left).sort((a, b) => a - b);
  return xs[1]! - xs[0]!;
});

/** Zoom Jour : fait défiler la grille pour que le jour `target` soit la première colonne visible. */
export async function showDay(page: Page, target: string, column = 0) {
  for (let i = 0; i < 4; i++) {
    const moved = await page.evaluate(({ target, column }) => {
      const grid = document.querySelector<HTMLElement>('[role="grid"]')!;
      const g = grid.getBoundingClientRect();
      const heads = [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')]
        .map((e) => ({ from: e.dataset.from!, left: e.getBoundingClientRect().left })).sort((a, b) => a.left - b.left);
      const ppd = heads[1]!.left - heads[0]!.left;
      const gutter = 240;
      const want = g.left + gutter + column * ppd;
      const t = heads.find((h) => h.from === target);
      const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
      const dx = t ? t.left - want : days(target, heads[0]!.from) * ppd + (heads[0]!.left - want);
      if (Math.abs(dx) < 2) return false;
      grid.scrollLeft += dx;
      return true;
    }, { target, column });
    await settleGrid(page);
    if (!moved) return;
  }
}

/** Attend deux images puis laisse finir l'animation douce de la grille. */
export const settleGrid = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 450)))));

/** Amène la ligne d'une personne dans la vue par la palette Ctrl+K (RT-038). */
export async function showPerson(page: Page, name: string) {
  await page.getByRole("grid").focus();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Rechercher" });
  await palette.getByRole("combobox", { name: "Rechercher une personne ou un projet" }).fill(name);
  await palette.getByRole("option", { name: new RegExp(`^${name}`) }).first().click();
  await expect(palette).toHaveCount(0);
  await settleGrid(page);
}

/** Dates de début des colonnes d'en-tête visibles (zoom Semaine : le premier jour de chaque semaine), de gauche à droite. */
export const visibleDayHeaders = (page: Page): Promise<string[]> => page.evaluate(() => {
  const g = document.querySelector('[role="grid"]')!.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>('[role="columnheader"][data-from]')]
    .map((e) => ({ from: e.dataset.from!, r: e.getBoundingClientRect() })).filter(({ r }) => r.right > g.left + 240 && r.left < g.right)
    .sort((a, b) => a.r.left - b.r.left).map((h) => h.from);
});
