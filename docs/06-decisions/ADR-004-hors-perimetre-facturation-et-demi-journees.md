# ADR-004 — Facturation du produit exclue ; absences à la demi-journée ; pas d'heure dans la journée

Statut : décisions de l'utilisateur. Amende ADR-001 (décisions 2 et 11) et ADR-002 §6 (précision sur les blocs).

## 1. Facturation du produit : hors périmètre

WNEXT n'a ni plans, ni tarification, ni sièges payants, ni essai gratuit, ni paiement (Stripe). Rien de cela n'est modélisé.

Supprimé ou marqué exclu :
- `accounts.plan` et sa contrainte (starter/pro/enterprise), vue `v_billable_seats`, tests associés (`schema.sql`, `tests/sql/schema_tests.sql`).
- Règles BR-15 (siège payant), BR-16 (essai, plans), BR-17 (différenciation par plan), BR-34 (comptage des sièges) : **exclues**. Questions Q-10 et Q-12 du dossier caduques.
- ADR-001 décision 2 (« siège = toute personne sur le Schedule ») et décision 11 (`v_billable_seats`) : caduques. Ce qui reste vrai : toute personne `active` apparaît sur le Schedule, placeholders inclus.
- Stripe/billing en T2 : retiré de la trajectoire. KPI « WAU / sièges payés » : à redéfinir sans notion de siège.

**Non tranché** : la notion de *facturable* au sens des projets (`billable`, `non_billable`, `bill_rate`, `billable_hours`, marge) est conservée pour l'instant. Elle concerne la rentabilité des projets, pas la facturation du produit. À confirmer par l'utilisateur.

## 2. Absences à la demi-journée

Besoin : indiquer qu'un collaborateur est absent une demi-journée, et laquelle.

Modèle (`timeoffs`, `schema.sql`) : colonnes `start_half` et `end_half` de type `day_half` (`am` | `pm`).
- Défaut `am` → `pm` : journées entières, comportement inchangé.
- Matin seul : (`am`, `am`) ; après-midi seul : (`pm`, `pm`).
- Plage sur plusieurs jours : (`pm`, `am`) = « lundi après-midi au mercredi matin ».
- Une moitié déduit 50 % des heures ouvrées du jour (3 h sur un jour de 6 h). Férié prioritaire, plafonnement et types non déduits : inchangés.
- Le chevauchement est refusé à la demi-journée près (un matin et un après-midi peuvent coexister, deux matins non).
- Les congés partiels en heures (`scope = 'partial'`) existent toujours et ne peuvent pas porter de moitié.
- Tests T07p..T07y ajoutés.

Reste à faire côté UX : saisie en un geste (clic sur la moitié gauche ou droite de la cellule) et affichage d'un demi-bloc d'absence sur le Schedule. BR-04 (avertir et replanifier) s'applique aussi aux demi-journées : l'avertissement doit tenir compte de la moitié concernée, ce qui n'est possible que si les allocations sont connues à la demi-journée (voir §3).

## 3. Pas d'heure de début/fin dans la journée

Une allocation reste exprimée en heures par jour (ou en % de capacité), sans créneau horaire. Savoir que quelqu'un travaille « de 9 h à 10 h » sur une tâche n'est pas utile à la planification. Cela ne deviendrait pertinent qu'avec la fonction de timesheet (hors MVP).

Conséquence sur ADR-002 : les « plages » à saisir fluidement sont des **plages de dates** (et la part de capacité), pas des créneaux horaires. La hauteur d'un bloc reste le pourcentage de la capacité du jour.

Effet de bord à noter : comme les allocations n'ont pas de moitié, une demi-journée d'absence sur un jour de 8 h ramène la capacité à 4 h et la sur-allocation se calcule en heures. Le placement d'une allocation « le matin » n'est pas modélisé.

## 4. Heures et % dans la popin : deux champs liés, un seul stocké

Le schéma permet déjà le stockage en heures (`mode = 'hours'`, `hours_per_day`) ; aucune modification n'est nécessaire.

Règle d'interface : la popin affiche toujours **les deux champs, liés** (heures et % de la capacité du jour). Le dernier champ modifié décide de ce qui est stocké :
- l'utilisateur saisit des heures → `mode = 'hours'`, `hours_per_day` ; le % affiché est dérivé ;
- l'utilisateur saisit un % → `mode = 'percentage'`, `percent` ; les heures affichées sont dérivées ;
- l'interface n'expose pas la notion de « mode » : elle est déduite du dernier geste.

Sur un bloc multi-jours dont la capacité varie (jours de 8 h et de 6 h), la valeur dérivée est indicative (« ≈ ») et calculée pour le jour de référence ; le calcul de charge reste fait jour par jour (`daily_planned_load`).

Différence de comportement à connaître : une allocation en heures reste identique si la capacité du jour change (congé, férié) ; une allocation en % suit les heures ouvrées contractuelles du jour (base brute), pas la disponibilité nette après congés et fériés. Si le comportement unique « tout en heures » est préféré (plus simple, `percent` supprimé), c'est une décision à prendre ; elle ferait perdre le suivi des heures ouvrées du jour.

## Impacts reportés

- `schema.sql` et tests : faits (166 assertions passent sur PGlite, pas sur un vrai PostgreSQL).
- `CLAUDE.md` et `docs/01-product/dossier-fondamentaux-v1.1.md` : marquages « exclu » ajoutés.
- Reste : `docs/02-design/ecrans-et-parcours.html` (saisie d'absence à la demi-journée), `docs/03-tech/schema-v1.1-diagram.html` (colonnes `start_half`/`end_half`, suppression de `plan`).
