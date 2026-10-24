# ADR-001 — Arbitrage CPTO de la revue v1.0 → v1.1

Statut : accepté (décisions 1-3 validées par l'utilisateur, 4-9 arbitrées par le CPTO)
Sources : `docs/06-decisions/reviews-v1.1/{archi-fonctionnel,archi-solution,product,ux-ui}.md`

## Décisions validées par l'utilisateur

1. **MVP réduit « Schedule + capacité »** : personnes/projets, Schedule temps réel, capacité, congés/fériés, permissions simples, vues sauvegardées. Différés (T2+) : timesheets, rapports, budgets/rate cards, mobile natif, API v3, SSO, billing. Le P0 v1.0 (FR-01..10) est réaligné sur la roadmap §5.5.
2. **BR-15 siège = toute personne sur le Schedule** (employé, contractor, placeholder). La note d'arbitrage SQL n°3 est supprimée.
3. **`work_days_hours` : stockage ISO interne, premier jour affiché paramétrable.** Index 0 = lundi en base ; l'affichage suit `accounts.week_start` ; conversion à la frontière API v3 si Float est dimanche-first (à vérifier dans la doc v3).

## Décisions CPTO (arbitrage des désaccords entre relecteurs)

4. **Désaccord ISODOW** : le SQL est cohérent avec « index 0 = lundi » (tableau PG 1-based, ISODOW lundi = 1) ; c'est le **défaut** `{0,8,8,8,8,8,0}` qui est faux (dimanche-first). Défaut corrigé : `{8,8,8,8,8,0,0}`. L'exemple du dossier est corrigé en conséquence. *(Correction à CLAUDE.md : la note « index 0 = lundi » reste vraie, le défaut non.)*
5. **Réécriture des fonctions SQL** (`daily_planned_load`, `daily_capacity`, `utilization`) : `'N'::interval` = N secondes, répétitions et jours non ouvrés mal gérés → réécriture complète avec jeu de tests SQL de non-régression d'abord (recommandation archi fonctionnel + solution).
6. **Intégrité/sécurité (bloquant)** : `account_id` sur toutes les tables, clés étrangères composites `(id, account_id)`, RLS, tables `users`/`account_members`. `ON DELETE RESTRICT` sur `logged_time`. Pas d'exclusion de chevauchement sur `allocations` (BR-01).
7. **BR-10 / BR-12 / BR-14 portées par la base** : triggers `delete_log` (y compris cascades), trigger de verrouillage des timesheets, confirmation applicative avec récapitulatif pour le retrait d'équipe.
8. **Nouvelles règles BR-18..BR-40** (archi fonctionnel) adoptées ; priorité BR-18 (dates/semaine), BR-22 (budget), BR-23 (taux), BR-28 (timesheet), BR-31 (suppression/désactivation). Budgets multi-types et baseline versionnée : modélisés mais livrés en T3.
9. **UX** : accessibilité clavier/tactile obligatoire pour chaque geste de drag-and-drop (WCAG 2.5.7) ; undo = pile locale de session ; accent de marque distinct de `--cap-ok` et conforme AA. Stack : TypeScript monorepo, Fastify, Kysely, PostgreSQL ≥ 15, WebSocket + outbox `change_log`, Schedule canvas + overlay DOM.

10. **Undo des cascades (BR-40 / BR-10)** : Ctrl+Z (pile locale de session) ne rejoue pas les cascades ; confirmation avec récapitulatif, puis exécution différée de 10 s derrière un toast « Annuler ». Concilie BR-40, UX et product US-2.2.
11. **`v_billable_seats`** : conforme à la décision 2 (toute personne `active` de `people`, placeholders inclus, sans condition de capacité). Reste ouvert : l'instant de comptage (BR-34).

## Questions encore ouvertes (à traiter avant la phase concernée)

- Heures tentatives dans la charge ; base du pourcentage ; granularité et verrou des timesheets (avant T2).
- Seuils de capacité sous/sur-allocation ; stratégie de conflit temps réel (avant P1).
- Pays et jours fériés d'équipe : ajout de `people.country` (inclus dans schema v1.1).
- KPI WAU/sièges à redéfinir (activation, North Star, p95 sync).

## Suite
Livrables : `schema.sql` v1.1 + tests SQL, `docs/01-product/dossier-fondamentaux-v1.1.md`, puis stratégie dark factory.
