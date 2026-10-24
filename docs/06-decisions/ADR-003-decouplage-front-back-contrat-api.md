# ADR-003 — Découplage front/back et contrat d'API

Statut : **accepté** (décision du CPTO, 2026-10-18). Les éléments marqués **[proposé]** restent à confirmer en P0 ; le choix d'outillage (voir « Questions ouvertes ») est décidé sous réserve de vérification des versions.
Complète : ADR-001 n°9 (stack), ADR-002 (moteur de layout partagé), `docs/factory/strategy.md` §4.

## 1. Principe

Le front (React + Vite, SPA) et le back (Fastify) sont deux déploiements indépendants. Ils ne communiquent que par :
- une API REST JSON (HTTP) ;
- un canal temps réel (WebSocket).

Le **contrat est la source de vérité**, écrit avant les deux implémentations (contract-first). Le front n'importe jamais de code du back, ni l'inverse.

## 2. Structure du monorepo [proposé]

| Paquet | Contenu | Dépendances autorisées |
|---|---|---|
| `packages/contracts` | Schémas Zod, spec OpenAPI générée, schémas d'événements temps réel, codes d'erreur | aucune |
| `packages/engine` | Moteur de capacité et moteur de layout (TS pur, ADR-002) | `contracts` |
| `apps/api` | Fastify, Kysely, RLS | `contracts`, `engine` |
| `apps/web` | React, client API généré | `contracts`, `engine` |

Règle d'import vérifiée en CI (lint de frontières) : `apps/web` ne peut pas importer `apps/api`, et réciproquement.

## 3. API REST

- Schémas Zod dans `contracts` ; la spec OpenAPI en est **générée** (jamais écrite à la main) et commitée.
- Client TypeScript du front **généré** depuis cette spec.
- **Pas de compatibilité avec Float** (décision utilisateur) : le format de Float est un exemple, pas une contrainte. L'API est conçue pour WNEXT (« What's Next ») et optimisée pour ses usages ; on s'écarte de Float API v3 dès que c'est mieux (pagination par curseur, filtres, opérations en lot, champs sélectionnables, etc., à définir en P0).
- **API interne (SPA) et API publique distinguées** : l'API interne est versionnée sous `/api/v1`, libre d'évoluer avec le front livré ensemble. Une API publique pour intégrations tierces reste une décision produit à prendre avant T2 ; si elle existe, ce sera une façade stable avec sa propre politique de compatibilité.
- Changement cassant = incrément de version de l'API ; la CI compare la spec à celle de la branche principale et échoue sur rupture non déclarée.
- Contexte du tenant (`account_id`) déduit de la session côté API et posé sur la connexion PostgreSQL pour la RLS ; jamais fourni par le client.

## 4. Erreurs et i18n

- Réponse d'erreur : `{ code, params, requestId }`. `code` est stable (ex. `ALLOCATION_PERSON_NOT_IN_ACCOUNT`), sans texte localisé.
- Le front traduit `code` + `params` via ses catalogues ICU (ADR-002 §4). L'API ne renvoie jamais de chaîne d'interface.
- Les avertissements métier (ex. sur-allocation BR-01, congé sur allocations BR-04) sont des **données** (liste de `warnings` typés), pas des erreurs.

## 5. Temps réel

- Messages WebSocket décrits par des schémas versionnés dans `contracts` (comme le contrat d'événements de la factory).
- Source : outbox `change_log`. Chaque message porte un curseur monotone ; à la reconnexion, le client reprend depuis son dernier curseur, ou recharge la fenêtre visible si le curseur est trop ancien.
- Les mutations passent par REST ; le WebSocket ne fait que diffuser (pas d'écriture par le canal).
- **Stratégie de conflit (décidée, 2026-10-18) : versionnage optimiste.** Chaque entité modifiable porte une version (ETag) ; une écriture sur une version périmée est refusée en `409` avec un code d'erreur stable, et le client recharge puis rejoue. Cohérent avec `docs/factory/strategy.md` P2 (ETag/409). Le détail (colonne de version vs `modified_at`, entités concernées, ce qui reste en dernier écrit gagne) est à spécifier en P1/P2.

## 6. Tests de contrat

- Back : chaque route est testée contre son schéma (requête et réponse).
- Front : développement possible sur un **mock** généré depuis la spec, sans back.
- Tests de bout en bout limités au parcours critique (créer/déplacer une allocation, propagation temps réel).

## 7. Règles pour les agents de la factory

1. Toute ligne qui touche l'API modifie d'abord `packages/contracts`, dans un commit séparé, relu avant l'implémentation.
2. Les agents front et back travaillent à partir du contrat figé de la ligne, jamais du code de l'autre.
3. `packages/contracts` est sous CODEOWNERS (revue humaine, strategy §4.7).
4. Les échecs de tests de contrat ne sont jamais corrigés en affaiblissant le schéma sans décision tracée.

## 8. Impacts à reporter

- `CLAUDE.md` : règle contract-first et frontières de paquets (fait avec cet ADR).
- `docs/factory/strategy.md` : §4 et §4.7 (fait avec cet ADR).
- `docs/dossier-fondamentaux-v1.1.md` : NFR/stack à compléter si l'ADR est validé.
- P0 : scaffolding du monorepo avec le lint de frontières et la génération spec/client.

## Questions ouvertes

- Outil de génération (Zod → OpenAPI → client) : **décidé le 2026-10-18** : Fastify + type provider Zod + génération OpenAPI, spec commitée, client TS généré depuis la spec. Paquets, versions et compatibilité Zod/Fastify **à confirmer** (vérification en cours, voir `docs/decisions/questions-ouvertes-avant-p1.md`).
- ~~Stratégie de conflit temps réel~~ : décidée (voir §5).
- Existence et authentification d'une API publique (jetons `api_tokens`, absents du schéma v1.1).
- Les mentions « aligné sur Float API v3 » du dossier v1.0 et de `schema.sql` deviennent caduques : à retirer lors de la mise à jour du dossier.
