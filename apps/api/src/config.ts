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
  /** Secret des tickets d'upgrade WebSocket ; absent = aléatoire par processus (interdit en production : les instances doivent le partager). */
  wsTicketSecret?: string;
  /** Limites de débit (fenêtre glissante, par processus) ; une valeur 0 désactive la limite correspondante. */
  rateLimits: RateLimitConfig;
}

export interface RateLimitConfig {
  /** Durée de la fenêtre glissante, en secondes. */
  windowSeconds: number;
  /** Tickets d'upgrade délivrés par utilisateur et par fenêtre (POST /realtime/ticket). */
  ticketsPerUser: number;
  /** Tickets délivrés par compte et par fenêtre. */
  ticketsPerAccount: number;
  /** Tentatives de connexion WebSocket (upgrades authentifiés) par compte et par fenêtre. */
  upgradesPerAccount: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = { windowSeconds: 60, ticketsPerUser: 30, ticketsPerAccount: 300, upgradesPerAccount: 120 };

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
  const wsTicketSecret = env.WS_TICKET_SECRET || undefined;
  if (wsTicketSecret !== undefined && wsTicketSecret.length < 32) throw new Error("WS_TICKET_SECRET doit faire 32 caractères au moins");
  if (wsTicketSecret === undefined && env.NODE_ENV === "production") throw new Error("WS_TICKET_SECRET est requis en production (partagé entre les instances)");
  return {
    databaseUrl,
    dbRole,
    host: env.HOST || "127.0.0.1",
    port: int("PORT", 3000, 0, 65535),
    authMode,
    oidc,
    pollIntervalMs: int("POLL_INTERVAL_MS", 1000, 50, 60_000),
    wsMaxPerAccount: int("WS_MAX_PER_ACCOUNT", 200, 1, 100_000),
    wsTicketSecret,
    rateLimits: {
      windowSeconds: int("RATE_LIMIT_WINDOW_SECONDS", DEFAULT_RATE_LIMITS.windowSeconds, 1, 3600),
      ticketsPerUser: int("TICKET_RATE_PER_USER", DEFAULT_RATE_LIMITS.ticketsPerUser, 0, 1_000_000),
      ticketsPerAccount: int("TICKET_RATE_PER_ACCOUNT", DEFAULT_RATE_LIMITS.ticketsPerAccount, 0, 1_000_000),
      upgradesPerAccount: int("WS_UPGRADE_RATE_PER_ACCOUNT", DEFAULT_RATE_LIMITS.upgradesPerAccount, 0, 1_000_000),
    },
  };
}
