// Configuration lue dans l'environnement, validée au démarrage : une valeur absente ou invalide arrête le processus
// avec un message clair plutôt que de produire un comportement imprévu plus tard.

export interface Config {
  databaseUrl: string;
  /** Rôle de bascule (SET LOCAL ROLE) ; absent = la connexion est déjà `app_user`. */
  dbRole?: string;
  host: string;
  port: number;
  /** `dev` : identité lue dans des en-têtes, sans preuve (interdit en production). `oidc` : jeton porteur d'un fournisseur OIDC. */
  authMode: "dev" | "oidc";
  /** Présent si et seulement si `authMode` = `oidc`. */
  oidc?: { issuer: string; audience: string; jwksUrl: string };
  pollIntervalMs: number;
  /** Connexions WebSocket simultanées par compte. */
  wsMaxPerAccount: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL est requis");
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} doit être un entier entre ${min} et ${max}`);
    return Number(raw);
  };
  const authMode = env.AUTH_MODE ?? "dev";
  if (authMode !== "dev" && authMode !== "oidc") throw new Error(`AUTH_MODE inconnu : ${authMode} (dev ou oidc)`);
  if (authMode === "dev" && env.NODE_ENV === "production") throw new Error("AUTH_MODE=dev est interdit en production : utiliser AUTH_MODE=oidc");
  let oidc: Config["oidc"];
  if (authMode === "oidc") {
    const issuer = env.OIDC_ISSUER;
    const audience = env.OIDC_AUDIENCE;
    const jwksUrl = env.OIDC_JWKS_URL;
    if (!issuer || !audience || !jwksUrl) throw new Error("AUTH_MODE=oidc exige OIDC_ISSUER, OIDC_AUDIENCE et OIDC_JWKS_URL");
    if (!/^https?:\/\//.test(jwksUrl)) throw new Error("OIDC_JWKS_URL doit être une URL http(s)");
    if (env.NODE_ENV === "production" && !jwksUrl.startsWith("https://")) throw new Error("OIDC_JWKS_URL doit être en https en production");
    oidc = { issuer, audience, jwksUrl };
  }
  const dbRole = env.DB_ROLE || undefined;
  if (dbRole !== undefined && !/^[a-z_][a-z0-9_]*$/.test(dbRole)) throw new Error("DB_ROLE invalide");
  return {
    databaseUrl,
    dbRole,
    host: env.HOST || "127.0.0.1",
    port: int("PORT", 3000, 0, 65535),
    authMode,
    oidc,
    pollIntervalMs: int("POLL_INTERVAL_MS", 1000, 50, 60_000),
    wsMaxPerAccount: int("WS_MAX_PER_ACCOUNT", 200, 1, 100_000),
  };
}
