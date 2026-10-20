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

## Tests navigateur et banc

Hors `make check` (Chromium réel, Playwright + axe-core, code dans `tests/browser/`). Une fois : `npx playwright install chromium` (sous Linux nu, `npx playwright install-deps chromium` demande `sudo`).

```
npm run test:browser    # rôles ARIA FR/EN, zooms, Aujourd'hui / T, molette, axe-core (serious/critical = échec),
                        # gestes (glisser, poignées, Échap, clavier, portée d'une série et retour du focus)
npm run bench:browser   # fps, durées d'image, long tasks, coût de buildGrid par zoom (démo 300 personnes, 1600 x 900)
```

- Vite est lancé par la configuration (`?demo=1`, port 5183 pour les tests, 5184 pour le banc) puis arrêté. Un seul worker, un seul navigateur : ne pas les lancer pendant un `make check` (mémoire).
- Sorties ignorées par git dans `tests/browser/out/` : captures des 3 zooms (`screenshots/`, sans comparaison bloquante), violations axe (`axe-*.json`), résultats du banc (`bench.json`).
- Banc : défilement horizontal programmé (1500 px/s, 5 s) puis vertical (3 s) par zoom. Objectif ADR-005 §8.4 : >= 55 fps médian. La VM WSL (rendu logiciel) n'est pas le poste de référence : les chiffres sont un plancher de régression, pas une validation.
- CI : job `browser` séparé, non bloquant (`continue-on-error`).
