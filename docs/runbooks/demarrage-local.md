# Runbook : démarrage local et variables

Prérequis : Node >= 22.12 (`.nvmrc`), `npm ci`. Aucun Docker : Postgres est embarqué (`embedded-postgres`).

## Pile complète

```
npm run dev:stack            # Postgres :54329 (.dev-pg/), migrations, jeu d'essai, API :3000 en AUTH_MODE=dev
npm run dev -w @wnext/web    # écran (proxy /api vers l'API) ; ?demo=1 sans API
npm run dev:stack -- --reset # repart d'une base vide
npm run dev:stack -- --oidc  # ajoute le fournisseur OIDC local :3010 et passe l'API en AUTH_MODE=oidc
```

Ctrl-C arrête l'API puis Postgres. Vérifier : `curl -s http://127.0.0.1:3000/api/v1/health` répond (statut < 500).
Une seconde pile sur les mêmes ports est refusée au démarrage (« le port ... est déjà utilisé »).

Piles parallèles (une par outil) : `WNEXT_DEV_API_PORT`, `WNEXT_DEV_PG_PORT`, `WNEXT_DEV_PG_DIR`. Convention du dépôt : schemathesis 3200 / 54349, charge 3300 / 54359.

## Recette avec connexion (portail WNEXT, « Bonjour Alec »)

```
npm run dev:recette              # tout en une commande ; --reset passe à la pile (npm run dev:recette -- --reset)
```

Le script (`scripts/dev-recette.mjs`) lance `dev:stack --oidc` (Postgres, migrations, jeu d'essai, fournisseur OIDC local :3010, API :3000 en AUTH_MODE=oidc), attend que l'API réponde, puis l'écran en `VITE_AUTH_MODE=oidc`, issuer et URL d'API alignés sur `WNEXT_DEV_IDP_PORT` et `WNEXT_DEV_API_PORT`. Ctrl-C arrête l'écran puis la pile. Équivalent manuel, en deux terminaux :

```
npm run dev:stack -- --oidc
VITE_AUTH_MODE=oidc npm run dev -w @wnext/web
```

« Session expirée » dès l'ouverture : l'écran tourne en `VITE_AUTH_MODE=dev` (valeur de `apps/web/.env.development`) face à une API en OIDC, qui refuse les en-têtes `x-dev-*` (RT-035). Arrêter ce Vite et relancer par `npm run dev:recette`.

1. Ouvrir l'URL « Local » affichée par Vite (`http://localhost:5173/` si le port est libre) : le portail de connexion WNEXT s'affiche (aucune redirection automatique).
2. « Se connecter » mène à la page de choix du fournisseur local (aucun mot de passe, développement seulement) : choisir **Alec** (owner du compte « WNEXT Dev », sujet `dev-alec`, e-mail `alec@wnext.test`, sans personne liée).
3. Retour sur le planning : « Bonjour Alec » à droite de l'en-tête. Le menu de l'avatar propose Déconnexion, qui ramène au portail.

Les autres comptes du jeu d'essai (`DEV_USERS` de `scripts/dev-seed.mjs`) servent à voir les droits par rôle : **Admin Dev** (admin : Réglages et Importer visibles), **Membre Dev** (member : ni Réglages ni Importer, planning en lecture seule). Le compte Alec est ajouté à chaque démarrage de `dev:stack`, y compris sur une base `.dev-pg/` semée avant ce lot. Le mode par défaut des tests reste `dev` (en-têtes `x-dev-*`, identité `VITE_DEV_*` = Admin Dev) ; `?demo=1` ouvre le planning sans API ni connexion, en tant que « Alec » fictif.

## API seule contre un Postgres existant

```
DATABASE_URL=postgres://app_user@localhost/wnext npm run db:migrate    # état : npm run db:migrate -- --status
DATABASE_URL=postgres://app_user@localhost/wnext npm run start -w @wnext/api
```

La migration (`scripts/migrate.mjs`) s'exécute avec un rôle propriétaire du schéma ; l'API se connecte en `app_user` (ni propriétaire ni BYPASSRLS), sinon la RLS ne s'applique pas. `DB_ROLE=app_user` fait un `SET LOCAL ROLE` par transaction si la connexion est privilégiée (cas de `dev:stack`).

## Variables de l'API (`apps/api/src/config.ts`, détail dans `apps/api/README.md`)

| Variable | Défaut | Note |
|---|---|---|
| `DATABASE_URL` | requis | |
| `DB_ROLE` | aucun | `[a-z_][a-z0-9_]*` |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | |
| `AUTH_MODE` | `dev` | `dev` refusé si `NODE_ENV=production` |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` | requis si `oidc` | JWKS en https en production |
| `WS_TICKET_SECRET` | aléatoire par processus | >= 32 caractères ; requis en production, identique sur toutes les instances |
| `WS_MAX_PER_ACCOUNT` | 200 | au-delà : 429 + `Retry-After` |
| `POLL_INTERVAL_MS` | 1000 | filet de sondage de `change_log` (le réveil normal passe par NOTIFY) |
| `RATE_LIMIT_WINDOW_SECONDS`, `TICKET_RATE_PER_USER`, `TICKET_RATE_PER_ACCOUNT`, `WS_UPGRADE_RATE_PER_ACCOUNT` | 60 / 30 / 300 / 120 | 0 = sans limite |

Une valeur invalide arrête le processus au démarrage avec un message explicite (lire la dernière ligne JSON de la sortie, `"level":"fatal"`).

## Contrôles hors `make check`

`npm run test:schemathesis`, `npm run test:browser`, `npm run perf:realtime`, `npm run load:realtime`, `npm run scan` (voir `docs/review/`). Mémoire : un seul de ces lancements à la fois sur la VM de 15 Go.
