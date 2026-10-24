# Revue d'architecture fonctionnelle — Dossier v1.0 + schema.sql.txt v1.0

Relecteur : architecte fonctionnel senior · Périmètre : dossier de fondamentaux (§3 et §5) et `schema.sql.txt`. Aucun fichier existant modifié.

Légende : **[BLOQUANT]** à trancher avant d'écrire du code ou une migration · **[IMPORTANT]** à trancher avant la fin du MVP (P0) · **[CONFORT]** amélioration, peut suivre.

Références : `Dossier §x`, `SQL l.N` (numéro de ligne dans `schema.sql.txt`), `CLAUDE.md` pour les défauts déjà connus (typo `COLESCE`, vue `v_utilization`, absence de `people.country`), non répétés ici sauf impact fonctionnel.

---

## 0. Verdict en 6 points

1. Le modèle de données couvre le cœur (Schedule, capacité, logs) mais **ne porte pas encore plusieurs règles de gestion** : budgets par tâche/personne (BR-08/09), suppression en cascade des allocations au retrait d'équipe (BR-10), journalisation des suppressions (BR-14), verrouillage (BR-12), permissions (FR-09).
2. **`daily_planned_load` est faux** pour toute allocation de plus d'un jour et pour les répétitions (cf. 1.2). Le cœur de BR-01..03 ne peut donc pas être validé tel quel.
3. **Convention de `work_days_hours` incohérente** entre dossier, commentaire SQL et valeur par défaut (cf. 1.1).
4. **Pas d'historisation** (horaires, taux, rôle) : toute modification réécrit le passé des rapports et des timesheets verrouillés.
5. **La notion de « tentatif » existe à 3 endroits** (`projects.status`, `projects.tentative`, `allocations.status`) sans règle de précédence.
6. Les 5 types de budgets sont dans un enum, mais **une seule colonne `budget_amount`** : impossible de représenter « par tâche » / « par personne ».

---

## 1. Cohérence BR-01..BR-17 vs modèle de données

### 1.1 Défauts bloquants

| # | Prio | Constat | Action |
|---|---|---|---|
| C-01 | **[BLOQUANT]** | **Indexation de `work_days_hours`.** Commentaire SQL l.76 : « index 0 = lundi ». Défaut `'{0,8,8,8,8,8,0}'` : en PostgreSQL les tableaux sont 1-based, donc position 1 = 0 h, positions 2..6 = 8 h. Avec `ISODOW` (lundi=1) cela donne **lundi 0 h, samedi 8 h**, ce qui est faux. Si le tableau est dimanche-first (convention API Float probable), `ISODOW` est faux pour tous les jours sauf le samedi. L'exemple du dossier `[0,4,4,4,0,0,0]` « 4 h du lundi au mercredi » n'est cohérent qu'en lundi-first, mais alors le défaut SQL est faux. | Choisir UNE convention (recommandé : lundi-first, position 1 = lundi = `ISODOW`, défaut `{8,8,8,8,8,0,0}`), l'écrire dans le dossier et le schéma, ajouter `CHECK (array_length(work_days_hours,1)=7)` (la taille `[7]` n'est pas imposée par PostgreSQL) et une fonction unique `work_hours(person, date)` utilisée partout. L'API externe convertit si elle diffère. |
| C-02 | **[BLOQUANT]** | **`daily_planned_load` (l.306-327).** (a) Pour `repeat_state='none'`, le pas de `generate_series` est `(end-start+1)::text::interval`, soit `'5'::interval` = **5 secondes** : on n'obtient que le premier jour de l'allocation. (b) Même pour `daily/weekly/monthly`, seul le jour de départ de chaque occurrence est généré, pas la durée `start..end`. (c) `LEAST(end_date, repeat_end_date, p_to)` plafonne à `end_date` : `repeat_end_date` n'étend jamais rien. (d) Les jours non ouvrés, fériés et congés ne sont pas filtrés (BR-01 « posée seulement sur jour ouvré »). (e) `COALESCE(hours_per_day, …)` donne un résultat faux si on bascule de `hours` à `percentage` sans remettre `hours_per_day` à NULL (le CHECK l'autorise). | Réécrire en 2 temps : (1) expansion des occurrences (`série → [début, fin]` par occurrence), (2) jointure sur le calendrier des jours ouvrés. Ajouter au CHECK : `mode='hours' ⇒ percent IS NULL` et inversement. Prévoir un jeu de tests SQL (cf. §5). |
| C-03 | **[BLOQUANT]** | **BR-10 non portée.** `project_team` n'a aucun lien avec `allocations`/`logged_time` : retirer une ligne de `project_team` ne supprime rien, et une allocation peut exister pour une personne absente de l'équipe. Ni la confirmation ni le récapitulatif n'ont de support. | Décider : l'appartenance à l'équipe est-elle obligatoire pour allouer (FK composite `allocations(project_id, person_id) → project_team`) ? Si oui, le retrait = opération applicative atomique « résumé → confirmation → suppression + delete_log ». Voir BR-31. |
| C-04 | **[BLOQUANT]** | **BR-14 non portée.** Aucun trigger n'écrit dans `delete_log`. Pire : les `ON DELETE CASCADE` (people→allocations/logged_time/timeoffs, projects→allocations/logged_time, accounts→tout) suppriment **sans trace**, ce qui casse les syncs externes. `delete_log` ne porte aucun contexte (pas de `person_id`, ni de snapshot). | Triggers `AFTER DELETE` génériques sur toutes les entités synchronisables, y compris pour les cascades, ou interdire le hard-delete et passer en soft-delete (`deleted_at`) pour people/projects. |
| C-05 | **[BLOQUANT]** | **BR-12 sans garde-fou ni modèle.** (a) Le verrou est « contrôle applicatif » (l.235) : aucune immutabilité en base. (b) Il n'y a pas d'entité *timesheet* (période, soumission, échéance), seulement un statut par ligne : « soumettre la semaine » = N updates non atomiques. (c) `submitted/approved/locked` : trois états alors que BR-12 n'en décrit qu'un (soumis ⇒ verrouillé) ; l'approbation n'est dans aucune BR. (d) Aucun `unlocked_by/unlocked_at`, ni `modified_by` : la traçabilité promise par BR-12 est absente. (e) `ON DELETE CASCADE` sur `people`/`projects` détruit des logs verrouillés. | Introduire `timesheets(person_id, period_start, period_end, status, submitted_at, locked_at, unlocked_by)` ou, à défaut, une règle explicite ligne par ligne. Trigger `BEFORE UPDATE/DELETE` refusant toute modification d'une ligne `locked` hors rôle admin. Remplacer le CASCADE par `RESTRICT` + désactivation. |
| C-06 | **[BLOQUANT]** | **Budgets (BR-08, BR-09, FR-06, FR-16).** `projects.budget_type` + un seul `budget_amount`. Un budget « par tâche » ou « par personne » exige des lignes (un montant/heures par `project_task` ou par `person`). `baseline_amount` est un scalaire : pas de baseline par ligne, ni versionnée, ni en heures **et** en montant. `budget_amount` n'a pas d'unité explicite (heures ou devise selon le type) ni de devise projet. | Voir 2.3 et BR-22 : table `project_budget_lines` + `project_baselines` (snapshot), colonne `projects.currency_code`. |
| C-07 | **[BLOQUANT]** | **Taux et marge (BR-08/09/13).** `rates.person_id` sans FK ; `UNIQUE(rate_card_id, role_id, person_id)` n'empêche pas les doublons si `person_id` est NULL ; aucun `rate_card_id` sur `projects` ; `people.cost_rate` **et** `rates.cost_rate` coexistent sans priorité ; aucun taux de facturation par personne ; pas de table `currencies` (le dossier §3.2 la liste) ni de taux de change. BR-09 (« taux de coût de la personne ») ne dit pas quel taux gagne ni à quelle date. | BR-23 (résolution des taux) + `projects.rate_card_id`, FK sur `rates.person_id`, index unique partiel pour les deux cas (rôle / personne). Retirer `people.cost_rate` ou le définir comme dernier recours. |

