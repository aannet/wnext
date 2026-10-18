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
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Durée de la fenêtre glissante des limites de débit ci-dessous (1–3600). |
| `TICKET_RATE_PER_USER` / `TICKET_RATE_PER_ACCOUNT` | `30` / `300` | Tickets d'upgrade délivrés par utilisateur (dans un compte) et par compte et par fenêtre ; au-delà, `429` `RATE_LIMITED` (0 = pas de limite, max 1000000). |
| `WS_UPGRADE_RATE_PER_ACCOUNT` | `120` | Tentatives de connexion WebSocket authentifiées par compte et par fenêtre ; au-delà, l'upgrade reçoit `429` + `Retry-After` (0 = pas de limite). |
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
- **Limites de débit** (fenêtre glissante en mémoire, voir `RATE_LIMIT_WINDOW_SECONDS` et les trois variables associées) : l'émission d'un ticket est limitée par utilisateur puis par compte (`429` `RATE_LIMITED`, `params.retryAfterSeconds` et en-tête `Retry-After`), les tentatives de connexion par compte (`429` + `Retry-After` d'au moins `REALTIME_RETRY_AFTER_SECONDS`, comme le plafond de connexions simultanées). L'authentification passe avant : un anonyme ne consomme aucun quota, et une tentative refusée n'est pas comptée. **Limite par processus** : avec N instances, la limite effective d'une clé peut atteindre N fois la valeur configurée ; un quota exact demanderait un stockage partagé. Un ticket présenté à l'upgrade est consommé même si l'upgrade est refusé en 429 : le client en redemande un.
- Le rôle est figé à l'émission (30 s) ; le flux ne diffuse que des références du compte, sans autorisation par rôle.

## Arrêt

SIGTERM / SIGINT : fermeture des WebSocket (1001), fin des requêtes en cours, fermeture du pool ; arrêt forcé après 10 s.

## Limites connues

- L'adaptateur `pg` n'est testé qu'avec un pool simulé (pas de Postgres dans l'environnement de développement) ; la concurrence réelle (`FOR UPDATE`) n'est pas éprouvée.
- Le sondage est partagé (`ChangeHub`) : une lecture d'une ligne (`account_change_seq`) par compte et par période, et les sessions ne relisent `change_log` que si la tête a bougé.
- Lecture des entités de référence : `GET /api/v1/{departments,roles,timeoff-types,holidays,projects}` (liste paginée par curseur sur `id`, `page.total`, filtres fériés `from`/`to` et projets `status`, archivés exclus par défaut) et `GET …/{id}` ; ouverte à tout membre authentifié.
- Clients, phases et tâches : `/api/v1/clients`, `/api/v1/phases`, `/api/v1/project-tasks` (liste paginée, lecture par id, création, `PATCH` et `DELETE` avec `If-Match`). Lecture ouverte à tout membre ; écriture owner, admin et project_manager. Phases et tâches portent un `projectId` fixé à la création (filtre `projectId` en lecture, `phaseId` pour les tâches) ; la phase d'une tâche doit être du même projet. Suppression refusée (`REFERENCE_IN_USE`) tant que des lignes y renvoient (client -> projets ; phase -> tâches, allocations, temps saisis, jalons ; tâche -> allocations, temps saisis, lignes de budget). Journalisés en temps réel (entités `clients`, `phases`, `project_tasks`).
- Jalons : `/api/v1/milestones` (liste paginée filtrable par `projectId`, `phaseId`, `dueFrom` et `dueTo` ; lecture par id, création, `PATCH` et `DELETE` avec `If-Match`). Lecture ouverte à tout membre ; écriture owner, admin et project_manager. `projectId` fixé à la création, phase facultative du même projet (sinon 404 `phase`). Suppression libre ; journalisé en temps réel (entité `milestones`).
- Dépenses et lignes de budget : `/api/v1/project-expenses` et `/api/v1/project-budget-lines` (liste paginée, lecture par id, création, `PATCH` et `DELETE` avec `If-Match`). Données financières : **lecture comme écriture réservées à owner, admin et project_manager** (403 pour member et guest, avant la validation de la requête). Montants en chaînes décimales à 2 décimales (`"1250.50"`), devise ISO ; une dépense sans devise prend celle du compte. Une ligne de budget vise une tâche du projet OU une personne (cible immuable, une ligne par cible et par projet : 409 `ALREADY_EXISTS`), avec des heures et/ou un montant. Le budget global du projet (types, baseline, burn : BR-22) n'est pas livré. Volontairement HORS journal temps réel (données financières : un message révélerait leur existence aux rôles sans droit de lecture) ; les suppressions de dépenses vont dans `delete_log`.
- Équipe d'un projet : `GET /api/v1/projects/{projectId}/team` (liste paginée par curseur sur `personId`, `page.total`, noms lus dans `people`), ouverte à tout membre ; équipe vide = liste vide ; 404 pour un projet inconnu ou d'un autre compte. L'équipe n'est pas la liste des personnes allouées (Q-07). Tout changement d'équipe est diffusé en temps réel (entité `project_team`, `id` = projet, toujours `update`, `version` = `seq`).
- Ajout en lot à l'équipe : `POST /api/v1/projects/{projectId}/team` avec `{ personIds }` (1 à 500, sans doublon) répond `{ added, alreadyInTeam }` dans l'ordre reçu. Une transaction, tout ou rien : une personne inconnue ou d'un autre compte annule tout (404, `personId` de la première fautive). Idempotent, n'écrit que `project_team`. Mêmes rôles que l'ajout unitaire (owner, admin, project_manager), vérifiés avant le corps.
- Lecture des personnes : `GET /api/v1/people` (liste paginée par curseur sur `id`, mêmes champs que le Schedule ; désactivées exclues sauf `includeInactive=true` ; filtres `departmentId`, `roleId`, `tag`, `search` = sous-chaîne du nom sans tenir compte de la casse, `%` et `_` littéraux), `GET /api/v1/people/{id}` (désactivée comprise) et `GET /api/v1/people/{id}/projects` (projets où la personne est dans l'équipe OU a une allocation, avec `inTeam` et `allocationCount` ; archivés exclus sauf `status=archived`). Ouvertes à tout membre. La casse des lettres non ASCII dépend de la locale de la base (`ILIKE`) ; pas de recherche sans accents.
- Lecture des allocations : `GET /api/v1/allocations/{id}` (avec sa `version`) et `GET /api/v1/projects/{projectId}/allocations?from=&to=` (fenêtre obligatoire, 400 jours au plus ; même règle de chevauchement que le Schedule, une série comptée jusqu'à sa fin et renvoyée une seule fois, non développée ; filtres `personId` et `status` ; pagination par curseur sur `id`). Ouvertes à tout membre. Il n'y a pas de liste globale `GET /allocations`.
- Allocations d'une personne : `GET /api/v1/people/{id}/allocations?from=&to=` (mêmes règles de fenêtre, de chevauchement et de pagination ; filtres `projectId` et `status` ; personne désactivée lisible, projets archivés inclus). Ouverte à tout membre.
- Allocations multi-personnes (BR-26) : `POST /api/v1/allocation-groups` crée en une transaction (tout ou rien) une ligne par membre (2 à 50 personnes distinctes) liées par un `groupId`, avec les champs communs du corps et, par membre, sa charge (`members[i].load`) ou la charge commune (`load`) ; la réponse `{ groupId, items }` suit l'ordre des membres. Édition « celle-ci » : `PATCH`/`DELETE /api/v1/allocations/{id}` inchangés (la ligne reste dans le groupe). Édition « tous » : `PATCH`/`DELETE /api/v1/allocations/{id}/group` avec `If-Match` de la ligne désignée ; toutes les lignes sont verrouillées (ordre des id), seule la version de la ligne désignée est contrôlée, chaque ligne applique le patch à sa propre valeur (corps strict : `personId` et `load` interdits), tout ou rien. Allocation sans groupe : 404 `allocation_group`. Écriture owner, admin et project_manager. Un congé n'affecte que la ligne de la personne (BR-05).
- Temps saisis (BR-11, BR-12, BR-28) : `GET /api/v1/logged-time?personId=&from=&to=` (fenêtre obligatoire, 400 jours au plus, filtre `status`, non paginée), `POST /api/v1/logged-time` (brouillon), `PATCH`/`DELETE …/{id}` avec `If-Match` (brouillons seulement : sinon 409 `LOGGED_TIME_LOCKED`), `POST …/prefill` (miroir des allocations confirmées, calcul pur dans `planPrefill` de `@wnext/engine` ; idempotent, ne retire ni congé ni férié, tronque à 24 h par jour), `POST …/submit` (tous les brouillons de la personne dans la fenêtre, atomique, verrouille) et `POST …/{id}/unlock` (owner et admin, tracé par le trigger). Lecture ouverte à tout membre ; écriture owner, admin, project_manager. Plus de 24 h dans la journée : 409 `LOGGED_TIME_DAY_LIMIT` ; un placeholder ne logue pas (400). Pas de diffusion temps réel (`logged_time` n'est pas dans `ChangeEntity`), ni de période de timesheet ni d'échéance de verrouillage automatique (Q-05/Q-06).
- `LISTEN/NOTIFY` : le trigger `log_change` émet `pg_notify('wnext_changes', <account_id>)` (livré au COMMIT, doublons d'une transaction fusionnés). `main.ts` écoute sur une connexion dédiée (`pgNotifier`, reconnexion avec attente croissante) et le hub relit le compte aussitôt ; à chaque reconnexion tout le monde relit, car les notifications émises pendant la coupure sont perdues. Écoute établie, le minuteur ne sert plus que de filet (30 s) ; coupée, il reprend `POLL_INTERVAL_MS`. Une notification n'est qu'un signal : le journal reste la source de vérité. Plafond par compte : voir `WS_MAX_PER_ACCOUNT` (réservation faite avant tout `await`, rendue à la fermeture de la socket).
- Pas de TLS (à terminer en frontal) ; le plafond de connexions WebSocket est par compte et par processus, sans limite par utilisateur.

## Tests de concurrence (vrai PostgreSQL)

PGlite n'a qu'une connexion : aucun verrou de ligne n'y attend jamais. `tests/concurrency/` démarre un vrai PostgreSQL 18
(binaires npm `embedded-postgres`, sans Docker ni root, base temporaire) et prouve avec plusieurs connexions : verrou optimiste
(`VERSION_CONFLICT`), exclusion des congés (`TIMEOFF_OVERLAP`, y compris interblocage rejoué par `withContext`), journal de changements
sans trou, verrou de la personne du retrait d'équipe BR-10, adaptateur `pgDb` sur un vrai pool. `npm run test:concurrency` (inclus dans `make check`).
