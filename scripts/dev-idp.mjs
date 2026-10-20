#!/usr/bin/env node
// Fournisseur OIDC LOCAL de développement : `node scripts/dev-idp.mjs` (port WNEXT_DEV_IDP_PORT, défaut 3010), ou démarré
// par `npm run dev:stack -- --oidc`. Aucune dépendance : node:http + node:crypto (ES256, JWK publiée sur /jwks).
//  * /.well-known/openid-configuration : découverte (émetteur = URL d'écoute).
//  * /authorize : flux code seul, PKCE S256 OBLIGATOIRE (plain refusé). Sans `login_hint` : page de choix parmi les
//    utilisateurs du jeu d'essai (DEV_USERS de scripts/dev-seed.mjs) ; avec `login_hint` (sujet ou e-mail) : connexion
//    immédiate, pour les tests. Aucun mot de passe : n'importe qui sur la machine se connecte sous n'importe quel utilisateur.
//  * /token : `authorization_code` (code à usage unique, 60 s, lié au client, au redirect_uri et au challenge) et
//    `refresh_token` (tournant : chaque usage révoque l'ancien). Client public, pas de secret (`token_endpoint_auth_method` none).
//  * /jwks : clé publique. La paire de clés est régénérée à chaque démarrage (les jetons d'un démarrage précédent sont refusés).
//  * /logout : redirige vers `post_logout_redirect_uri` (même contrôle que redirect_uri).
// Jetons : jeton d'accès JWT (iss, aud = audience de l'API, sub = users.idp_subject, iat, exp courts, 5 min par défaut) et
// id_token (aud = client, nonce). redirect_uri et CORS acceptés seulement en http sur une adresse de bouclage (localhost,
// 127.0.0.1, [::1]), quel que soit le port (RFC 8252 §7.3) : pas de redirection ouverte. Refuse NODE_ENV=production.
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DEV_USERS } from "./dev-seed.mjs";

const CODE_TTL_MS = 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 §4.1

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const randomToken = () => b64url(randomBytes(32));

function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname) && u.username === "" && u.password === "" && u.hash === "";
  } catch {
    return false;
  }
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Crée le fournisseur (sans écouter). `issuer` : URL publique sans barre finale. Options : audience (défaut wnext-api),
 * clientId (défaut wnext-web), users (défaut DEV_USERS), tokenTtlSec (défaut 300), refreshTtlSec (défaut 8 h), now, env.
 */
