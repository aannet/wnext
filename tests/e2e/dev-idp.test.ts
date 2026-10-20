// Fournisseur OIDC local (scripts/dev-idp.mjs) : découverte, PKCE S256 obligatoire, code à usage unique, refresh tournant,
// et jetons acceptés par le vérificateur réel de l'API (apps/api/src/auth-oidc.ts) via son JWKS.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJwtVerifier, remoteJwks } from "../../apps/api/src/auth-oidc";
// @ts-expect-error module JS sans types
import { createDevIdp, startDevIdp } from "../../scripts/dev-idp.mjs";

const CLIENT = "wnext-web";
const REDIRECT = "http://localhost:5173/";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636, annexe B
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let idp: { url: string; close(): Promise<void> };
beforeAll(async () => { idp = await startDevIdp({ port: 0 }); });
afterAll(async () => { await idp?.close(); });

const authorizeUrl = (over: Record<string, string | undefined> = {}) => {
  const p: Record<string, string | undefined> = {
    response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, scope: "openid", state: "st-1", nonce: "n-1",
    code_challenge: CHALLENGE, code_challenge_method: "S256", login_hint: "dev-admin", ...over,
  };
  const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => e[1] !== undefined));
  return `${idp.url}/authorize?${q}`;
};

async function authorize(over: Record<string, string | undefined> = {}) {
  const res = await fetch(authorizeUrl(over), { redirect: "manual" });
  return { res, location: res.headers.get("location") };
}

async function codeFor(over: Record<string, string | undefined> = {}) {
  const { res, location } = await authorize(over);
  expect(res.status).toBe(302);
  const back = new URL(location!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe(over.state ?? "st-1");
  return back.searchParams.get("code")!;
}

const token = (form: Record<string, string>) =>
  fetch(`${idp.url}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:5173" }, body: new URLSearchParams(form) });

const exchange = (code: string, verifier = VERIFIER) =>
  token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier });

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));

describe("fournisseur OIDC de développement", () => {
  it("refuse de démarrer en production", () => {
    expect(() => createDevIdp({ issuer: "http://127.0.0.1:1", env: { NODE_ENV: "production" } })).toThrow(/production/);
  });

  it("publie sa découverte : S256 seulement, client public, ES256", async () => {
    const res = await fetch(`${idp.url}/.well-known/openid-configuration`);
    const d = await res.json();
    expect(d).toMatchObject({
      issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/jwks`,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], id_token_signing_alg_values_supported: ["ES256"],
    });
  });

  it("sans login_hint : page de choix des utilisateurs du jeu d'essai (liens d'auto-connexion)", async () => {
    const { res } = await authorize({ login_hint: undefined });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Admin Dev");
    expect(html).toContain("Membre Dev");
    expect(html).toContain("login_hint=dev-member");
  });

  it("parcours complet : code, échange PKCE, jetons vérifiés par l'API, nonce dans l'id_token, CORS", async () => {
    const res = await exchange(await codeFor());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 300 });
    const verifier = createJwtVerifier({ issuer: idp.url, audience: "wnext-api", keys: remoteJwks({ url: `${idp.url}/jwks` }) });
    expect(await verifier.verify(body.access_token)).toEqual({ sub: "dev-admin" });
    const at = claims(body.access_token);
    expect(at.exp - at.iat).toBe(300);
    expect(claims(body.id_token)).toMatchObject({ iss: idp.url, aud: CLIENT, sub: "dev-admin", nonce: "n-1", name: "Admin Dev" });
  });

  it("PKCE faux, absent ou plain : refusé", async () => {
    expect((await exchange(await codeFor(), "x".repeat(43))).status).toBe(400);
    const r = await exchange(await codeFor(), "x".repeat(43));
    expect(await r.json()).toEqual({ error: "invalid_grant" });
    expect((await authorize({ code_challenge: undefined })).location).toContain("error=invalid_request");
    expect((await authorize({ code_challenge_method: "plain" })).location).toContain("error=invalid_request");
  });

  it("code à usage unique, lié au redirect_uri et au client", async () => {
    const code = await codeFor();
    expect((await exchange(code)).status).toBe(200);
    expect((await exchange(code)).status).toBe(400);
    const other = await codeFor();
    const r = await token({ grant_type: "authorization_code", code: other, redirect_uri: "http://localhost:5173/autre", client_id: CLIENT, code_verifier: VERIFIER });
    expect(r.status).toBe(400);
  });

  it("client ou redirect_uri inconnus : aucune redirection (pas de redirection ouverte)", async () => {
    expect((await authorize({ client_id: "inconnu" })).res.status).toBe(400);
    expect((await authorize({ redirect_uri: "https://attaquant.example/" })).res.status).toBe(400);
  });

  it("login_hint inconnu : erreur renvoyée au client (access_denied), state conservé", async () => {
    const { location } = await authorize({ login_hint: "personne" });
    const u = new URL(location!);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("st-1");
  });

  it("refresh_token tournant : le nouveau marche, l'ancien est révoqué", async () => {
    const first = await (await exchange(await codeFor())).json();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT });
    expect(r1.status).toBe(200);
    const second = await r1.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(claims(second.access_token).sub).toBe("dev-admin");
    expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT })).status).toBe(400);
  });

  it("préflight CORS du point /token pour une origine locale ; origine distante refusée", async () => {
    const ok = await fetch(`${idp.url}/token`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5183", "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5183");
    const ko = await fetch(`${idp.url}/token`, { method: "OPTIONS", headers: { origin: "https://attaquant.example" } });
    expect(ko.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("déconnexion : retour vers une adresse locale seulement", async () => {
    const ok = await fetch(`${idp.url}/logout?post_logout_redirect_uri=${encodeURIComponent(REDIRECT)}`, { redirect: "manual" });
    expect([ok.status, ok.headers.get("location")]).toEqual([302, REDIRECT]);
    const ko = await fetch(`${idp.url}/logout?post_logout_redirect_uri=${encodeURIComponent("https://attaquant.example/")}`, { redirect: "manual" });
    expect(ko.status).toBe(400);
  });

  it("jetons courts configurables (tests de renouvellement)", async () => {
    const short = await startDevIdp({ port: 0, tokenTtlSec: 5 });
    try {
      const code = new URL((await fetch(authorizeUrl().replace(idp.url, short.url), { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;
      const r = await fetch(`${short.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER }) });
      expect((await r.json()).expires_in).toBe(5);
    } finally {
      await short.close();
    }
  });
});
