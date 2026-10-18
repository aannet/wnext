# Registre des questions « avant P1 » — décisions du CPTO

Date : 2026-10-18. Propriétaire de toutes les décisions : le CPTO. Entrée de P1 : toutes les lignes ci-dessous au statut « décidé ».

| # | Question | Statut | Décision |
|---|---|---|---|
| 1 | Stratégie de conflit temps réel | Décidé | Versionnage optimiste (ETag/version, `409` sur version périmée, code d'erreur stable). Voir ADR-003 §5. Détail (colonne de version vs `modified_at`, entités concernées) à spécifier en P1/P2. |
| 2 | Outil Zod → OpenAPI → client | Décidé, sous réserve | Fastify + type provider Zod. **Spec générée depuis `packages/contracts`, hors serveur**, avec `@asteasolutions/zod-to-openapi` ; le type provider ne sert qu'à la validation/sérialisation runtime (une seule source de spec). Client : `openapi-typescript` + wrapper fetch, ou `orval`, à trancher en P0. À confirmer par un test de génération en P0. |
| 3 | Base du pourcentage | Décidé | Base **brute** (heures ouvrées du jour) pour le stockage et l'affichage ; l'alerte de sur-allocation se compare à la capacité **nette** (BR-38). À écrire dans BR-24 ; corriger ADR-004 §« suit la capacité » (elle suit la capacité contractuelle, pas la disponibilité nette). Clarifier le plafond (500 % dans `schema.sql`, BR-24 dit « non plafonné à 100 % »). |
| 4 | Heures tentatives dans la charge | Décidé | Comptées dans la charge et la sur-allocation, **avec décomposition** : `planned_hours` = confirmé + tentatif, `tentative_hours` conservé. Ajouter un indicateur de sur-allocation sur le confirmé seul (rouge plein = confirmée, hachuré = potentielle). Aligné sur BR-20. |
| 5 | Seuils de capacité | Décidé | Seuils **par compte**, stockés en JSONB, défaut sous-allocation < 80 %, **paramétrable**. Le seuil de sur-allocation est **fixé à 100 %** (BR-38, `is_overbooked`), non paramétrable. Les états (sous/OK/sur) restent hors de la fonction SQL, qui ne renvoie que des nombres. |

## Incohérences documentaires à corriger avant P1 (relevées par un agent, non revérifiées)

- Numérotation des questions : le dossier v1.1 numérote Q-01 = tentatif, Q-04 = base du %, Q-02 = conflit temps réel ; `schema.sql` (l.823, l.905) appelle le tentatif « Q-02 » et cite « Q-06 » pour les timesheets (Q-05 dans le dossier).
- `schema.sql` l.412 et l.731 fixent déjà la base brute ; l'ADR-004 laisse entendre que le % « suit la capacité ».
- Seuils UX : « orange = 90–100 % » (`docs/review/ux-ui.md`) n'est formalisé nulle part ; à retirer ou à formaliser (troisième seuil).
- BR-38 : capacité nulle et charge > 0 doit donner une sur-allocation maximale, jamais NULL ; `utilization()` renvoie `is_overbooked = TRUE` mais `utilization` reste NULL.
- À mettre à jour : dossier v1.1 (Q-01, Q-03, Q-04), BR-24, ADR-004, commentaires de `schema.sql`.

## Hors registre, à traiter en P0

- ADR-003 : « dépendances autorisées : aucune » pour `contracts` est en tension avec Zod ; préciser « Zod uniquement », générateur dans un paquet d'outillage.
- Les schémas d'événements WebSocket vivent dans `contracts`, mais OpenAPI ne les décrit pas : outil de spec séparé à choisir (AsyncAPI ou export maison), non vérifié.
