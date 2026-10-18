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
| `WS_MAX_PER_ACCOUNT` | `200` | Connexions WebSocket simultanées par compte ; au-delà, l'upgrade reçoit `429` + `Retry-After` (contrat realtime : `REALTIME_RETRY_AFTER_SECONDS`) (1–100000). |
| `POLL_INTERVAL_MS` | `1000` | Période du sondage de `change_log` pour le flux temps réel (50–60000). |
| `WS_TICKET_SECRET` | aléatoire par processus | Secret (32 caractères au moins) qui signe les tickets d'upgrade WebSocket ; **requis en production**, identique sur toutes les instances. |
| `AUTH_MODE` | `dev` | `dev` (en-têtes sans preuve, refusé en production) ou `oidc` (jeton porteur). |
| `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URL` | — | Requis en mode `oidc` : émetteur (`iss`) et audience (`aud`) attendus, point JWKS du fournisseur (https en production). |

`schema.sql` doit déjà être chargé (pas d'outil de migration pour l'instant).

## Authentification

Deux modes, même signature interne `authenticate(headers) -> RequestContext | null` (null = 401).

**`AUTH_MODE=oidc`** (seul mode autorisé en production). L'API ne gère ni mot de passe ni session : un fournisseur d'identité OIDC
externe émet des JWT, l'API les vérifie.
- `Authorization: Bearer <jwt>` ; RS256 (RSA >= 2048 bits) ou ES256 (P-256) seulement ; signature contre les clés du JWKS
  (cache 10 min, rechargement sur `kid` inconnu au plus toutes les 30 s), `iss`, `aud`, `exp` obligatoire, `nbf`, tolérance d'horloge 60 s.
- `sub` -> `users.idp_subject` ; le compte est choisi par `x-account-id` (ou déduit s'il n'y a qu'une appartenance) et n'est accepté que
  si l'utilisateur en est membre (`account_members`). **Le rôle vient de la base, jamais du jeton** : changer un rôle prend effet à la requête suivante.
- Les utilisateurs doivent être provisionnés (`users.idp_subject`) : pas de création automatique à la première connexion.
- Panne du JWKS sans clé connue : erreur 500 (pas un 401, le jeton n'est pas en cause).

**`AUTH_MODE=dev`** : DÉVELOPPEMENT SEULEMENT. Identité lue dans `x-dev-account-id`, `x-dev-user-id`, `x-dev-role`
(owner|admin|project_manager|member|guest), **sans aucune preuve**. `NODE_ENV=production` refuse de démarrer dans ce mode.

## Temps réel

`GET /api/v1/realtime` (upgrade WebSocket). Protocole : `packages/contracts/src/realtime.ts`.
Premier message : `{"v":1,"type":"subscribe","cursor":"<changeCursor de GET /schedule>"}`.

**Authentification de l'upgrade.** Hors navigateur : les en-têtes habituels. Navigateur (pas d'en-tête sur un WebSocket) : un ticket.
`POST /api/v1/realtime/ticket` (authentifié, tout rôle) renvoie `{ ticket, expiresInSeconds: 30 }` ; on ouvre alors `/api/v1/realtime?ticket=<ticket>`.
- Sans état : identité + échéance + identifiant aléatoire, signés en HMAC-SHA256 (`WS_TICKET_SECRET`) ; toute instance émet et accepte.
- Usage unique **par instance** (mémoire des identifiants présentés) : un ticket rejoué sur une autre instance dans ses 30 s serait accepté. Risque accepté, le fermer demande un stockage partagé.
- Avec `?ticket=`, le ticket est la seule preuve (jamais de repli sur les en-têtes) ; invalide, expiré, rejoué ou répété : 401.
- Le rôle est figé à l'émission (30 s) ; le flux ne diffuse que des références du compte, sans autorisation par rôle.

## Arrêt

SIGTERM / SIGINT : fermeture des WebSocket (1001), fin des requêtes en cours, fermeture du pool ; arrêt forcé après 10 s.

## Limites connues

- L'adaptateur `pg` n'est testé qu'avec un pool simulé (pas de Postgres dans l'environnement de développement) ; la concurrence réelle (`FOR UPDATE`) n'est pas éprouvée.
- Le sondage est partagé (`ChangeHub`) : une lecture d'une ligne (`account_change_seq`) par compte et par période, et les sessions ne relisent `change_log` que si la tête a bougé.
- Lecture des entités de référence : `GET /api/v1/{departments,roles,timeoff-types,holidays,projects}` (liste paginée par curseur sur `id`, `page.total`, filtres fériés `from`/`to` et projets `status`, archivés exclus par défaut) et `GET …/{id}` ; ouverte à tout membre authentifié.
- `LISTEN/NOTIFY` : le trigger `log_change` émet `pg_notify('wnext_changes', <account_id>)` (livré au COMMIT, doublons d'une transaction fusionnés). `main.ts` écoute sur une connexion dédiée (`pgNotifier`, reconnexion avec attente croissante) et le hub relit le compte aussitôt ; à chaque reconnexion tout le monde relit, car les notifications émises pendant la coupure sont perdues. Écoute établie, le minuteur ne sert plus que de filet (30 s) ; coupée, il reprend `POLL_INTERVAL_MS`. Une notification n'est qu'un signal : le journal reste la source de vérité. Plafond par compte : voir `WS_MAX_PER_ACCOUNT` (réservation faite avant tout `await`, rendue à la fermeture de la socket).
- Pas de TLS (à terminer en frontal) ; le plafond de connexions WebSocket est par compte et par processus, sans limite par utilisateur.

## Tests de concurrence (vrai PostgreSQL)

PGlite n'a qu'une connexion : aucun verrou de ligne n'y attend jamais. `tests/concurrency/` démarre un vrai PostgreSQL 18
(binaires npm `embedded-postgres`, sans Docker ni root, base temporaire) et prouve avec plusieurs connexions : verrou optimiste
(`VERSION_CONFLICT`), exclusion des congés (`TIMEOFF_OVERLAP`, y compris interblocage rejoué par `withContext`), journal de changements
sans trou, verrou de la personne du retrait d'équipe BR-10, adaptateur `pgDb` sur un vrai pool. `npm run test:concurrency` (inclus dans `make check`).
