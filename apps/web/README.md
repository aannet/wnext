# @wnext/web

Écran Schedule de WNEXT (React, grille en DOM virtualisé, ADR-005). Parle à l'API par le client généré depuis `@wnext/contracts` ; n'importe jamais `apps/api`.

## Lancer contre l'API

Deux terminaux, depuis la racine du dépôt (Node 22) :

```
npm run dev:stack            # Postgres embarqué persistant (.dev-pg/), migrations, jeu d'essai, API en AUTH_MODE=dev sur :3000
npm run dev -w @wnext/web    # Vite (proxy /api, WebSocket compris, vers http://127.0.0.1:3000)
```

Ouvrir l'URL affichée par Vite. `npm run dev:stack -- --reset` repart d'une base vide (le jeu d'essai est ressemé).

- Identité : `apps/web/.env.development` porte `VITE_DEV_ACCOUNT_ID=1`, `VITE_DEV_USER_ID=1`, `VITE_DEV_ROLE=admin`, les ids du jeu d'essai (`scripts/dev-seed.mjs` : 50 personnes, 6 projets, allocations sur ±3 mois). Aucun secret.
- Autre API : `WNEXT_API_URL=http://hote:port npm run dev -w @wnext/web`. Ports de la pile : `WNEXT_DEV_API_PORT`, `WNEXT_DEV_PG_PORT`.
- `?demo=1` : démo locale sans API (`src/demo.ts`).
- `?lang=en` : interface en anglais (français par défaut).
- Touche `T` : retour à aujourd'hui.
