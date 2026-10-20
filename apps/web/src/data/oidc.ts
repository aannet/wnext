// Connexion OIDC du navigateur : flux « authorization code » avec PKCE S256 (RFC 7636), client public sans secret.
//  1. login() : découverte (.well-known), verifier aléatoire (32 octets) -> challenge S256, `state` (anti-CSRF) et `nonce`
//     (anti-rejeu de l'id_token) aléatoires, mémorisés avec la page d'origine en sessionStorage (il faut qu'ils survivent à la
//     redirection), puis redirection vers authorize. Le verifier ne quitte jamais le navigateur avant l'échange.
//  2. start() au retour : state comparé à celui mémorisé (sinon rejet, sans échange), `iss` de la réponse vérifié s'il est
//     présent (RFC 9207), code échangé contre les jetons, nonce/iss/aud/exp de l'id_token contrôlés, URL nettoyée (plus de
//     `code` ni de `state` dans l'historique) et retour à la page d'origine. La signature de l'id_token n'est pas vérifiée :
//     il arrive directement du point /token (OIDC Core §3.1.3.7) et l'API vérifie, elle, le jeton d'accès à chaque requête.
//  3. Jetons : le jeton d'accès reste EN MÉMOIRE (variable du module, jamais écrit ailleurs) ; le refresh_token est en
//     sessionStorage, et nulle part ailleurs. Raison : un rechargement de l'onglet repart sans aller-retour chez le fournisseur,
//     alors que localStorage le partagerait entre onglets et le garderait après fermeture du navigateur. Un script injecté
//     (XSS) pourrait le lire, mais il pourrait tout autant appeler l'API avec le jeton en mémoire : le vrai rempart reste la CSP.
//     Le fournisseur fait tourner le refresh_token (chaque usage révoque le précédent), ce qui borne un vol. Cible production
//     possible : un BFF avec cookie httpOnly, hors de cette étape.
// Aucune dépendance au navigateur dans la logique : réseau, stockage, URL, aléa, hachage et minuteurs sont injectés (tests).

export interface OidcConfig {
  /** Émetteur, sans barre finale (comparé à celui de la découverte et des jetons). */
  issuer: string;
  clientId: string;
  redirectUri: string;
}

