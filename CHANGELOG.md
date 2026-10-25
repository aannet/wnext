# Journal des versions

Toutes les évolutions notables de WNEXT. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
numérotation [SemVer](https://semver.org/lang/fr/).

- **0.x** jusqu'au gate de release du MVP T1, qui sera **1.0.0**. La mineure suit la phase en cours (0.6 = P6
  « Expérience et recette », `docs/00-factory/strategy.md` §1) ; le correctif s'incrémente à chaque recette ou fusion notable.
- Source unique : le `version` du `package.json` racine, recopié dans les workspaces et `package-lock.json` par
  `npm run version:set -- X.Y.Z` (cohérence vérifiée par `tests/guardrails/version.test.ts`, dans `make check`). L'API
  l'annonce sur `GET /api/v1/health`, l'écran l'affiche en pied de l'aide des raccourcis (« ? »), avec le commit court.
- Le contrat OpenAPI (`packages/contracts-tools/src/openapi.ts`, `API_VERSION`) a sa propre version, indépendante du produit.
- Chaque version a son tag git local `vX.Y.Z` (poussé seulement à la demande).

## [Non publié]

## [0.6.0] - 2026-10-25

Premier numéro de version : état de `main` à l'entrée de la recette n°4.

### Contenu

- Socle (P0) : monorepo TypeScript, `make check` et CI, garde-fous, chaîne contract-first (`packages/contracts`, OpenAPI
  généré, `docs/03-tech/api.html`), kill-switch.
- Moteur (`packages/engine`) : capacité (miroir de `daily_capacity`, tests de parité) et mise en page des blocs multi-jours.
- API (`apps/api`, `node:http` + `pg`) : planning, allocations et séries, congés (BR-04), personnes et historique (BR-19),
  projets et équipe (BR-10, BR-33), temps saisi (BR-11, BR-12), vues sauvegardées, notifications, import CSV, temps réel
  par `change_log` filtré par personne (RT-048), OIDC.
- Base : schéma v1.1 (`schema.sql`) et migrations `0002` à `0006`.
- Écran (`apps/web`, React, DOM virtualisé, Lingui FR/EN) : planning complet (zoom, navigation, gestes souris/clavier/tactile,
  annuler/rétablir, saisie rapide, capacité), écrans Projets, Personnes, Réglages, recherche globale, aide des raccourcis,
  design system Tailwind + tokens (ADR-009), identité de marque.
- Recette : retours RT-001 à RT-064 traités (cadrages n°1 à n°4, `docs/05-project/recette/registre.md`).

[Non publié]: https://github.com/aannet/wnext/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/aannet/wnext/releases/tag/v0.6.0