### 1.2 Défauts importants

| # | Prio | Constat | Action |
|---|---|---|---|
| C-08 | **[IMPORTANT]** | **BR-06 mal libellé.** « Un projet appartenant à un client non-facturable (`non_billable`) » : `non_billable` est sur `projects` (et `phases`), pas sur `clients`. De plus la facturabilité existe à 5 niveaux (projet, phase, tâche `project_tasks.billable`, allocation, log) sans précédence. | Reformuler BR-06 et ajouter BR-21 (précédence : le niveau le plus restrictif gagne, `billable` des niveaux inférieurs est calculé par défaut, modifiable uniquement vers « non facturable » si un parent est non facturable). |
| C-09 | **[IMPORTANT]** | **« Tentatif » triplé.** `projects.status='tentative'`, `projects.tentative`, `allocations.status='tentative'`, et `phases.status` réutilise `project_status` (donc une phase peut être « archived »). BR-07 et BR-11 ne disent pas quoi faire d'une allocation *confirmée* sur un projet *tentatif*. | BR-20 : un seul champ projet (supprimer `projects.tentative`), tentatif effectif = projet tentatif OU allocation tentative. |
| C-10 | **[IMPORTANT]** | **BR-01 vs BR-03 vs BR-13.** « Sur-allocation » (planifié > capacité), « surtemps » (BR-03 : heures allouées au-delà de la capacité) et surtemps réel (logged > capacité, attendu dans FR-08) sont confondus. BR-01 interdit de poser sur un jour non ouvré, mais BR-03 suppose des heures au-delà de la capacité, y compris capacité = 0 ; `v_utilization` renvoie `NULL` quand la capacité est 0, donc une allocation sur un férié/congé devient invisible. | BR-38 : séparer *sur-allocation* (planifié) et *surtemps* (réel), définir le comportement à capacité 0 (afficher « surbooké infini », pas NULL). |
| C-11 | **[IMPORTANT]** | **`daily_capacity` supprime les lignes de jours fériés** (`NOT EXISTS`) au lieu de renvoyer capacité 0 : la jointure de la vue perd la charge planifiée ces jours-là. Un seul congé retenu (`LIMIT 1`, pas de cumul de deux congés partiels). `approval_status <> 'declined'` compte les congés `pending` : cohérent avec BR-02 (« approuvés ou posés ») mais à acter. Pas de congé sur jour non ouvré à traiter. Pas de demi-journée fériée. | Renvoyer toujours une ligne par jour ; agréger les congés avec `LEAST(Σ, capacité)` ; documenter le traitement de `pending` (BR-29). |
| C-12 | **[IMPORTANT]** | **Jours fériés « pays + équipe » (BR-02, §3.2).** `holidays` n'a ni notion d'équipe/département, ni lien pays-personne (`people.country` manquant), ni demi-journée. Dossier §3.2 distingue Public Holidays et Team Holidays. | Ajouter `people.country`, `holidays.department_id` (NULL = tout le compte) et `holidays.hours_off` (NULL = journée entière), BR-30. |
| C-13 | **[IMPORTANT]** | **BR-05 (allocation multi-personnes).** Le modèle est 1 allocation = 1 personne ; `people_ids` de l'API est éclaté en N lignes sans lien : on ne sait pas retrouver « le groupe », ni propager une édition ou répondre à « il reste sur les autres » lors d'un congé. | `allocations.group_id UUID` (nullable) + règle d'édition (groupe vs ligne seule), BR-26. |
| C-14 | **[IMPORTANT]** | **BR-15 : contradiction dossier / schéma.** Dossier : siège = toute personne sur le Schedule, avec ou sans accès. Note SQL n°3 : siège = personne « active (`work_days_hours` > 0) ». Une personne à temps partiel sur congé long, ou un placeholder à 0 h, serait exclue à tort ; une personne `active=false` avec allocations futures serait comptée ou non selon l'interprétation. Aucun instant de comptage n'est défini (pic, fin de mois, quotidien). | BR-34. |
| C-15 | **[IMPORTANT]** | **Permissions (FR-09) et identité absentes.** Pas de table `users`/`memberships`, pas de lien utilisateur → personne, `created_by`/`modified_by` sans FK, pas de rôle Owner/Admin/PM/Member/Guest, alors que BR-12 (« seuls Admin/Owner ») et BR-15 (Guests) en dépendent. | Ajouter `users`, `account_members(role)`, `people.user_id` (nullable : placeholders et personnes sans accès). BR-33. |
| C-16 | **[IMPORTANT]** | **Intégrité multi-tenant.** Les FK ne vérifient pas que `person`, `project`, `phase`, `task` appartiennent au même `account_id` que la ligne (ex. allocation du compte A sur le projet du compte B). Pas non plus de cohérence `phase_id` ⇄ `project_id` ni `project_task_id` ⇄ `project_id`. | FK composites `(account_id, id)` ou Row Level Security + triggers ; BR-32. |
| C-17 | **[IMPORTANT]** | **Historisation inexistante.** `people.work_days_hours`, `cost_rate`, `role_id`, `department_id` sont des valeurs courantes. Changer l'horaire d'une personne modifie rétroactivement capacité, utilisation et coût des périodes passées (et des timesheets verrouillés). Même problème pour le pourcentage d'une allocation (heures dérivées de l'horaire courant). | BR-19 : tables à effet daté (`people_schedules(valid_from)`, `people_rates(valid_from)`) ou snapshots à la clôture de période. |
| C-18 | **[IMPORTANT]** | **Mode pourcentage.** `percent <= 100` interdit de dépasser 100 % alors que BR-01 autorise la sur-allocation (le mode heures autorise jusqu'à 24 h). `daily_planned_load` convertit en `work_days_hours × %` (capacité brute), pas en capacité nette de congés/fériés ; BR-11 (préremplissage en heures) et BR-08 (budget en heures) n'ont pas de règle de conversion. | BR-24. |
| C-19 | **[IMPORTANT]** | **Répétitions.** `chk_alloc_repeat` laisse passer `repeat_end_date IS NULL` (la comparaison NULL est vraie pour un CHECK) : répétition infinie non bornée non gérée par la fonction. L'enum `daily` n'a pas de sens pour une allocation multi-jours ; pas d'intervalle (toutes les 2 semaines) ; pas de gestion d'exceptions (une occurrence modifiée/supprimée) ; pas de règle pour le jour 31 en mensuel. | BR-25. |
| C-20 | **[IMPORTANT]** | **Lien planifié ⇄ réel.** `logged_time` n'a pas d'`allocation_id` : le préremplissage (BR-11) est un « miroir » sans trace de provenance ; si l'allocation est modifiée après préremplissage, rien ne dit s'il faut recalculer les brouillons. Pas de contrôle de cumul > 24 h par personne et par jour. | BR-28. |
| C-21 | **[IMPORTANT]** | **Plans et essai (BR-16/17).** `accounts.plan` est un TEXT libre ; pas de `trial_ends_at`, de date de conservation 6 mois, ni de mécanisme de feature flags. Le time tracking est Pro-only (BR-17) mais `logged_time` existe pour tous : que devient la donnée à la rétrogradation (BR-16 : « données intactes » mais fonctionnalité perdue) ? | BR-35. |
| C-22 | **[CONFORT]** | `accounts.week_start` 0..6 sans préciser 0 = dimanche ou lundi (conflit potentiel avec `ISODOW`). `default_work_hours` n'est utilisé nulle part (le défaut de `people` est codé en dur). Réglage « semaine de 37,5 h » (Dossier §3.2) sans colonne. | Aligner sur ISO (1=lundi..7=dimanche), utiliser `default_work_hours` à la création de personne. |
| C-23 | **[CONFORT]** | Entités du dossier non modélisées : `STATUS` (statuts personnalisés), `CURRENCY`, vues sauvegardées et notifications (FR-10), `capacity_per_day` (diagramme §3.1 uniquement), `team holidays`. `PERSON.tags` en `TEXT[]` : pas de référentiel de compétences (utile pour FR-17). | À inscrire au backlog schéma v1.1. |
| C-24 | **[CONFORT]** | Incohérences de nommage dossier/SQL : `hours_per_day` (SQL) vs `hours` (API), `project_task` (SQL) vs `task_id` (§3.2 LOGGED_TIME), `people_id` (dossier) vs `person_id` (SQL), `timeoff.full_day` (bool, dossier) vs `scope` (enum, SQL). | Table de correspondance dans la doc API. |

---

## 2. Cas limites

Format : **cas** → comportement attendu proposé → priorité.

### 2.1 Congé pleine journée vs allocations (BR-04, BR-05, BR-02)

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| E-01 | Congé pleine journée posé sur un jour avec allocations | Création **autorisée**, avertissement listant les allocations impactées, 3 options : conserver (sur-allocation visible), déplacer (report assisté vers le prochain jour ouvré / jour dispo), réduire. Aucune suppression silencieuse. Le choix par défaut est « conserver ». | **[BLOQUANT]** |
| E-02 | Même cas avec des **temps déjà loggés** (BR-04 cite aussi le temps loggé) | Jamais supprimer ni modifier un log (surtout `submitted`/`locked`, BR-12) ; avertir ; le congé coexiste avec les heures loggées. | **[BLOQUANT]** |
| E-03 | Congé `pending` | Compte dans la capacité (le schéma exclut seulement `declined`) mais **ne déclenche pas** l'assistant de report tant qu'il n'est pas approuvé ; l'avertissement apparaît dès la création pour l'approbateur. À trancher (Q-03). | **[IMPORTANT]** |
| E-04 | Congé refusé ou annulé après un report assisté | Les allocations déplacées ne reviennent pas automatiquement ; proposer l'annulation du report (undo, principe UX n°8). | **[IMPORTANT]** |
| E-05 | Congé partiel (`hours_per_day`) supérieur à l'horaire du jour ; deux congés se chevauchant ; congé sur jour non ouvré ; congé sur jour férié | Plafonner à la capacité du jour ; cumuler avec plafond ; ignorer les jours non ouvrés ; férié prioritaire (pas de double déduction). | **[IMPORTANT]** |
| E-06 | Congé multi-jours traversant des allocations multi-personnes | Seule la ligne de la personne en congé est impactée (BR-05) ; le groupe n'est pas rompu. | **[IMPORTANT]** |
| E-07 | Allocation créée **après** le congé (sur un jour déjà sans capacité) | Autorisée (BR-01) mais signalée immédiatement comme sur-allocation. | **[IMPORTANT]** |
| E-08 | Type de congé `deducted = false` (ex. télétravail, formation optionnelle) | Affiché mais sans effet sur la capacité ; pas d'avertissement BR-04. | **[CONFORT]** |

### 2.2 Projets tentatifs (BR-07, BR-11, FR-13)

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| T-01 | Allocation `confirmed` sur projet tentatif | Traitée comme tentative (précédence projet). À afficher en motif tentatif. | **[IMPORTANT]** |
| T-02 | Allocation `tentative` sur projet confirmé | Reste tentative ; exclue du préremplissage (BR-11 « allocations confirmées »). | **[IMPORTANT]** |
| T-03 | Passage tentatif → confirmé | Opération explicite : les allocations tentatives du projet deviennent-elles toutes confirmées ? Option : « confirmer tout » ou au cas par cas. Impact immédiat sur rapports « confirmé », budget (BR-08) et préremplissage (rétroactif sur les jours passés ?). | **[IMPORTANT]** |
| T-04 | Les heures tentatives comptent-elles dans la charge / surbooking ? | Proposition : oui dans la charge totale avec décomposition (confirmé + tentatif) et indicateur distinct ; non dans la facturation ni l'utilisation « confirmée ». À arbitrer (Q-02). | **[BLOQUANT]** |
| T-05 | Projet tentatif annulé | Statut terminal « lost » ? L'enum n'a pas ce statut ; sans lui, on supprime ou on archive en perdant la mesure de conversion du pipeline. | **[CONFORT]** |
| T-06 | Logs sur projet tentatif | Autoriser ou refuser ? Proposition : refuser le préremplissage, autoriser la saisie manuelle avec avertissement. | **[IMPORTANT]** |

### 2.3 Les 5 types de budgets (BR-08, BR-09, FR-06, FR-16)

Enum SQL : `hours_by_task`, `hours_by_person`, `money_by_task`, `money_by_person`, `fees`.

| # | Cas | Constat / proposition | Prio |
|---|---|---|---|
| B-01 | Définition de chaque type | Pas de définition formelle. Proposition : *hours_* = enveloppe en heures ; *money_* = enveloppe en devise (heures × taux de facturation) ; *by_task* / *by_person* = enveloppe répartie par ligne (`project_budget_lines`) ; *fees* = forfait (montant fixe de facturation, indépendant des heures ; la marge = forfait − coût). Les lignes doivent-elles sommer au total ? | **[BLOQUANT]** |
| B-02 | Unité de `budget_amount` | Heures ou devise selon le type : ambiguë dans l'API et les rapports. Ajouter `budget_unit` implicite par le type + `currency_code` projet. | **[BLOQUANT]** |
| B-03 | Changement de `budget_type` en cours de projet | Conversion heures ↔ montant impossible sans taux ; interdire si des lignes existent, ou conserver l'ancien jeu dans la baseline. | **[IMPORTANT]** |
| B-04 | Phases et budgets | Le dossier ne dit pas si une phase porte son propre budget (BR-09 parle de marge « au niveau phase »). Le schéma n'a pas de budget par phase. | **[IMPORTANT]** |
| B-05 | Burn : source des heures | Burn planifié (allocations, tentatives incluses ou non), burn réel (logs), ou les deux ? BR-08 dit « à chaque allocation » ; FR-07/08 exigent planifié vs réel. | **[BLOQUANT]** |
| B-06 | Allocation sur tâche inexistante dans les lignes du budget, ou sans tâche | Pour un budget `*_by_task`, imputer sur « Non assigné » + avertissement. | **[IMPORTANT]** |
| B-07 | Personne absente des lignes `*_by_person` | Idem, ligne « Autres ». | **[IMPORTANT]** |
| B-08 | `fees` et dépenses (`project_expenses`) | Les dépenses entrent-elles dans le coût (marge) ? sont-elles refacturables ? `project_expenses` n'a pas de `billable`, et la devise est libre (pas de conversion). | **[IMPORTANT]** |
| B-09 | Baseline (FR-16) | Un instant figé (`baseline_at`) : que fige-t-on (budget, périmètre, allocations) ? Baseline multiple (re-baseline après avenant) ? Le scalaire `baseline_amount` ne permet pas « estimate vs scope courant » par ligne. | **[IMPORTANT]** |
| B-10 | Budget dépassé | Alerte, jamais blocage (cohérent avec BR-01). Seuils (80/100 %) à configurer. | **[CONFORT]** |
| B-11 | Projet `non_billable` ou phase `non_billable` | Pas de budget facturable ; le coût compte quand même ; exclu de BR-13 facturable. | **[IMPORTANT]** |
| B-12 | Taux manquant pour une personne (placeholder sans rôle, rôle sans taux dans la rate card) | Coût = 0 silencieux interdit : marquer « taux manquant » dans la marge. | **[IMPORTANT]** |
| B-13 | Multi-devises | Projet en EUR, personne avec taux en USD : date de conversion (jour de l'allocation, du log, du rapport) ? | **[IMPORTANT]** |

### 2.4 Verrouillage des timesheets (BR-11, BR-12)

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| L-01 | Granularité du verrou | Jour, semaine ou période ? À définir ; recommandé : période configurable au compte (semaine par défaut), soumission atomique. | **[BLOQUANT]** |
| L-02 | « Soumission **ou échéance** » (BR-12) | L'échéance verrouille-t-elle automatiquement les brouillons non soumis (et lesquels : préremplis non confirmés) ? Job planifié avec fuseau du compte. | **[BLOQUANT]** |
| L-03 | Modification d'une allocation passée après verrouillage | L'allocation reste modifiable (planning) ; le log verrouillé n'est jamais touché ; le comparatif planifié/réel affiche l'écart. | **[IMPORTANT]** |
| L-04 | Déverrouillage par Admin/Owner | Journaliser qui/quand/pourquoi ; le log repasse `draft` ou `submitted` ? Re-soumission obligatoire. | **[IMPORTANT]** |
| L-05 | Saisie sur une période verrouillée (ajout d'une ligne) | Interdite aussi (pas seulement la modification des lignes existantes). Nécessite une entité période ou un contrôle de plage. | **[BLOQUANT]** |
| L-06 | Suppression de la personne / du projet / retrait d'équipe (BR-10) avec logs verrouillés | Conflit direct BR-10 ⇄ BR-12. Proposition : le retrait est refusé si des logs verrouillés ou approuvés existent (il faut déverrouiller ou garder la personne). | **[BLOQUANT]** |
| L-07 | Statuts `approved` vs `locked` | Un état de trop ? Si approbation = workflow manager, c'est une BR à écrire ; sinon supprimer. | **[IMPORTANT]** |
| L-08 | Préremplissage : quand et pour quelle plage ? | Matérialisation à l'ouverture de la période (snapshot) vs vue calculée à la volée. Proposition : matérialiser en brouillon, avec `allocation_id` source. | **[IMPORTANT]** |
| L-09 | Heures loggées sur jour non ouvré, congé ou férié | Autorisé (avertissement), compte comme surtemps réel. | **[IMPORTANT]** |
| L-10 | Plan Starter (pas de time tracking) | Table présente mais fonctionnalité masquée ; voir BR-35. | **[CONFORT]** |

### 2.5 Placeholders

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| P-01 | Un placeholder peut-il logger du temps ? | Non (pas de compte). Contrainte : `logged_time.person_id` ne peut pas référencer un `placeholder` (trigger). | **[IMPORTANT]** |
| P-02 | Remplacer un placeholder par une personne réelle | Opération « remplacer » : transfert des allocations (et des appartenances d'équipe), placeholder archivé ; les conflits de capacité sont signalés. Absente des BR. | **[IMPORTANT]** |
| P-03 | Capacité d'un placeholder | `work_days_hours` obligatoire (sinon pas de signal de surbooking) ; défaut = valeur du compte. | **[IMPORTANT]** |
| P-04 | Placeholder dans les rapports | Inclus/exclus de l'utilisation et de la capacité ? Proposition : séparé (« demande non staffée »). Utile pour FR-13. | **[IMPORTANT]** |
| P-05 | Taux d'un placeholder | Via son rôle dans la rate card ; sinon « taux manquant » (B-12). | **[IMPORTANT]** |
| P-06 | Siège (BR-15) vs « placeholders custom » Enterprise (BR-17) | Contradiction apparente : tous les plans ont des placeholders (P0 FR-01), mais BR-17 réserve les « placeholders custom » à Enterprise. À clarifier (Q-09). | **[IMPORTANT]** |
| P-07 | Contractor | Même traitement qu'un employé (siège, logs) ; différence uniquement de taux/rapports ? À acter. | **[CONFORT]** |

### 2.6 Fuseaux horaires et semaine

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| Z-01 | Toutes les dates métier sont des `DATE` | Dates « flottantes » du fuseau du compte : une allocation du 5 est le 5 pour tout le monde. Écrire cette règle (BR-18). | **[BLOQUANT]** |
| Z-02 | « Aujourd'hui » pour verrous, rappels, échéances, purge 72 h | Calculé dans le fuseau du compte (`accounts.timezone`), pas celui du serveur ou du navigateur. Les `TIMESTAMPTZ` restent UTC. | **[IMPORTANT]** |
| Z-03 | Personnes dans un autre fuseau / pays | Jours fériés par `people.country` ; pas de fuseau par personne pour le Schedule. Fuseau personnel seulement pour notifications (V2). | **[IMPORTANT]** |
| Z-04 | Début de semaine | `accounts.week_start` doit piloter l'affichage, les agrégats hebdomadaires et la période de timesheet, mais pas l'indexation de `work_days_hours`. | **[IMPORTANT]** |
| Z-05 | Changement de fuseau du compte | Ne modifie aucune date stockée ; ne réinterprète que les échéances futures. | **[CONFORT]** |
| Z-06 | Changement d'heure (DST) | Sans effet (granularité jour), mais attention aux `generate_series` avec `interval '1 day'` sur timestamptz : utiliser des `DATE`. | **[CONFORT]** |
| Z-07 | Semaine à cheval sur deux mois / deux périodes de rapports | Règle de découpage des heures par jour, pas par semaine. | **[CONFORT]** |

### 2.7 Allocations récurrentes

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| R-01 | Définition d'une occurrence | `[start_date, end_date]` répété par pas. Distinguer « durée de l'occurrence » et « période de série ». | **[BLOQUANT]** |
| R-02 | Édition / suppression d'une seule occurrence | Table d'exceptions (`allocation_exceptions`) ou éclatement de la série ; choix « cette occurrence / toute la série / à partir d'ici ». | **[IMPORTANT]** |
| R-03 | Série sans fin | Interdire (horizon max, ex. 12 mois) ou matérialiser paresseusement. Le schéma laisse `repeat_end_date` NULL. | **[IMPORTANT]** |
| R-04 | Occurrence tombant sur un jour non ouvré, férié ou congé | Heures ignorées sur jours non ouvrés ; sur férié/congé, conservées mais signalées (cohérent BR-01). | **[IMPORTANT]** |
| R-05 | Mensuel au 29/30/31 | Dernier jour du mois. | **[CONFORT]** |
| R-06 | Série et préremplissage / budget / verrouillage | Les occurrences passées verrouillées ne sont pas affectées par une modification de la série. | **[IMPORTANT]** |
| R-07 | Performance : expansion à la volée sur 300 personnes × 12 mois | Prévoir expansion en SQL bornée ou calcul applicatif avec cache. | **[CONFORT]** |

### 2.8 Pourcentage vs heures

| # | Cas | Comportement proposé | Prio |
|---|---|---|---|
| H-01 | Base du pourcentage | Capacité brute (`work_days_hours`) ou nette (après congés/fériés) ? Proposition : brute pour l'affichage (50 % = demi-journée), nette uniquement pour l'alerte. À trancher (Q-04). | **[BLOQUANT]** |
| H-02 | Changement d'horaire de la personne | Allocation % : les heures suivent l'horaire (dynamique) ; allocation heures : fixes. Doit être visible dans l'UI. Sans historisation (C-17) le passé bouge. | **[IMPORTANT]** |
| H-03 | % > 100 | Autoriser (cohérent BR-01), alerte visuelle. Retirer `percent <= 100` ou aligner avec un plafond à 500 %. | **[IMPORTANT]** |
| H-04 | % sur jour à capacité 0 | 0 h calculées ; l'allocation reste affichée (0 h) sans disparaître. | **[IMPORTANT]** |
| H-05 | Bascule de mode | Conversion à l'instant T, puis mode stocké ; vider l'autre champ (cf. C-02). | **[IMPORTANT]** |
| H-06 | Arrondi | Stockage décimal (NUMERIC(4,2)), arrondi d'affichage au 1/4 h ou 0,1 h ? Total sur plusieurs jours : cumuler avant d'arrondir. | **[CONFORT]** |

---

## 3. Règles de gestion manquantes (BR-18+)

| BR | Prio | Règle proposée |
|---|---|---|
| BR-18 | **[BLOQUANT]** | **Dates et semaine.** Les dates métier sont des dates calendaires du fuseau du compte (jamais converties). `work_days_hours` est indexé lundi=1..dimanche=7 (ISO). `week_start` n'affecte que l'affichage et les périodes. |
| BR-19 | **[IMPORTANT]** | **Historisation.** Horaire de travail, taux de coût, rôle et département sont à effet daté ; une modification s'applique à partir d'une date et ne change jamais une période verrouillée. |
| BR-20 | **[IMPORTANT]** | **Tentatif.** Source unique : `projects.status = tentative` ou `allocations.status = tentative`. Tentatif effectif = l'un OU l'autre. Une allocation tentative n'alimente ni le préremplissage, ni les rapports « confirmé », ni la facturation ; elle est comptée dans la charge avec une décomposition. |
| BR-21 | **[IMPORTANT]** | **Facturabilité.** Précédence : projet > phase > tâche > allocation/log. Un niveau non facturable rend tous les niveaux inférieurs non facturables par défaut ; l'inverse est impossible. |
| BR-22 | **[BLOQUANT]** | **Budget.** Définition formelle des 5 types, unité, devise, répartition en lignes (tâche/personne), règle de somme, baseline versionnée, source du burn (planifié et réel), traitement des dépenses. |
| BR-23 | **[BLOQUANT]** | **Résolution des taux.** Pour une personne P, un projet J et un jour D : taux de la rate card de J valide à D, ligne personne > ligne rôle ; à défaut taux de coût de la personne ; à défaut « taux manquant » (jamais 0 silencieux). Conversion de devise à la date de D. |
| BR-24 | **[IMPORTANT]** | **Pourcentage.** Conversion en heures = % × capacité de référence (à définir, H-01) du jour ; non plafonné à 100 % ; les heures stockées dans un log préremplis sont figées à la création. |
| BR-25 | **[IMPORTANT]** | **Répétition.** Une série est bornée (fin ou horizon maximal) ; chaque occurrence = durée de l'allocation de base ; modifications « occurrence / série / à partir d'ici » ; jours non ouvrés ignorés ; mensuel au dernier jour valide. |
| BR-26 | **[IMPORTANT]** | **Allocation multi-personnes.** Un groupe partage nom, dates, projet ; chaque membre a ses propres heures ; l'édition propose « tous / celle-ci » ; un congé n'affecte que la ligne concernée (renforce BR-05). |
| BR-27 | **[IMPORTANT]** | **Placeholders.** Ne logguent pas de temps ; ont une capacité et un rôle ; remplaçables par une personne réelle (transfert) ; comptés comme sièges (BR-15) ; reportés séparément. |
| BR-28 | **[BLOQUANT]** | **Cycle de vie du timesheet.** Période configurable, soumission atomique, échéance → verrouillage automatique, aucune écriture (ajout, modification, suppression) dans une période verrouillée, déverrouillage Admin/Owner journalisé, préremplissage matérialisé avec lien vers l'allocation source, total par personne et par jour ≤ 24 h. |
| BR-29 | **[IMPORTANT]** | **Cycle de vie des congés.** `pending` compte dans la capacité, ne déclenche l'assistant BR-04 qu'à l'approbation ; `declined` ou annulé libère la capacité ; congés cumulés plafonnés à la capacité du jour ; un congé ne s'applique qu'aux jours ouvrés. |
| BR-30 | **[IMPORTANT]** | **Jours fériés.** Portée : compte, pays de la personne, ou département/équipe ; possibilité de demi-journée ; priorité sur le congé (pas de double déduction). |
| BR-31 | **[BLOQUANT]** | **Suppression et désactivation.** Hard-delete interdit pour personnes, projets et logs approuvés/verrouillés (désactivation/archivage à la place) ; toute suppression autorisée, y compris en cascade, écrit dans `delete_log` ; retrait d'équipe (BR-10) refusé si logs verrouillés ; désactiver une personne propose de réaffecter ou supprimer ses allocations futures. |
| BR-32 | **[IMPORTANT]** | **Isolation multi-tenant.** Toute relation est intra-compte, garantie en base (FK composites ou RLS) et non seulement par l'application. |
| BR-33 | **[IMPORTANT]** | **Permissions.** Matrice Owner/Admin/PM/Member/Guest × entité × action (lecture, création, modification, suppression, verrou/déverrou, voir les taux et la marge). Un Member ne voit pas les taux de coût d'autrui ; un PM est limité à ses projets. Lien utilisateur ⇄ personne. |
| BR-34 | **[IMPORTANT]** | **Sièges.** Siège = personne non archivée présente sur le Schedule (placeholders inclus) à l'instant de comptage T (à définir : pic mensuel recommandé) ; indépendant de `work_days_hours`. |
| BR-35 | **[IMPORTANT]** | **Plans et essai.** Dates d'essai et de conservation stockées ; matrice fonctionnalité × plan appliquée côté serveur ; à la rétrogradation les données du time tracking restent intactes mais en lecture seule. |
| BR-36 | **[IMPORTANT]** | **Concurrence et temps réel.** Contrôle optimiste (`version`/`modified_at`) sur les mises à jour ; en cas de conflit, la dernière écriture gagne avec notification ; mutation idempotente (clé de requête) ; propagation < 1 s. |
| BR-37 | **[CONFORT]** | **Bornes de dates.** Une allocation hors des dates du projet ou de la phase est acceptée avec avertissement (jamais bloquée) ; une phase hors du projet idem. |
| BR-38 | **[IMPORTANT]** | **Indicateurs.** Sur-allocation = planifié > capacité nette (jour, personne). Surtemps = loggé > capacité. Capacité nulle et charge > 0 ⇒ sur-allocation maximale (jamais NULL). Dénominateurs de BR-13 explicites (capacité nette) et division par zéro définie. |
| BR-39 | **[CONFORT]** | **RGPD.** Droit à l'effacement vs `delete_log` et logs verrouillés : anonymisation de la personne (nom, e-mail) en conservant les heures. Rétention des données après suppression de compte. |
| BR-40 | **[CONFORT]** | **Annulation.** L'annulation (undo) d'une action multi-effets (report assisté, retrait d'équipe) restaure l'état exact ; durée de vie de l'undo définie. |

---

## 4. Glossaire

| Terme (FR) | Terme (API/SQL) | Définition |
|---|---|---|
| Compte | `accounts` | Tenant, entreprise cliente. Porte fuseau, devise, plan, réglages par défaut. |
| Personne | `people` | Ressource planifiable ; employee, contractor ou placeholder. |
| Placeholder | `people_type='placeholder'` | Ressource fictive (rôle à pourvoir). Siège payant (BR-15), ne logue pas. |
| Siège | — | Unité de facturation : une personne sur le Schedule. |
| Guest | — | Utilisateur en lecture seule, gratuit, hors modèle de données. |
| Allocation | `allocations` (« task » dans l'API Float) | Planification d'une personne sur un projet, entre deux dates, en heures/jour ou en % de capacité. |
| Allocation tentative / confirmée | `allocations.status` | Intention non engagée / engagée. |
| Projet tentatif | `projects.status='tentative'` | Projet de pipeline non confirmé (BR-07). |
| Capacité (brute) | `work_days_hours[jour]` | Heures ouvrées prévues pour une personne ce jour-là. |
| Capacité nette / disponibilité | `daily_capacity()` | Capacité brute − congés déduits − jours fériés (BR-02). |
| Charge planifiée | `daily_planned_load()` | Σ des heures d'allocations pour une personne et un jour. |
| Sur-allocation | — | Charge planifiée > capacité nette (signalée, jamais bloquée). |
| Sous-allocation | — | Charge planifiée < capacité nette (seuils à définir). |
| Surtemps | — | À définir : planifié au-delà de la capacité (BR-03) et/ou loggé au-delà (voir BR-38). |
| Utilisation | `v_utilization`, BR-13 | Rapport heures / capacité ; trois variantes (planifié %capacité, facturable %capacité, facturable %planifié). |
| Congé | `timeoffs` | Absence d'une personne ; pleine journée ou partielle ; workflow d'approbation. |
| Type de congé | `timeoff_types` | Catégorie ; `deducted` décide de l'effet sur la capacité. |
| Jour férié | `holidays` | Jour chômé, par pays ou global au compte. |
| Temps loggé | `logged_time` | Heures réellement travaillées ; statuts brouillon, soumis, approuvé, verrouillé. |
| Timesheet | — (entité implicite) | Ensemble des logs d'une personne sur une période, soumis et verrouillés ensemble. |
| Préremplissage | BR-11 | Création de brouillons à partir des allocations confirmées. |
| Verrouillage | `log_status='locked'` | Immutabilité d'un log (BR-12). |
| Baseline | `baseline_amount`, `baseline_at` | Version figée du budget initial. |
| Burn | — | Consommation du budget : heures ou montant planifiés / réels / enveloppe. |
| Budget (5 types) | `budget_type` | Heures par tâche, heures par personne, montant par tâche, montant par personne, forfait (fees). |
| Rate card | `rate_cards`, `rates` | Grille de taux de coût et de facturation par rôle/personne, par période et devise. |
| Taux de coût / de facturation | `cost_rate`, `bill_rate` | Coût interne horaire / prix de vente horaire. |
| Marge | BR-09 | Budget facturable − coût. |
| Phase | `phases` | Découpage d'un projet. |
| Tâche projet | `project_tasks` | Catégorie de travail nommée (≠ « task » de l'API qui désigne l'allocation). |
| Milestone | `milestones` | Jalon daté. |
| Répétition | `repeat_state` | Reproduction périodique d'une allocation jusqu'à `repeat_end_date`. |
| Delete log | `delete_log` | Flux de suppressions pour synchronisation (≥ 72 h, BR-14). |
| Vue sauvegardée | — | Combinaison de filtres nommée (FR-10). |
| Facturable / non facturable | `billable`, `non_billable` | Qualifie le travail comptable en facturation ; précédence en BR-21. |

Ambiguïté de vocabulaire à lever : « task » (allocation dans l'API Float, catégorie de travail dans notre modèle) et « surtemps ».

---

## 5. Matrice de traçabilité BR → entités/tables → cas de test

Les cas de test (TC) sont des identifiants proposés pour le chantier (d) de matrice de test. « Écart » renvoie à la section 1.

| BR | Entités / tables / fonctions | Couverture schéma | Cas de test | Écart |
|---|---|---|---|---|
| BR-01 | `people.work_days_hours`, `allocations`, `daily_planned_load`, `v_utilization` | Partielle | TC-01a allocation > capacité acceptée et signalée ; TC-01b pose sur jour non ouvré refusée ou ignorée ; TC-01c multi-jours : somme jour par jour correcte ; TC-01d lundi/dimanche (indexation) | C-01, C-02, C-10 |
| BR-02 | `daily_capacity`, `timeoffs`, `holidays`, `people.country` (absent) | Partielle | TC-02a férié global ; TC-02b férié pays ; TC-02c congé pending/approved/declined ; TC-02d deux congés partiels ; TC-02e férié + congé même jour | C-11, C-12 |
| BR-03 | `v_utilization`, rapports People | Partielle | TC-03a surtemps planifié ; TC-03b surtemps loggé ; TC-03c capacité 0 avec charge | C-10, BR-38 |
| BR-04 | `timeoffs`, `allocations`, `logged_time`, assistant de report (applicatif) | Non couvert (note n°2) | TC-04a avertissement listant les allocations ; TC-04b aucune suppression ; TC-04c report assisté puis undo ; TC-04d logs verrouillés intacts ; TC-04e congé pending | E-01..E-04 |
| BR-05 | `allocations.group_id` (absent), `timeoffs` | Non couvert | TC-05a congé d'un membre, groupe intact ; TC-05b édition groupe vs ligne | C-13 |
| BR-06 | `projects.non_billable`, `phases.non_billable`, `project_tasks.billable`, `allocations.billable` | Partielle | TC-06a projet non facturable exclu de l'utilisation facturable ; TC-06b précédence phase/tâche | C-08, BR-21 |
| BR-07 | `projects.status/tentative`, `allocations.status` | Partielle (triple source) | TC-07a heures tentatives séparées ; TC-07b tentatif → confirmé ; TC-07c allocation confirmée sur projet tentatif | C-09, T-01..T-04 |
| BR-08 | `projects.budget_*`, `project_budget_lines` (absent), `rates` | Non couvert | TC-08a burn planifié live ; TC-08b dérive vs baseline ; TC-08c 5 types de budgets (1 test par type) | C-06, B-01..B-09 |
| BR-09 | `people.cost_rate`, `rates`, `rate_cards`, `projects.rate_card_id` (absent) | Partielle | TC-09a coût par phase/personne ; TC-09b taux manquant ; TC-09c changement de taux dans le temps ; TC-09d multi-devise | C-07, C-17 |
| BR-10 | `project_team`, `allocations`, `logged_time`, `delete_log` | Non couvert | TC-10a retrait avec récapitulatif et confirmation ; TC-10b annulation du retrait ; TC-10c retrait refusé si logs verrouillés | C-03, L-06 |
| BR-11 | `logged_time` (+ `allocation_id` absent), `allocations` | Partielle | TC-11a préremplissage = allocations confirmées ; TC-11b tentatives exclues ; TC-11c modification d'allocation après préremplissage ; TC-11d répétitions ; TC-11e % → heures ; TC-11f décimal | C-20 |
| BR-12 | `logged_time.status/locked_at`, `timesheets` (absent) | Non couvert (contrôle applicatif) | TC-12a verrou à la soumission ; TC-12b verrou à l'échéance ; TC-12c ajout dans période verrouillée refusé ; TC-12d déverrouillage Admin journalisé ; TC-12e Member ne peut pas déverrouiller | C-05, L-01..L-07 |
| BR-13 | `v_utilization`, rapports | Partielle | TC-13a trois ratios ; TC-13b division par zéro ; TC-13c placeholders ; TC-13d tentatifs exclus | C-10, BR-38 |
| BR-14 | `delete_log` + triggers (absents) | Non couvert | TC-14a suppression d'allocation, congé, log tracée ; TC-14b cascade tracée ; TC-14c rétention 72 h et purge ; TC-14d lecture incrémentale par curseur | C-04 |
| BR-15 | `people`, `accounts.plan` | Contradiction | TC-15a placeholder compte ; TC-15b personne sans accès compte ; TC-15c Guest non compté ; TC-15d personne archivée | C-14, BR-34 |
| BR-16 | `accounts.plan`, `trial_ends_at` (absent) | Non couvert | TC-16a essai 30 j ; TC-16b conservation 6 mois ; TC-16c rétrogradation, données intactes | C-21 |
| BR-17 | `accounts.plan`, feature flags (absents) | Non couvert | TC-17a matrice plan × fonctionnalité (API et UI) ; TC-17b volume non limité | C-21, P-06 |
| BR-18 | `accounts.timezone`, `week_start`, `work_days_hours` | À créer | TC-18a dates stables entre fuseaux ; TC-18b début de semaine dimanche/lundi ; TC-18c DST | Z-01..Z-07 |
| BR-19 | `people_schedules`, `people_rates` (à créer) | À créer | TC-19a changement d'horaire n'altère pas le passé ; TC-19b période verrouillée | C-17 |
| BR-20 | `projects.status`, `allocations.status` | À créer | TC-20a matrice projet × allocation (4 combinaisons) | C-09 |
| BR-21 | `billable` à 5 niveaux | À créer | TC-21a précédence ; TC-21b tentative d'activer facturable sous parent non facturable | C-08 |
| BR-22 | `project_budget_lines`, `project_baselines` (à créer) | À créer | voir TC-08 | C-06 |
| BR-23 | `rates`, `rate_cards`, `currencies` | À créer | voir TC-09 | C-07 |
| BR-24 | `allocations.percent` | Partielle | TC-24a % brut/net ; TC-24b > 100 % ; TC-24c horaire à 0 | C-18, H-01..H-06 |
| BR-25 | `allocations.repeat_*`, `allocation_exceptions` (à créer) | Partielle (fonction fausse) | TC-25a hebdo borné ; TC-25b édition d'une occurrence ; TC-25c mensuel le 31 ; TC-25d série sans fin refusée | C-02, C-19 |
| BR-26 | `allocations.group_id` | À créer | voir TC-05 | C-13 |
| BR-27 | `people_type`, trigger sur `logged_time` | À créer | TC-27a log refusé pour placeholder ; TC-27b remplacement ; TC-27c rapport séparé | P-01..P-05 |
| BR-28 | `timesheets`, `logged_time.allocation_id` | À créer | voir TC-11, TC-12 + TC-28a total jour ≤ 24 h | C-05, C-20 |
| BR-29 | `timeoffs.approval_status` | Partielle | voir TC-04, TC-02 | E-03..E-08 |
| BR-30 | `holidays` (+ `department_id`, `hours_off`) | Partielle | TC-30a férié équipe ; TC-30b demi-journée | C-12 |
| BR-31 | FK CASCADE vs RESTRICT, `deleted_at` | Contradiction | TC-31a suppression refusée si logs verrouillés ; TC-31b désactivation avec allocations futures | C-04, C-05, L-06 |
| BR-32 | FK composites / RLS | Non couvert | TC-32a référence inter-comptes refusée ; TC-32b phase d'un autre projet refusée | C-16 |
| BR-33 | `users`, `account_members` | Non couvert | TC-33a matrice de permissions (une ligne par rôle et action) ; TC-33b masquage des taux | C-15 |
| BR-34 | `people`, comptage de sièges | À créer | voir TC-15 | C-14 |
| BR-35 | `accounts.plan`, dates d'essai | À créer | voir TC-16/17 | C-21 |
| BR-36 | `version` / `modified_at` | À créer | TC-36a deux clients éditent la même allocation ; TC-36b propagation < 1 s ; TC-36c idempotence | — |
| BR-37 | dates projet/phase vs allocation | À créer | TC-37a avertissement hors bornes | — |
| BR-38 | `v_utilization` | À créer | voir TC-03, TC-13 | C-10 |
| BR-39 | anonymisation | À créer | TC-39a effacement conserve les heures | — |
| BR-40 | undo applicatif | À créer | TC-40a undo d'un report assisté | — |

Chantier à lancer en priorité : un jeu de tests SQL de non-régression pour `daily_planned_load` et `daily_capacity` (TC-01*, TC-02*, TC-25*) avant tout autre développement du calcul de capacité.

---

## 6. Questions ouvertes

| # | Prio | Question | À trancher par |
|---|---|---|---|
| Q-01 | **[BLOQUANT]** | Convention de `work_days_hours` : lundi-first (ISO) ou celle de l'API Float (à vérifier) ? Voulons-nous la compatibilité d'import/export ? | Architecte + PM |
| Q-02 | **[BLOQUANT]** | Les heures tentatives comptent-elles dans la sur-allocation et l'utilisation, ou seulement dans une vue « demande/pipeline » ? | PM |
| Q-03 | **[IMPORTANT]** | Un congé `pending` déclenche-t-il l'avertissement BR-04 et réduit-il la capacité ? | PM |
| Q-04 | **[BLOQUANT]** | Le pourcentage s'applique-t-il à la capacité brute ou nette ? | PM + UX |
| Q-05 | **[BLOQUANT]** | Définition exacte des 5 types de budgets (en particulier `fees`) et source du burn (planifié, réel ou les deux) ? Les lignes `by_task` / `by_person` doivent-elles sommer au total ? | PM + finance |
| Q-06 | **[BLOQUANT]** | Granularité et rythme des timesheets (jour/semaine), échéance automatique, existence d'une approbation manager (états `approved` vs `locked`) ? | PM |
| Q-07 | **[BLOQUANT]** | Retrait d'équipe vs logs verrouillés : refuser, ou autoriser avec exception Admin ? Les allocations exigent-elles l'appartenance à `project_team` ? | PM + architecte |
| Q-08 | **[IMPORTANT]** | Historisation : effet daté en base (recommandé) ou snapshot à la clôture ? À partir de quelle date démarre l'historique (import) ? | Architecte |
| Q-09 | **[IMPORTANT]** | « Placeholders custom » (BR-17 Enterprise) : de quoi parle-t-on exactement, puisque les placeholders sont P0 pour tous les plans ? | PM |
| Q-10 | **[IMPORTANT]** | Instant de comptage des sièges (BR-15) : pic, quotidien, fin de mois ? Une personne archivée est-elle comptée ? | PM + finance |
| Q-11 | **[IMPORTANT]** | Multi-devises : taux de change (source, date de conversion) ou devise unique par compte au MVP ? | PM + finance |
| Q-12 | **[IMPORTANT]** | Autorise-t-on les allocations sur jours non ouvrés (week-end, pour du surtemps volontaire), BR-01 ? Dans ce cas la phrase « ne peut être posée que sur un jour ouvré » est à retirer. | PM |
| Q-13 | **[IMPORTANT]** | BR-04 : à la parité Float (suppression) ou arbitrage rebuild (avertir + reporter) ? Le dossier dit « à arbitrer » ; la note SQL n°2 l'a déjà tranché. Valider formellement et documenter la déviation. | CPTO |
| Q-14 | **[IMPORTANT]** | Statut projet : faut-il un statut « perdu » pour le pipeline tentatif ? `on_hold` et `archived` empêchent-ils d'allouer ou de logger ? | PM |
| Q-15 | **[IMPORTANT]** | Un projet sans équipe/rôle explicite : le PM (`project_manager_id`) doit-il être une personne du Schedule (donc un siège) ? | PM |
| Q-16 | **[CONFORT]** | Y a-t-il une validation d'allocation par le manager (workflow), ou l'édition est-elle libre pour PM/Admin ? | PM |
| Q-17 | **[CONFORT]** | Fuseau par personne pour les notifications et rappels de timesheet ? | UX |
| Q-18 | **[CONFORT]** | Exigences RGPD/SOC2 : durée de rétention de `delete_log` au-delà de 72 h, effacement vs obligations comptables. | CPTO / sécurité |

---

## 7. Ordre de traitement recommandé

1. **Avant toute migration** : Q-01, Q-02, Q-04, Q-05, Q-06, Q-07 (6 décisions) puis corriger C-01..C-07 dans une v1.1 du schéma, accompagnée d'un jeu de tests SQL.
2. **Avant fin du MVP** : BR-19..BR-21, BR-24..BR-27, BR-29..BR-34, BR-36, BR-38.
3. **Ensuite** : BR-35, BR-37, BR-39, BR-40 et les points [CONFORT].