export interface OidcEnv {
  VITE_OIDC_ISSUER?: string;
  VITE_OIDC_CLIENT_ID?: string;
  VITE_OIDC_REDIRECT_URI?: string;
}

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface OidcDeps {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse>;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  currentUrl(): string;
  /** Remplace l'URL affichée sans recharger (history.replaceState). */
  replaceUrl(url: string): void;
  /** Quitte la page (location.assign). */
  navigate(url: string): void;
  randomBytes(n: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type OidcErrorCode = "DISCOVERY" | "NO_PENDING_LOGIN" | "STATE_MISMATCH" | "ISSUER_MISMATCH" | "PROVIDER_ERROR" | "TOKEN_EXCHANGE" | "ID_TOKEN";

export class OidcError extends Error {
  constructor(readonly code: OidcErrorCode, detail?: string) {
    super(detail ? `${code} : ${detail}` : code);
    this.name = "OidcError";
  }
}

export interface OidcSession {
  /** Traite un retour du fournisseur, sinon redirige vers la connexion. */
  start(): Promise<"authenticated" | "redirected">;
  /** Jeton d'accès ; null sans session. */
  getAccessToken(): Promise<string | null>;
  /** Redirige vers le fournisseur (nouvelle connexion). */
  login(): Promise<void>;
}

const PENDING_KEY = "wnext.oidc.pending";
const REFRESH_KEY = "wnext.oidc.refresh";
const CALLBACK_PARAMS = ["code", "state", "iss", "session_state", "error", "error_description", "error_uri"];

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeText(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string, sha256: OidcDeps["sha256"]): Promise<string> {
  return base64UrlEncode(await sha256(new TextEncoder().encode(verifier)));
}

export function oidcConfigFromEnv(env: OidcEnv, origin: string): OidcConfig {
  const issuer = env.VITE_OIDC_ISSUER?.replace(/\/+$/, "");
  if (!issuer) throw new Error("VITE_AUTH_MODE=oidc exige VITE_OIDC_ISSUER");
  return { issuer, clientId: env.VITE_OIDC_CLIENT_ID || "wnext-web", redirectUri: env.VITE_OIDC_REDIRECT_URI || `${origin}/` };
}

/** Dépendances réelles du navigateur. */
export function browserOidcDeps(): OidcDeps {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    storage: globalThis.sessionStorage,
    currentUrl: () => globalThis.location.href,
    replaceUrl: (url) => globalThis.history.replaceState(globalThis.history.state, "", url),
    navigate: (url) => globalThis.location.assign(url),
    randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    sha256: async (d) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", d as BufferSource)),
    now: () => Date.now(),
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer: (h) => globalThis.clearTimeout(h as number),
  };
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

const isTokenResponse = (v: unknown): v is TokenResponse =>
  typeof v === "object" && v !== null && typeof (v as TokenResponse).access_token === "string" && typeof (v as TokenResponse).expires_in === "number";

const formBody = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

export function createOidcSession(config: OidcConfig, deps: OidcDeps): OidcSession {
  let discovery: Promise<Discovery> | null = null;
  let accessToken: string | null = null;

  const discover = () =>
    (discovery ??= (async () => {
      const res = await deps.fetch(`${config.issuer}/.well-known/openid-configuration`, { method: "GET", headers: { accept: "application/json" } });
      const d = (res.status === 200 ? await res.json() : null) as (Discovery & { issuer?: string }) | null;
      if (!d || d.issuer !== config.issuer || typeof d.authorization_endpoint !== "string" || typeof d.token_endpoint !== "string") {
        discovery = null; // réessayable
        throw new OidcError("DISCOVERY", `${config.issuer} (HTTP ${res.status})`);
      }
      return d;
    })());

  const randomString = (n: number) => base64UrlEncode(deps.randomBytes(n));

  const accept = (t: TokenResponse) => {
    accessToken = t.access_token;
    if (t.refresh_token) deps.storage.setItem(REFRESH_KEY, t.refresh_token);
  };

  const postToken = async (fields: Record<string, string>) => {
    const d = await discover();
    const res = await deps.fetch(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formBody({ client_id: config.clientId, ...fields }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const checkIdToken = (idToken: string | undefined, nonce: string) => {
    const payload = idToken?.split(".")[1];
    let claims: { iss?: unknown; aud?: unknown; nonce?: unknown; exp?: unknown } | null = null;
    try {
      claims = payload ? JSON.parse(base64UrlDecodeText(payload)) : null;
    } catch {
      claims = null;
    }
    const aud = claims?.aud;
    const audOk = aud === config.clientId || (Array.isArray(aud) && aud.includes(config.clientId));
    if (!claims || claims.iss !== config.issuer || !audOk || claims.nonce !== nonce || typeof claims.exp !== "number" || claims.exp * 1000 <= deps.now()) {
      throw new OidcError("ID_TOKEN");
    }
  };

  async function login(): Promise<void> {
    const d = await discover();
    const verifier = randomString(32); // 43 caractères (RFC 7636 §4.1 : 43 à 128)
    const pending: Pending = { state: randomString(16), nonce: randomString(16), verifier, returnTo: cleanUrl(deps.currentUrl()) };
    deps.storage.setItem(PENDING_KEY, JSON.stringify(pending));
    const u = new URL(d.authorization_endpoint);
    const q = {
      response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: "openid profile email",
      state: pending.state, nonce: pending.nonce, code_challenge: await pkceChallenge(verifier, deps.sha256), code_challenge_method: "S256",
    };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    deps.navigate(u.toString());
  }

  async function callback(url: URL): Promise<void> {
    const raw = deps.storage.getItem(PENDING_KEY);
    deps.storage.removeItem(PENDING_KEY); // usage unique
    deps.replaceUrl(cleanUrl(url.toString()));
    let pending: Pending | null = null;
    try {
      pending = raw ? (JSON.parse(raw) as Pending) : null;
    } catch {
      pending = null;
    }
    if (!pending) throw new OidcError("NO_PENDING_LOGIN");
    if (url.searchParams.get("state") !== pending.state) throw new OidcError("STATE_MISMATCH");
    const iss = url.searchParams.get("iss");
    if (iss !== null && iss !== config.issuer) throw new OidcError("ISSUER_MISMATCH");
    const error = url.searchParams.get("error");
    if (error) throw new OidcError("PROVIDER_ERROR", error);
    const r = await postToken({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: config.redirectUri, code_verifier: pending.verifier });
    if (r.status !== 200 || !isTokenResponse(r.body)) throw new OidcError("TOKEN_EXCHANGE", `HTTP ${r.status}`);
    checkIdToken(r.body.id_token, pending.nonce);
    accept(r.body);
    deps.replaceUrl(pending.returnTo);
  }

  return {
    async start() {
      const url = new URL(deps.currentUrl());
      if (url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error"))) {
        await callback(url);
        return "authenticated";
      }
      await login();
      return "redirected";
    },
    async getAccessToken() {
      return accessToken;
    },
    login,
  };
}

/** URL relative (chemin, requête, ancre) sans les paramètres de retour du fournisseur. */
function cleanUrl(href: string): string {
  const u = new URL(href);
  for (const p of CALLBACK_PARAMS) u.searchParams.delete(p);
  return u.pathname + u.search + u.hash;
}
