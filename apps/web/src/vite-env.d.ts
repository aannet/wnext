/// <reference types="vite/client" />

// Variables d'environnement lues par l'écran (apps/web/.env.development) ; voir src/data/auth-fetch.ts.
interface ImportMetaEnv {
  readonly VITE_DEV_ACCOUNT_ID?: string;
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEV_ROLE?: string;
}