export function createDevIdp(opts) {
  const env = opts.env ?? process.env;
  if (env.NODE_ENV === "production") throw new Error("dev-idp : fournisseur de développement, interdit en production");
  const issuer = opts.issuer;
  const audience = opts.audience ?? "wnext-api";
  const clientId = opts.clientId ?? "wnext-web";
  const users = opts.users ?? DEV_USERS;
  const tokenTtl = opts.tokenTtlSec ?? 300;
  const refreshTtlMs = (opts.refreshTtlSec ?? 8 * 3600) * 1000;
  const now = opts.now ?? Date.now;

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = b64url(randomBytes(8));
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" };

  /** code -> { sub, redirectUri, challenge, nonce, expiresAt } ; refresh -> { sub, expiresAt } */
  const codes = new Map();
  const refreshes = new Map();

  const jwt = (payload) => {
    const h = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
    const p = b64url(JSON.stringify(payload));
    const s = sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${h}.${p}.${b64url(s)}`;
  };

  const issueTokens = (user, nonce) => {
    const iat = Math.floor(now() / 1000);
    const exp = iat + tokenTtl;
    const refresh = randomToken();
    refreshes.set(refresh, { sub: user.subject, expiresAt: now() + refreshTtlMs });
    const idClaims = { iss: issuer, aud: clientId, sub: user.subject, iat, exp, email: user.email, name: user.name };
    if (nonce) idClaims.nonce = nonce;
    return {
      access_token: jwt({ iss: issuer, aud: audience, sub: user.subject, iat, exp, client_id: clientId, scope: "openid profile email" }),
      token_type: "Bearer",
      expires_in: tokenTtl,
      refresh_token: refresh,
      id_token: jwt(idClaims),
      scope: "openid profile email",
    };
  };

  const findUser = (hint) => users.find((u) => u.subject === hint || u.email === hint);

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== "string";
    res.writeHead(status, {
      "content-type": isJson ? "application/json" : "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const redirect = (res, url) => { res.writeHead(302, { location: url, "cache-control": "no-store" }); res.end(); };

  const cors = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !isLoopbackUrl(origin)) return {};
    return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", vary: "origin" };
  };

  function authorize(req, res, q) {
    // Client et redirect_uri vérifiés AVANT toute redirection : une erreur ici s'affiche, elle ne part pas vers une URL douteuse.
    const redirectUri = q.get("redirect_uri") ?? "";
    if (q.get("client_id") !== clientId || !isLoopbackUrl(redirectUri)) return send(res, 400, "<!doctype html><p>client_id ou redirect_uri invalide</p>");
    const back = (params) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
      return redirect(res, u.toString());
    };
    const state = q.get("state") ?? undefined;
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type", state });
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back({ error: "invalid_request", error_description: "PKCE S256 obligatoire", state });
    }
    const hint = q.get("login_hint");
    if (!hint) {
      const items = users.map((u) => {
        const link = new URLSearchParams(q);
        link.set("login_hint", u.subject);
        return `<li><a href="/authorize?${escapeHtml(link.toString())}">${escapeHtml(u.name)}</a> <small>${escapeHtml(u.email)} (${escapeHtml(u.role ?? "")})</small></li>`;
      });
      return send(res, 200, `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Connexion locale WNEXT</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto"><h1>Connexion locale (développement)</h1>
<p>Choisir un utilisateur du jeu d'essai :</p><ul>${items.join("")}</ul></body></html>`);
    }
    const user = findUser(hint);
    if (!user) return back({ error: "access_denied", error_description: "utilisateur inconnu", state });
    const code = randomToken();
    codes.set(code, { sub: user.subject, redirectUri, challenge, nonce: q.get("nonce") ?? undefined, expiresAt: now() + CODE_TTL_MS });
    return back({ code, state, iss: issuer });
  }

  function token(req, res, form) {
    const headers = cors(req);
    const fail = (error, status = 400) => send(res, status, { error }, headers);
    if (form.get("client_id") !== clientId) return fail("invalid_client", 401);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const entry = codes.get(code);
      codes.delete(code); // usage unique, y compris en cas d'échec
      const verifier = form.get("code_verifier") ?? "";
      if (!entry || entry.expiresAt <= now() || entry.redirectUri !== form.get("redirect_uri")) return fail("invalid_grant");
      if (!VERIFIER_RE.test(verifier)) return fail("invalid_grant");
      const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
      if (!sameText(computed, entry.challenge)) return fail("invalid_grant");
      const user = findUser(entry.sub);
      if (!user) return fail("invalid_grant");
      return send(res, 200, issueTokens(user, entry.nonce), headers);
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      const entry = refreshes.get(rt);
      refreshes.delete(rt); // rotation : l'ancien ne resservira pas
      const user = entry && entry.expiresAt > now() ? findUser(entry.sub) : undefined;
      if (!user) return fail("invalid_grant");
      return send(res, 200, issueTokens(user, undefined), headers);
    }
    return fail("unsupported_grant_type");
  }

  /** Gestionnaire node:http. */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", issuer);
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors(req));
        return res.end();
      }
      if (req.method === "GET" && path === "/.well-known/openid-configuration") {
        return send(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["openid", "profile", "email"],
          authorization_response_iss_parameter_supported: true,
        }, cors(req));
      }
      if (req.method === "GET" && path === "/jwks") return send(res, 200, { keys: [jwk] }, cors(req));
      if (req.method === "GET" && path === "/authorize") return authorize(req, res, url.searchParams);
      if (req.method === "GET" && path === "/logout") {
        const target = url.searchParams.get("post_logout_redirect_uri") ?? "";
        if (!isLoopbackUrl(target)) return send(res, 400, "<!doctype html><p>post_logout_redirect_uri invalide</p>");
        return redirect(res, target);
      }
      if (req.method === "POST" && path === "/token") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 16_384) return send(res, 413, { error: "invalid_request" }, cors(req));
        }
        return token(req, res, new URLSearchParams(raw));
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      return send(res, 500, { error: "server_error", error_description: err instanceof Error ? err.message : String(err) });
    }
  }

  return { issuer, audience, clientId, handle, jwks: () => ({ keys: [jwk] }) };
}

/** Écoute sur host:port (port 0 = libre) ; l'émetteur est l'URL d'écoute. Rend { url, issuer, audience, clientId, close() }. */
export async function startDevIdp({ host = "127.0.0.1", port = 3010, ...rest } = {}) {
  let idp = null;
  const server = createServer((req, res) => void idp.handle(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const addr = server.address();
  const url = `http://${host}:${addr.port}`;
  try {
    idp = createDevIdp({ issuer: url, ...rest });
  } catch (err) {
    server.close();
    throw err;
  }
  return {
    url,
    issuer: url,
    audience: idp.audience,
    clientId: idp.clientId,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ttl = process.env.WNEXT_DEV_IDP_TOKEN_TTL ? Number(process.env.WNEXT_DEV_IDP_TOKEN_TTL) : undefined;
  const idp = await startDevIdp({ port: Number(process.env.WNEXT_DEV_IDP_PORT ?? 3010), tokenTtlSec: ttl });
  console.log(`fournisseur OIDC de développement : ${idp.url} (client ${idp.clientId}, audience ${idp.audience})`);
  const stop = () => void idp.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
