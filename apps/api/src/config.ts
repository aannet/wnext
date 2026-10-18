// Configuration lue dans l'environnement, validée au démarrage : une valeur absente ou invalide arrête le processus
// avec un message clair plutôt que de produire un comportement imprévu plus tard.

export interface Config {
  databaseUrl: string;
  /** Rôle de bascule (SET LOCAL ROLE) ; absent = la connexion est déjà `app_user`. */
  dbRole?: string;
  host: string;
  port: number;
  /** Seul mode actuel : `dev` (identité lue dans des en-têtes). Le mécanisme réel est une décision ouverte. */
  authMode: "dev";
  pollIntervalMs: number;
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
  if (authMode !== "dev") throw new Error(`AUTH_MODE inconnu : ${authMode} (seul « dev » existe)`);
  if (env.NODE_ENV === "production") throw new Error("AUTH_MODE=dev est interdit en production : l'authentification réelle n'est pas encore implémentée");
  const dbRole = env.DB_ROLE || undefined;
  if (dbRole !== undefined && !/^[a-z_][a-z0-9_]*$/.test(dbRole)) throw new Error("DB_ROLE invalide");
  return {
    databaseUrl,
    dbRole,
    host: env.HOST || "127.0.0.1",
    port: int("PORT", 3000, 0, 65535),
    authMode,
    pollIntervalMs: int("POLL_INTERVAL_MS", 1000, 50, 60_000),
  };
}
