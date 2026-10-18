# @wnext/api

API REST + WebSocket de WNEXT. Contrats : `@wnext/contracts` (ADR-003). Aucune dépendance vers `apps/web`.

## Démarrer

```
DATABASE_URL=postgres://app_user@localhost/wnext npm run start -w @wnext/api
```

| Variable | Défaut | Rôle |
|---|---|---|
| `DATABASE_URL` | (requis) | Connexion Postgres. Se connecter en `app_user` (non propriétaire) : sinon la RLS de `schema.sql` ne s'applique pas. |
| `DB_ROLE` | — | Alternative : `SET LOCAL ROLE <rôle>` à chaque transaction (le rôle de connexion doit en être membre). |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Écoute. |
| `POLL_INTERVAL_MS` | `1000` | Période du sondage de `change_log` pour le flux temps réel (50–60000). |
| `AUTH_MODE` | `dev` | Seul mode existant. |

`schema.sql` doit déjà être chargé (pas d'outil de migration pour l'instant).

## Authentification : DÉVELOPPEMENT SEULEMENT

Le mécanisme réel est une décision ouverte. En attendant, `AUTH_MODE=dev` lit l'identité dans les en-têtes
`x-dev-account-id`, `x-dev-user-id`, `x-dev-role` (owner|admin|project_manager|member|guest), **sans aucune preuve**.
`NODE_ENV=production` refuse de démarrer dans ce mode.

## Temps réel

`GET /api/v1/realtime` (upgrade WebSocket, même authentification). Protocole : `packages/contracts/src/realtime.ts`.
Premier message : `{"v":1,"type":"subscribe","cursor":"<changeCursor de GET /schedule>"}`.

## Arrêt

SIGTERM / SIGINT : fermeture des WebSocket (1001), fin des requêtes en cours, fermeture du pool ; arrêt forcé après 10 s.

## Limites connues

- L'adaptateur `pg` n'est testé qu'avec un pool simulé (pas de Postgres dans l'environnement de développement) ; la concurrence réelle (`FOR UPDATE`) n'est pas éprouvée.
- Le sondage ouvre une transaction par session et par période : à remplacer par `LISTEN/NOTIFY` + un sondeur partagé avant d'avoir beaucoup de connexions.
- Pas de limite du nombre de connexions WebSocket par compte, pas de TLS (à terminer en frontal).

## Tests de concurrence (vrai PostgreSQL)

PGlite n'a qu'une connexion : aucun verrou de ligne n'y attend jamais. `tests/concurrency/` démarre un vrai PostgreSQL 18
(binaires npm `embedded-postgres`, sans Docker ni root, base temporaire) et prouve avec plusieurs connexions : verrou optimiste
(`VERSION_CONFLICT`), exclusion des congés (`TIMEOFF_OVERLAP`, y compris interblocage rejoué par `withContext`), journal de changements
sans trou, verrou de la personne du retrait d'équipe BR-10, adaptateur `pgDb` sur un vrai pool. `npm run test:concurrency` (inclus dans `make check`).
