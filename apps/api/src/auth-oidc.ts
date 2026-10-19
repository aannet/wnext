import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Db, RequestContext } from "./db";

// Authentification réelle : jeton porteur (JWT signé) émis par un fournisseur d'identité OIDC externe (`users.idp_subject`, ADR-002).
// L'API ne gère ni mot de passe ni session : elle vérifie la signature (clés publiques JWKS du fournisseur), l'émetteur, l'audience et
// l'expiration, puis retrouve l'utilisateur par `sub` et son appartenance au compte demandé (`account_members`, donc son rôle).
// Le jeton prouve QUI ; le compte est choisi par l'en-tête `x-account-id` (ou déduit s'il n'y a qu'une appartenance) et n'est
// accepté que si l'utilisateur en est membre : le rôle vient toujours de la base, jamais du jeton.
// Même signature que devAuthenticate : `authenticate(headers) -> RequestContext | null` (null = 401).
// Limite : un navigateur ne peut pas poser d'en-tête sur un WebSocket ; l'upgrade temps réel depuis le web demandera un mécanisme
// dédié (ticket à usage unique), hors de cette étape.

const MAX_TOKEN_BYTES = 8192;
const ROLES = new Set<RequestContext["role"]>(["owner", "admin", "project_manager", "member", "guest"]);
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export interface Claims {
  sub: string;
}

export interface JwtVerifier {
  /** Claims si le jeton est valide, null sinon. Lève seulement sur une panne d'infrastructure (clés injoignables). */
  verify(token: string): Promise<Claims | null>;
}

/** Fournit la clé publique (JWK) d'un `kid` ; undefined si inconnue. */
export type KeyResolver = (kid: string | undefined) => Promise<JsonWebKey | undefined>;

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  keys: KeyResolver;
  /** Tolérance d'horloge en secondes (défaut 60). */
  clockSkewSec?: number;
  now?: () => number;
}

const b64 = (s: string) => Buffer.from(s, "base64url");
const parseJson = (buf: Buffer): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(buf.toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** RS256 (RSA >= 2048 bits) et ES256 (P-256) seulement : `none` et les algorithmes à secret partagé n'existent pas ici. */
function keyFor(jwk: JsonWebKey, alg: string): KeyObject | null {
  try {
    if (jwk.use !== undefined && jwk.use !== "sig") return null;
    if (alg === "RS256" && jwk.kty === "RSA") {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? key : null;
    }
    if (alg === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") return createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    // clé illisible : refusée
  }
  return null;
}

export function createJwtVerifier(opts: JwtVerifierOptions): JwtVerifier {
  const skew = opts.clockSkewSec ?? 60;
  const now = opts.now ?? (() => Date.now());
  return {
    async verify(token) {
      if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) return null;
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((p) => p === "")) return null;
      const [h, p, s] = parts as [string, string, string];
      const header = parseJson(b64(h));
      const payload = parseJson(b64(p));
      if (!header || !payload) return null;
      const alg = header.alg;
      if (alg !== "RS256" && alg !== "ES256") return null;
      const kid = typeof header.kid === "string" ? header.kid : undefined;
      const jwk = await opts.keys(kid);
      const key = jwk && keyFor(jwk, alg);
      if (!key) return null;
      const sig = b64(s);
      const ok = verify("sha256", Buffer.from(`${h}.${p}`), alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
      if (!ok) return null;

      const t = Math.floor(now() / 1000);
      if (payload.iss !== opts.issuer) return null;
      const aud = payload.aud;
      if (!(aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience)))) return null;
      if (typeof payload.exp !== "number" || t >= payload.exp + skew) return null; // exp obligatoire
      if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || t < payload.nbf - skew)) return null;
      if (typeof payload.sub !== "string" || payload.sub === "" || payload.sub.length > 255) return null;
      return { sub: payload.sub };
    },
  };
}

export interface RemoteJwksOptions {
  url: string;
  fetch?: typeof fetch;
  /** Durée de conservation des clés (défaut 10 min). */
  ttlMs?: number;
  /** Délai minimal entre deux rechargements provoqués par un `kid` inconnu (défaut 30 s) : un jeton forgé ne doit pas marteler le fournisseur. */
  cooldownMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Clés publiques d'un point JWKS, mises en cache. Un `kid` inconnu déclenche un rechargement (rotation des clés), au plus un par cooldown. */
export function remoteJwks(opts: RemoteJwksOptions): KeyResolver {
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? 600_000;
  const cooldown = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  let keys: JsonWebKey[] = [];
  let loadedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const load = () =>
    (inflight ??= (async () => {
      try {
        const res = await doFetch(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`JWKS : HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: unknown };
        if (!Array.isArray(body.keys)) throw new Error("JWKS : champ keys absent");
        keys = body.keys.filter((k): k is JsonWebKey => k !== null && typeof k === "object");
      } finally {
        loadedAt = now(); // y compris en échec : pas de martelage
        inflight = null;
      }
    })());

  const find = (kid: string | undefined) => {
    if (kid !== undefined) return keys.find((k) => (k as { kid?: string }).kid === kid);
    return keys.length === 1 ? keys[0] : undefined;
  };

  return async (kid) => {
    const age = now() - loadedAt;
    if (age >= ttl) {
      try {
        await load();
      } catch (err) {
        if (keys.length === 0) throw err; // aucune clé connue : panne d'infrastructure, pas un jeton invalide
      }
    }
    let k = find(kid);
    if (!k && now() - loadedAt >= cooldown) {
      try {
        await load();
      } catch {
        // on garde les clés connues
      }
      k = find(kid);
    }
    return k;
  };
}

export interface OidcAuthOptions {
  db: Db;
  verifier: JwtVerifier;
}

/** Jeton porteur -> contexte de requête. Toute anomalie (jeton, utilisateur inconnu, compte non choisi ou non autorisé) donne null. */
export function oidcAuthenticate(opts: OidcAuthOptions): (headers: IncomingHttpHeaders) => Promise<RequestContext | null> {
  return async (headers) => {
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(one(headers.authorization) ?? "");
    if (!m) return null;
    const claims = await opts.verifier.verify(m[1]!);
    if (!claims) return null;

    let wanted: string | undefined;
    if (headers["x-account-id"] !== undefined) {
      wanted = one(headers["x-account-id"]);
      if (wanted === undefined || !/^\d{1,18}$/.test(wanted)) return null;
    }

    // Avant de connaître le compte : l'utilisateur (fonction user_id_for_subject, RLS sur users), puis ses seules appartenances (politique own_memberships).
    const found = await opts.db.transaction(async (tx) => {
      const u = await tx.query<{ id: string | null }>("SELECT user_id_for_subject($1)::text AS id", [claims.sub]);
      const userId = u.rows[0]?.id;
      if (!userId) return null;
      await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const r = await tx.query<{ account_id: string; role: string }>("SELECT account_id::text AS account_id, role::text AS role FROM account_members WHERE user_id = $1 ORDER BY account_id", [userId]);
      return { userId, members: r.rows };
    });
    if (!found) return null;

    const member = wanted !== undefined ? found.members.find((r) => r.account_id === wanted) : found.members.length === 1 ? found.members[0] : undefined;
    if (!member || !ROLES.has(member.role as RequestContext["role"])) return null;
    return { accountId: member.account_id, userId: found.userId, role: member.role as RequestContext["role"] };
  };
}
