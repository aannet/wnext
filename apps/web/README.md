# @wnext/web

Écran Schedule de WNEXT (React, grille en DOM virtualisé, ADR-005). Parle à l'API par le client généré depuis `@wnext/contracts` ; n'importe jamais `apps/api`.

## Lancer contre l'API

Deux terminaux, depuis la racine du dépôt (Node 22) :

```
npm run dev:stack            # Postgres embarqué persistant (.dev-pg/), migrations, jeu d'essai, API en AUTH_MODE=dev sur :3000
npm run dev -w @wnext/web    # Vite (proxy /api, WebSocket compris, vers http://127.0.0.1:3000)
```

Ouvrir l'URL affichée par Vite. `npm run dev:stack -- --reset` repart d'une base vide (le jeu d'essai est ressemé).

- Identité (mode dev, par défaut ; connexion réelle : section suivante) : `apps/web/.env.development` porte `VITE_DEV_ACCOUNT_ID=1`, `VITE_DEV_USER_ID=1`, `VITE_DEV_ROLE=admin`, les ids du jeu d'essai (`scripts/dev-seed.mjs` : 50 personnes, 6 projets, allocations sur ±3 mois). Aucun secret.
- Autre API : `WNEXT_API_URL=http://hote:port npm run dev -w @wnext/web`. Ports de la pile : `WNEXT_DEV_API_PORT`, `WNEXT_DEV_PG_PORT`.
- `?demo=1` : démo locale sans API (`src/demo.ts`).
- `?lang=en` : interface en anglais (français par défaut).
- Touche `T` : retour à aujourd'hui.

## Connexion OIDC locale

Pour travailler avec une vraie connexion (jeton porteur vérifié par l'API) au lieu des en-têtes `x-dev-*` :

```
npm run dev:stack -- --oidc                       # + fournisseur OIDC local sur :3010, API en AUTH_MODE=oidc
VITE_AUTH_MODE=oidc npm run dev -w @wnext/web     # l'écran redirige vers le fournisseur au chargement
```

- Fournisseur : `scripts/dev-idp.mjs` (node:http + node:crypto, aucune dépendance). Page de choix parmi les utilisateurs du jeu d'essai (`DEV_USERS` de `scripts/dev-seed.mjs` : `dev-admin` admin, `dev-member` membre, sujets portés par `users.idp_subject`). Aucun mot de passe : développement seulement, refusé si `NODE_ENV=production`. `login_hint=<sujet>` sur `/authorize` connecte directement (tests).
- Flux : code + PKCE S256 obligatoire, `state` et `nonce` vérifiés, URL nettoyée au retour (`src/data/oidc.ts`). Jeton d'accès (ES256, 5 min) en mémoire seulement ; refresh_token tournant en `sessionStorage` (reprise après rechargement de l'onglet, rien entre onglets ni après fermeture). Renouvellement à 80 % de la durée de vie ; sur un 401 de l'API, un refresh puis la requête rejouée une fois, sinon nouvelle connexion (`src/data/auth-fetch.ts`). Le ticket du temps réel passe par le même fetch authentifié. Bouton « Se déconnecter » dans la barre d'état.
- Variables (`apps/web/.env.development`) : `VITE_AUTH_MODE=dev|oidc` (défaut `dev`), `VITE_OIDC_ISSUER` (défaut local `http://127.0.0.1:3010`), `VITE_OIDC_CLIENT_ID` (défaut `wnext-web`), `VITE_OIDC_REDIRECT_URI` (défaut : origine de l'écran + `/`). Le fournisseur n'accepte comme `redirect_uri` et origine CORS que des adresses de bouclage en http.
- Ports : `WNEXT_DEV_IDP_PORT` (défaut 3010) ; `WNEXT_DEV_IDP_TOKEN_TTL=20` raccourcit les jetons pour observer le renouvellement. Avec un autre port, passer `VITE_OIDC_ISSUER=http://127.0.0.1:<port>` à Vite.
- Test de bout en bout : `npm run test:browser:oidc` (hors `make check` et hors `test:browser`) lance sa propre pile `--oidc` et Vite sur des ports dédiés (API 3100, fournisseur 3110, Postgres 54339, écran 5185), jetons de 20 s : redirection, choix de l'utilisateur, GET /schedule 200 avec `Authorization: Bearer`, temps réel connecté et reçu (allocation créée par un autre client), renouvellement, rechargement sans redirection, déconnexion.

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
