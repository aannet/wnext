# ADR-008 — Phase 6 « Expérience et recette »

Statut : proposé (2026-10-21, décisions d'Alec du même jour).
Complète : `docs/00-factory/strategy.md` §1 (ligne P6), `docs/01-product/dossier-fondamentaux-v1.1.md` §4 et §5.6, `docs/06-decisions/reviews-v1.1/ux-ui.md`.

## Contexte

À l'issue de P4, l'écran Schedule est complet sur le plan fonctionnel (API, temps réel, gestes, congés, vues, notifications, import), mais l'application n'est pas utilisable par un humain :

- La DA spécifiée (dossier §4.3, `ux-ui.md` §2-3 : tokens, Inter, échelle typographique, densité, composants) n'a jamais été appliquée. La condition d'entrée de P3 « tokens validés » a été sautée faute de décision sur l'accent (Q-09).
- Seul le Schedule existe : pas de navigation, pas d'écrans Projets ni Personnes, pas de réglages. Un compte vide ne peut être rempli que par import CSV.
- Les gates P0 à P5 sont techniques. Aucun ne vérifie qu'une personne réelle peut accomplir les parcours du MVP.

## Décision

1. **Une phase P6 « Expérience et recette »** est ajoutée. Elle se place **avant le gate de release** : P5 (performance, sécurité, PITR) continue en parallèle, mais la release exige que P6 soit signée.
2. **Périmètre : le MVP T1 complet**, utilisable depuis un compte vide.
   - Design system : Tailwind (ADR-009), tokens, primitives.
   - Habillage du Schedule.
   - Coque : en-tête, navigation et connexion.
   - Écrans Projets, Personnes et Réglages.
   - Approbation des congés.
   - Assistant de première allocation et « Trouver quelqu'un de dispo ».
   - Aide et palette de commandes.
   - **Hors P6** : le mode sombre (« après stabilisation »), le mobile sous 1024 px (T3), les timesheets et les rapports (T2).
3. **La recette est un projet dans le projet**, piloté par les retours d'Alec.
   - Chaque note de retours est conservée verbatim dans `docs/05-project/recette/notes/`, puis passe par un **cadrage**.
   - Le cadrage se fait en cinq étapes :
     1. découpage en retours atomiques `RT-NNN`, avec la citation de la note ;
     2. qualification de chaque retour : nature, écart à la spec, écran, gravité, reproduction, effort et cible ;
     3. regroupement en lots thématiques exécutables ;
     4. synthèse `cadrage-N.html`, validée par Alec, avec au plus 5 questions ;
     5. injection des lots dans le plan.
   - `docs/05-project/recette/registre.md` est la source de vérité.
   - Un retour corrigé l'est avec un test qui échouait avant. Il ne passe « vérifié » que lorsque Alec l'a confirmé.
4. **Catalogue Vite au lieu de Storybook** : `ux-ui.md` §3.4 demandait un Storybook. On retient une entrée Vite `catalogue.html` qui montre chaque primitive dans tous ses états, avec captures Playwright et axe-core. Les raisons : beaucoup moins de dépendances, de mémoire (VM de 15 Go) et de surface d'audit npm, pour la même preuve.

## Critères de sortie (gate humain)

- Le registre n'a plus aucun retour bloquant ni majeur ouvert. Les autres sont vérifiés, ou reportés ou rejetés avec l'accord d'Alec.
- Tous les parcours de `docs/02-design/ecrans-et-parcours.html` et toutes les US E1 à E7 se font depuis un compte vide, sans SQL ni import.
- `npm run test:recette` est vert, et Alec a passé les scénarios à la main.
- Aucune couleur en dur hors tokens (garde-fou). axe-core sans violation AA sur chaque écran. Les captures sont approuvées.
- North star (poser une allocation) sous 10 s. Pas de régression de `bench:browser`.

## Conséquences

- La condition « tokens validés » de P3 est reportée sur P6, et Q-09 se tranche en P6 à partir des images de référence d'Alec.
- Le suivi (`docs/05-project/avancement.html`) gagne une feuille de route T1 à T4, la phase P6 et un tableau de recette.
