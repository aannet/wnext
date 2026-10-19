// Point UNIQUE d'authentification des appels HTTP de l'écran : tout passe par ce fetch, injecté dans createClient.
//  * Aujourd'hui (AUTH_MODE=dev de l'API) : ajoute les en-têtes x-dev-account-id / x-dev-user-id / x-dev-role lus dans
//    les variables VITE_DEV_* (apps/web/.env.development, cohérent avec le jeu d'essai de `npm run dev:stack`).
//    Aucune preuve : développement local seulement.
//  * Plus tard (AUTH_MODE=oidc) : c'est ici que se branchera l'OIDC PKCE (redirection vers le fournisseur, échange du code,
//    renouvellement du jeton) pour poser `Authorization: Bearer <jwt>` et, si besoin, `x-account-id`. Le reste de l'écran
//    (source de données, temps réel via ticket) ne change pas.
// Variables absentes : requête envoyée sans identité, l'API répond 401 (affiché comme UNAUTHENTICATED).
import type { Fetcher } from "../api/client.gen";

export interface DevAuthEnv {
  VITE_DEV_ACCOUNT_ID?: string;
  VITE_DEV_USER_ID?: string;
  VITE_DEV_ROLE?: string;
}

/** En-têtes d'identité de développement ; vide si une variable manque. */
export function devAuthHeaders(env: DevAuthEnv): Record<string, string> {
  const { VITE_DEV_ACCOUNT_ID: account, VITE_DEV_USER_ID: user, VITE_DEV_ROLE: role } = env;
  if (!account || !user || !role) return {};
  return { "x-dev-account-id": account, "x-dev-user-id": user, "x-dev-role": role };
}

/** Enveloppe `base` (fetch du navigateur par défaut) en ajoutant l'identité à chaque requête. */
export function createAuthFetch(env: DevAuthEnv, base: Fetcher = (url, init) => globalThis.fetch(url, init)): Fetcher {
  const auth = devAuthHeaders(env);
  return (url, init) => base(url, { ...init, headers: { ...init.headers, ...auth } });
}
