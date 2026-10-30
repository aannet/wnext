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

Problèmes connus au démarrage :
- **WSL en réseau `mirrored`** (`networkingMode=mirrored` dans `.wslconfig`) : une connexion vers un port local fermé n'est ni acceptée ni refusée, elle reste en attente. La sonde de ports de `dev:stack` (`scripts/port-busy.mjs`) et l'attente de l'API de `dev:recette` ont donc un délai ; avant ce correctif, la pile restait muette puis `dev:recette` affichait « l'API ne répond pas ».
- **`libicui18n.so.60: cannot open shared object file`** : les liens des bibliothèques de Postgres embarqué n'ont pas été créés (postinstall du paquet `@embedded-postgres/<plateforme>` sauté). `scripts/ensure-embedded-postgres.mjs` les recrée en postinstall du dépôt et au démarrage de `dev:stack` ; à la main : `node scripts/ensure-embedded-postgres.mjs`.

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

Les autres comptes du jeu d'essai (`DEV_USERS` de `scripts/dev-seed.mjs`) servent à voir les droits par rôle : **Admin Dev** (admin : Réglages visible, import dans Réglages > Import), **Membre Dev** (member : ni Réglages ni Importer, planning en lecture seule). Le compte Alec est ajouté à chaque démarrage de `dev:stack`, y compris sur une base `.dev-pg/` semée avant ce lot. Le mode par défaut des tests reste `dev` (en-têtes `x-dev-*`, identité `VITE_DEV_*` = Admin Dev) ; `?demo=1` ouvre le planning sans API ni connexion, en tant que « Alec » fictif.

## Recette avec le jeu de données de recette (RT-044)

```
npm run dev:recette:seed              # = dev:recette --seed=recette ; --reset repart d'une base de recette vide
npm run dev:stack -- --oidc --seed=recette   # pile seule, sans l'écran
npm run dev:recette:vide              # compte vide (Alec owner seul), base .dev-pg-vide/
```

Le seed (`scripts/seed-recette.mjs`) vit dans un répertoire de données **dédié** `.dev-pg-recette/` (ignoré par git). Mêmes ports que `dev:recette` (Postgres 54329, API 3000, IdP 3010, Vite 5173) : on ne peut donc pas faire tourner deux piles en même temps (« le port ... est déjà utilisé »). Le seed est idempotent : relancer ne change rien (les identités OIDC attendues sont complétées).

Garde-fous (`scripts/dev-profile.mjs`), tous exécutés avant la moindre suppression, le moindre démarrage ou la moindre écriture, pour que `.dev-pg/` d'Alec ne soit jamais touché :
- Profils : `dev` (`.dev-pg/`), `recette` (`.dev-pg-recette/`), `vide` (`.dev-pg-vide/`). Chaque répertoire dédié porte un **marqueur** `.wnext-profile`, posé à sa création.
- `WNEXT_DEV_PG_DIR` reste utilisable, mais pour recette et vide seulement vers un répertoire absent, vide ou marqué pour le même profil. Le chemin est résolu en chemin réel (liens symboliques, `..`, barre finale) : tout ce qui recouvre `.dev-pg/`, ou un répertoire non vide sans marqueur, est refusé (« démarrage impossible : ... »), y compris avec `--reset`. Le dépôt ou un de ses ancêtres est refusé pour tous les profils.
- Avant les extensions et les migrations, la base doit être exactement celle du profil (comptes et identités attendus) ; sinon refus, rien n'est écrit. Un répertoire `.dev-pg-recette/` créé avant l'introduction du marqueur est refusé : le supprimer à la main (`rm -r .dev-pg-recette`) puis relancer.

Compte vide (point de départ de R-06) : `npm run dev:recette:vide` (`-- --reset` pour repartir de zéro) ; base `.dev-pg-vide/`, compte « WNEXT Vide », Alec (`dev-alec`) owner seul, aucune personne ni projet.

Contenu : compte « WNEXT Recette » (lundi, Europe/Paris), 4 équipes, 16 personnes actives + 1 placeholder + 1 désactivée (Karim travaille le samedi, Élodie à temps partiel, Thomas a un horaire daté BR-19 : 4 jours à partir du lundi S+3), 3 clients, 7 projets dont 1 tentatif (`REF-01`, `SITE-01`...), ~70 allocations (heures et %, une série hebdomadaire, un groupe multi-personnes BR-26, sur- et sous-allocations), congés (journée, demi-journée, en attente), un férié France, du temps loggé. Un second compte « Autre Société » sert à l'isolation. Les dates sont relatives au lundi de la semaine du semis (S0).

Comptes de connexion (page de choix de l'IdP local, aucun mot de passe) :

| Nom | Sujet OIDC | E-mail | Rôle | Personne liée | Compte |
|---|---|---|---|---|---|
| Alec | `dev-alec` | `alec@wnext.test` | owner | aucune | WNEXT Recette |
| Admin Recette | `recette-admin` | `admin@wnext.test` | admin | aucune | WNEXT Recette |
| Camille Roy | `recette-camille` | `camille.roy@wnext.test` | member | Camille Roy | WNEXT Recette |
| Nadia Benali | `recette-nadia` | `nadia.benali@wnext.test` | project_manager (gère `REF-01`, co-gère `SITE-01`) | Nadia Benali | WNEXT Recette |
| Invité Recette | `recette-invite` | `invite@wnext.test` | guest | aucune | WNEXT Recette |
| Admin Autre Société | `recette-autre` | `autre@wnext.test` | admin | aucune | Autre Société |

Les 12 autres personnes actives n'ont aucun accès de connexion (cas RT-040).

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

`npm run test:schemathesis`, `npm run test:browser`, `npm run perf:realtime`, `npm run load:realtime`, `npm run scan` (voir `docs/03-tech/quality/`). Mémoire : un seul de ces lancements à la fois sur la VM de 15 Go.
