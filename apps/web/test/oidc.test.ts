// OIDC PKCE du navigateur (src/data/oidc.ts) contre un fournisseur simulé en mémoire : PKCE conforme RFC 7636,
// state et nonce vérifiés, URL nettoyée, jeton en mémoire, refresh tournant en sessionStorage, renouvellement avant expiration.
import { describe, expect, it } from "vitest";
import { base64UrlEncode, createOidcSession, OidcError, oidcConfigFromEnv, pkceChallenge, type OidcDeps } from "../src/data/oidc";

const ISSUER = "http://127.0.0.1:3010";
const CONFIG = { issuer: ISSUER, clientId: "wnext-web", redirectUri: "http://localhost:5173/" };
const sha256 = async (d: Uint8Array) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", d as BufferSource));
const b64json = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
const idToken = (claims: Record<string, unknown>) => `${b64json({ alg: "ES256" })}.${b64json(claims)}.sig`;

/** Fournisseur simulé + environnement de navigateur simulé (URL, sessionStorage, minuteurs, horloge). */
function harness(opts: { url?: string; ttl?: number } = {}) {
  const store = new Map<string, string>();
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let clock = 1_000_000;
  let seq = 0; // jetons émis
  let timerSeq = 0;
  const state = {
    url: opts.url ?? "http://localhost:5173/?lang=en",
    navigations: [] as string[],
    tokenCalls: [] as URLSearchParams[],
    lastChallenge: "",
    nonce: "",
    refreshValid: new Set<string>(),
    tokenStatus: 200,
    idClaims: {} as Record<string, unknown>,
  };
  const issue = () => {
    const rt = `rt-${++seq}`;
    state.refreshValid.add(rt);
    return { access_token: `at-${seq}`, token_type: "Bearer", expires_in: opts.ttl ?? 300, refresh_token: rt,
      id_token: idToken({ iss: ISSUER, aud: "wnext-web", sub: "dev-admin", nonce: state.nonce, exp: Math.floor(clock / 1000) + 300, ...state.idClaims }) };
  };
  const deps: OidcDeps = {
    async fetch(url, init) {
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return { status: 200, json: async () => ({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, end_session_endpoint: `${ISSUER}/logout` }) };
      }
      const form = new URLSearchParams(init?.body ?? "");
      state.tokenCalls.push(form);
      if (state.tokenStatus !== 200) return { status: state.tokenStatus, json: async () => ({ error: "server_error" }) };
      if (form.get("grant_type") === "authorization_code") {
        const ok = form.get("code") === "good-code" && base64UrlEncode(await sha256(new TextEncoder().encode(form.get("code_verifier")!))) === state.lastChallenge;
        return ok ? { status: 200, json: async () => issue() } : { status: 400, json: async () => ({ error: "invalid_grant" }) };
      }
      const rt = form.get("refresh_token")!;
      if (!state.refreshValid.delete(rt)) return { status: 400, json: async () => ({ error: "invalid_grant" }) };
      return { status: 200, json: async () => issue() };
    },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    currentUrl: () => state.url,
    replaceUrl: (u) => { state.url = new URL(u, state.url).toString(); },
    navigate: (u) => {
      state.navigations.push(u);
      const q = new URL(u).searchParams;
      if (q.get("code_challenge")) { state.lastChallenge = q.get("code_challenge")!; state.nonce = q.get("nonce")!; }
    },
    randomBytes: (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; },
    sha256,
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++timerSeq; timers.push({ fn, at: clock + ms, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  /** Revient du fournisseur avec un code et le state envoyé (ou un autre). */
  const comeBack = (over: { state?: string; code?: string; iss?: string } = {}) => {
    const sent = new URL(state.navigations.at(-1)!).searchParams;
    const back = new URL(CONFIG.redirectUri);
    back.searchParams.set("code", over.code ?? "good-code");
    back.searchParams.set("state", over.state ?? sent.get("state")!);
    back.searchParams.set("iss", over.iss ?? ISSUER);
    state.url = back.toString();
  };
  return { deps, state, store, comeBack };
}

async function loggedIn(opts: { ttl?: number } = {}) {
  const h = harness(opts);
  const s = createOidcSession(CONFIG, h.deps);
  expect(await s.start()).toBe("redirected");
  h.comeBack();
  const s2 = createOidcSession(CONFIG, h.deps); // nouvelle page après la redirection
  expect(await s2.start()).toBe("authenticated");
  return { h, s: s2 };
}

describe("PKCE (RFC 7636)", () => {
  it("vecteur de test de l'annexe B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", sha256)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("base64url sans remplissage", () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
    expect(base64UrlEncode(new Uint8Array([1]))).toBe("AQ");
  });
});

describe("session OIDC", () => {
  it("sans session : redirection vers authorize avec S256, state, nonce, verifier hors de l'URL ; retour à la page d'origine", async () => {
    const h = harness();
    expect(await createOidcSession(CONFIG, h.deps).start()).toBe("redirected");
    const q = new URL(h.state.navigations[0]!).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ response_type: "code", client_id: "wnext-web", redirect_uri: CONFIG.redirectUri, code_challenge_method: "S256" });
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(22);
    expect(q.get("nonce")).not.toBe(q.get("state"));
    expect(h.state.navigations[0]).not.toContain("code_verifier");
    h.comeBack();
    expect(await createOidcSession(CONFIG, h.deps).start()).toBe("authenticated");
    expect(h.state.url).toBe("http://localhost:5173/?lang=en"); // code, state et iss retirés de l'URL
    expect(h.state.tokenCalls[0]!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("state invalide : rejeté, aucun échange de code, URL nettoyée", async () => {
    const h = harness();
    await createOidcSession(CONFIG, h.deps).start();
    h.comeBack({ state: "forge" });
    await expect(createOidcSession(CONFIG, h.deps).start()).rejects.toMatchObject({ code: "STATE_MISMATCH" });
    expect(h.state.tokenCalls).toHaveLength(0);
    expect(h.state.url).not.toContain("code=");
  });

  it("retour sans connexion en attente (lien rejoué) ou émetteur différent : rejeté", async () => {
    const h = harness({ url: "http://localhost:5173/?code=x&state=y" });
    await expect(createOidcSession(CONFIG, h.deps).start()).rejects.toBeInstanceOf(OidcError);
    const h2 = harness();
    await createOidcSession(CONFIG, h2.deps).start();
    h2.comeBack({ iss: "http://evil.example" });
    await expect(createOidcSession(CONFIG, h2.deps).start()).rejects.toMatchObject({ code: "ISSUER_MISMATCH" });
  });

  it("nonce de l'id_token différent : rejeté", async () => {
    const h = harness();
    await createOidcSession(CONFIG, h.deps).start();
    h.comeBack();
    h.state.idClaims = { nonce: "autre" };
    await expect(createOidcSession(CONFIG, h.deps).start()).rejects.toMatchObject({ code: "ID_TOKEN" });
  });

  it("jeton d'accès en mémoire seulement ; refresh_token en sessionStorage", async () => {
    const { h, s } = await loggedIn();
    expect(await s.getAccessToken()).toBe("at-1");
    const stored = [...h.store.values()].join(" ");
    expect(stored).not.toContain("at-1");
    expect(stored).toContain("rt-1");
  });
});

describe("configuration", () => {
  it("dérive client et redirect_uri par défaut ; émetteur obligatoire", () => {
    expect(oidcConfigFromEnv({ VITE_OIDC_ISSUER: "http://127.0.0.1:3010/" }, "http://localhost:5173")).toEqual(
      { issuer: "http://127.0.0.1:3010", clientId: "wnext-web", redirectUri: "http://localhost:5173/" });
    expect(oidcConfigFromEnv({ VITE_OIDC_ISSUER: "http://i", VITE_OIDC_CLIENT_ID: "c", VITE_OIDC_REDIRECT_URI: "http://localhost:1/cb" }, "x"))
      .toEqual({ issuer: "http://i", clientId: "c", redirectUri: "http://localhost:1/cb" });
    expect(() => oidcConfigFromEnv({}, "http://localhost:5173")).toThrow(/VITE_OIDC_ISSUER/);
  });
});
