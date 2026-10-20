// Point UNIQUE d'authentification des appels HTTP de l'écran : tout passe par ce fetch, injecté dans createClient
// (REST et demande de ticket du temps réel, donc le WebSocket aussi). L'identité vient d'un fournisseur d'en-têtes
// asynchrone, choisi par VITE_AUTH_MODE dans main.tsx :
//  * `dev` (AUTH_MODE=dev de l'API) : en-têtes x-dev-account-id / x-dev-user-id / x-dev-role lus dans les variables
//    VITE_DEV_* (apps/web/.env.development, cohérentes avec le jeu d'essai de `npm run dev:stack`). Aucune preuve :
//    développement local seulement. Variables absentes : requête sans identité, l'API répond 401 (UNAUTHENTICATED).
//  * `oidc` (AUTH_MODE=oidc) : `Authorization: Bearer <jeton d'accès>` de la session OIDC PKCE (src/data/oidc.ts). Le compte
//    est déduit par l'API (adhésion unique) ; `x-account-id` viendra avec le choix de compte.
// Sur 401, le fournisseur peut tenter UNE récupération (OIDC : refresh) ; si elle réussit la requête est rejouée une fois,
// sinon la réponse 401 est rendue telle quelle (et la session OIDC part vers une nouvelle connexion). Jamais de boucle.
import type { Fetcher } from "../api/client.gen";
import type { OidcSession } from "./oidc";

export interface AuthProvider {
  /** En-têtes d'identité à ajouter à chaque requête (vides = anonyme). */
  headers(): Promise<Record<string, string>>;
  /** Appelé sur un 401 : true si une nouvelle tentative a des chances d'aboutir. */
  onUnauthorized?(): Promise<boolean>;
}

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

export function devAuthProvider(env: DevAuthEnv): AuthProvider {
  const auth = devAuthHeaders(env);
  return { headers: async () => auth };
}

/** Jeton porteur de la session ; sur 401 : refresh, et à défaut nouvelle connexion (redirection). */
export function oidcAuthProvider(session: Pick<OidcSession, "getAccessToken" | "refresh" | "login">): AuthProvider {
  return {
    async headers(): Promise<Record<string, string>> {
      const token = await session.getAccessToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    async onUnauthorized() {
      if (await session.refresh()) return true;
      await session.login();
      return false;
    },
  };
}

/** Enveloppe `base` (fetch du navigateur par défaut) en ajoutant l'identité à chaque requête. */
export function createAuthFetch(provider: AuthProvider, base: Fetcher = (url, init) => globalThis.fetch(url, init)): Fetcher {
  const send: Fetcher = async (url, init) => base(url, { ...init, headers: { ...init.headers, ...(await provider.headers()) } });
  return async (url, init) => {
    const res = await send(url, init);
    if (res.status !== 401 || !provider.onUnauthorized || !(await provider.onUnauthorized())) return res;
    return send(url, init);
  };
}
