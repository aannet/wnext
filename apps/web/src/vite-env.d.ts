/// <reference types="vite/client" />

// Variables d'environnement lues par l'écran (apps/web/.env.development) ; voir src/data/auth-fetch.ts et src/data/oidc.ts.
interface ImportMetaEnv {
  /** `dev` (défaut) : en-têtes x-dev-* ; `oidc` : connexion OIDC PKCE. */
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_DEV_ACCOUNT_ID?: string;
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEV_ROLE?: string;
  readonly VITE_OIDC_ISSUER?: string;
  /** Défaut `wnext-web`. */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** Défaut : origine de l'écran + `/`. */
  readonly VITE_OIDC_REDIRECT_URI?: string;
}

/** Version du produit et commit court, injectés au build (vite.config.ts). */
declare const __WNEXT_VERSION__: string;
declare const __WNEXT_COMMIT__: string;
