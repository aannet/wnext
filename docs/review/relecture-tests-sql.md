# Fiche de relecture humaine : tests SQL de non-régression

Date : 2026-10-20. Destinataire : Alec (relecture humaine).
Critère de sortie P1 concerné : « jeu de tests SQL de non-régression écrit/relu humain ».
Périmètre : `tests/sql/schema_tests.sql` (T00 à T20) et `tests/sql/people_history_tests.sql` (H01 à H09), appliqués sur `schema.sql` (baseline 0001) et `migrations/0002_people_history.sql`, `migrations/0003_saved_views.sql`.

Les cases « [ ] relu » sont à cocher par Alec. Une assertion relue et jugée correcte peut être cochée ; une assertion douteuse se note en commentaire dans la fiche.

## 1. Comment lancer les tests

**Suite complète (étage rapide, inclut les migrations et les deux fichiers SQL)** :

```bash
make check            # ou seulement l'étape tests : npm run test:fast
```

**Ciblé, migrations et SQL seulement** (PostgreSQL embarqué `embedded-postgres`, base vierge par test) :

```bash
npm run test:migrations
```

- `tests/migrations/migrate.test.ts` : migrations depuis zéro (baseline `schema.sql`, puis `migrations/`), puis rejoue `tests/sql/schema_tests.sql`.
- `tests/migrations/people-history.test.ts` : base au seul `0001` avec des personnes, migrée vers `0002`, puis `tests/sql/people_history_tests.sql`, puis `tests/sql/schema_tests.sql`.

**Manuel avec `psql`** (PostgreSQL >= 15, rôle superuser ou propriétaire, base vierge) :

```bash
psql -v ON_ERROR_STOP=1 -f schema.sql <db>
psql -v ON_ERROR_STOP=1 -f tests/sql/schema_tests.sql <db>
```

Pour `people_history_tests.sql`, la base doit être migrée : `schema.sql`, puis `migrations/0002_people_history.sql` (et `0003_saved_views.sql`), puis `psql -v ON_ERROR_STOP=1 -f tests/sql/people_history_tests.sql <db>`.

Comportement commun : tout est dans une transaction annulée à la fin (aucune trace dans la base). La première assertion en échec lève `FAIL: <libellé>` et arrête le run. Les migrations sont en elles-mêmes lancées avec `npm run db:migrate` (base réelle, pas pour les tests).

## 2. Tests SQL, un tableau par fichier

Légende : « BR » = balise présente dans le fichier ou la section ; « (implicite) » = non balisé, rattachement déduit du sujet. Les identifiants sont ceux des libellés `t.ok` / `t.eq` / `t.raises`. Quelques identifiants n'existent pas dans la suite (T09s, T10a à T10c, T14a, T16o) : ce n'est pas une erreur de copie, la numérotation a des trous.

### 2.1 `tests/sql/schema_tests.sql`

| Section | Identifiants | BR | Ce qui est vérifié (une ligne) | Relu |
|---|---|---|---|---|
| T00 | T00a à T00n | BR-18 ; BR-38 (seuils) | Convention de semaine (index 0 = lundi), défauts `work_days_hours` et `week_start`, seuils de capacité par défaut (80 % / 90 %) et refus des valeurs hors bornes. | [ ] |
| T01 | T01a à T01f | BR-01 | Allocation multi-jours : somme jour par jour, week-end ignoré, fenêtre partielle. | [ ] |
| T02 | T02a à T02c | BR-01 (H-01) | Pourcentage (50 %, 150 % accepté) et horaire asymétrique. | [ ] |
| T03 | T03a à T03m | BR-25 | Répétitions hebdomadaires, quotidiennes et mensuelles (fin de série, saut du week-end, clamp au 28/02 et retour au 31/03). | [ ] |
| T04 | T04a à T04d | BR-07, BR-13, BR-20, BR-21 | Planifié total, tentatif (projet et allocation), facturable (confirmé seulement, phase non facturable). | [ ] |
| T05 | T05a à T05g | BR-01 à BR-03 (en-tête) | Capacité de base : 7 lignes par jour même non ouvré, horaire asymétrique, plage > 400 jours et plage inversée refusées. | [ ] |
| T06 | T06a à T06n | BR-02, BR-30 | Jours fériés par pays, équipe, compte et demi-journée ; charge conservée sur férié, surtemps, utilisation infinie (BR-38). | [ ] |
| T07 | T07a à T07y | BR-02, BR-04, BR-05, BR-29 | Congés : pleine journée, cumul partiel, plafonnement, jour non ouvré, type non déduit, pas de double déduction avec un férié, demi-journées, chevauchements refusés (EXCLUDE). | [ ] |
| T08 | T08a à T08h | BR-01, BR-03, BR-38 | Sur-allocation calculée (1,375, `is_overbooked`), sous-charge sans surtemps, personne sans allocation. | [ ] |
| T09 | T09a à T09x (sauf T09s) | (implicite : intégrité) | Contraintes : longueur et valeurs de `work_days_hours`, e-mail unique, modes hours/percentage, répétition et fin de série, FK composites de compte (BR-32), cohérence phase/tâche/projet, fériés en double, taux de coût et budgets. | [ ] |
| T10 | T10d | (implicite : placeholders) | Placeholder : capacité calculée (0 h, ligne présente). Seule assertion libellée de la section. | [ ] |
| T11 | T11a à T11e | (implicite : audit) | `created_by`, `modified_by`, `row_version` (touch_row), `modified_at >= created_at`. | [ ] |
| T12 | T12a à T12g | BR-14 | `delete_log` par trigger, y compris en cascade (allocation, congé, personne, projet) ; curseur monotone. | [ ] |
| T13 | T13a à T13n | BR-10, BR-12, BR-27, BR-28 | `logged_time` : RESTRICT (personne, projet), brouillon modifiable, soumission, rôle member bloqué, déverrouillage admin, 24 h par jour refusées, placeholder ne loggue pas, pré-remplissage sans doublon. | [ ] |
| T14 | T14b à T14e | BR-10 | Récapitulatif de retrait d'équipe : nombre d'allocations, de logs, `can_remove` faux si log soumis. | [ ] |
| T15 | T15a à T15e | (implicite : FR-10 pour les vues) | Identité : `account_members` avec FK composite, une personne par utilisateur, vues sauvegardées d'un non-membre refusées, nom unique, `project_managers`. | [ ] |
| T16 | T16a à T16t (sans T16o) | BR-32 | RLS : rôle `app_user` sans BYPASSRLS, RLS ENABLE + FORCE sur toutes les tables, fermé par défaut, isolation A/B, WITH CHECK, `utilization` sous RLS, `own_memberships`, verrou timesheet. | [ ] |
| T17 | T17a à T17y (dont n2 à n6, u2) | BR-14 | Journal `change_log` : seq par compte sans trou, annulation sans trou, versions, cascades, structure projet journalisée, finances exclues, RLS du journal, purge >= 72 h. | [ ] |
| T18 | T18a à T18k | BR-32 | RLS sur 100 % des tables : inventaire fermé (seuls `users` et `accounts` sans `account_id`), pas de vue, politique `tenant_isolation`, une seule fonction SECURITY DEFINER, preuve table par table. **T18d et T18h modifiés par 0003, voir section 3.1.** | [ ] |
| T19 | T19a, T19a2, T19b à T19i | BR-14, BR-31 | `delete_log` : liste fermée des tables journalisées, RESTRICT du projet avec temps loggé, cascade complète, suppression du client, purge `purge_delete_log` >= 72 h (71 h refusée, 72 h acceptée). | [ ] |
| T20 | T20a à T20i | (implicite : BR-32) | `users` : RLS active sans FORCE (le propriétaire provisionne et résout la connexion), sans contexte aucun utilisateur visible, `user_id_for_subject`, isolation par compte, e-mail d'un autre compte illisible, `app_user` ne crée pas d'utilisateur. **Priorité de relecture, voir section 3.4.** | [ ] |

### 2.2 `tests/sql/people_history_tests.sql` (BR-19, historisation datée)

| Section | Identifiants | BR | Ce qui est vérifié (une ligne) | Relu |
|---|---|---|---|---|
| H01 | H01a à H01c | BR-19 | Création : une période ouverte par attribut, période initiale depuis toujours, audit `created_by`. | [ ] |
| H02 | H02a à H02h | BR-19, BR-24 | Changement d'horaire au 1er du mois : capacité avant et après (8 h puis 4 h), semaine mixte, charge à 50 % suivant la base brute, jour devenu non ouvré. | [ ] |
| H03 | H03a à H03i | BR-19 | « À partir de » : une date antérieure remplace les périodes suivantes, même date d'effet remplacée (pas dupliquée), changement de département, rôle et taux historisés ensemble, valeur inchangée sans période. | [ ] |
| H04 | H04a | BR-19 | Date d'effet par défaut = aujourd'hui dans le fuseau du compte (UTC+14 pour le test). | [ ] |
| H05 | H05a à H05h | BR-19 | Écriture directe dans l'historique refusée (INSERT, UPDATE, DELETE), chevauchement refusé (EXCLUDE), valeur hors colonne, horaire de 6 jours, département d'un autre compte. | [ ] |
| H06 | H06a à H06i | BR-19, BR-12 | Période verrouillée : `valid_from` le jour verrouillé ou avant refusé (département, taux de coût), brouillon ignoré, lendemain accepté, déverrouillage, suppression de département acceptée malgré le verrou. **Voir section 3.2 et 3.3.** | [ ] |
| H07 | H07a à H07c | BR-19 | Invariants : une période ouverte par (personne, attribut), pas de trou, `people` = valeur de la période ouverte. | [ ] |
| H08 | H08a à H08g | BR-32, BR-19 | RLS de `people_history` (active, forcée, `tenant_isolation`), isolation des périodes et de la capacité datée entre comptes, écriture directe refusée sous `app_user`. | [ ] |
| H09 | H09a à H09d | BR-14 | Cascade de suppression de l'historique, journalisation sur `people` seulement (pas de `change_log` propre), `row_version` incrémentée sur la période fermée. | [ ] |

## 3. Points d'attention

### 3.1 T18d et T18h : assertions relâchées par la migration 0003

La migration `migrations/0003_saved_views.sql` (commit `e5035bc`, 2026-10-20, Alec ANNET, « API: vues sauvegardées ... et migration 0003 (RLS restrictive) ») ajoute sur `saved_views` une politique **RESTRICTIVE** `visible_saved_views` : `USING (owner_user_id = app_user_id() OR shared)`, `WITH CHECK (true)`. Elle s'ajoute en ET à `tenant_isolation`, pour qu'une vue privée ne soit pas lisible par un autre membre du compte même si l'API oublie son filtre.

Diff du commit sur `tests/sql/schema_tests.sql` (7 lignes) :

- **T18d** : la liste attendue des politiques exclut désormais `visible_saved_views` (`AND policyname <> 'visible_saved_views'`). Conséquence : l'assertion ne vérifie plus la présence de cette politique. Sa présence n'est couverte que par `apps/api/test/saved-views.test.ts` (cité dans le commentaire du fichier).
- **T18h** : pour `saved_views`, la condition d'égalité devient `r.visible_own <= x.own`. Pour les autres tables, l'égalité stricte reste.

Pourquoi : avec la politique restrictive, le nombre de lignes de `saved_views` visibles pour l'utilisateur A est inférieur ou égal au décompte « own » calculé sans cette politique (les vues privées des autres membres sont masquées). L'égalité stricte ne tenait donc plus pour cette seule table. Le relâchement porte **uniquement sur `saved_views` et uniquement dans le sens « moins de lignes »** ; T18g (aucune ligne d'un autre compte visible) reste strict, et T18i/T18j (UPDATE/DELETE hors compte) aussi.

**À trancher par Alec** : accepter ce relâchement, ou remplacer T18d par une assertion explicite sur `visible_saved_views` (RESTRICTIVE, `cmd = ALL`, `USING` attendu) et T18h par un décompte exact des vues visibles (propriétaire + partagées). Le second est plus strict et évite qu'un futur bug de visibilité passe inaperçu dans T18h.

### 3.2 Définition de « période verrouillée » retenue (BR-19)

BR-19 dit qu'une modification ne change jamais une période verrouillée, mais le schéma n'a ni entité « période » ni date de clôture (Q-06 ouverte, cf. en-tête de `migrations/0002_people_history.sql`). La définition retenue utilise le seul verrou existant, celui des temps saisis (BR-12) :

- `person_locked_through(p_person_id)` = `max(work_date)` des `logged_time` de la personne dont `status <> 'draft'` (`submitted`, `approved`, `locked`), `migrations/0002_people_history.sql` lignes 111-114.
- Une écriture datée (`people_history`, y compris via le département ou le taux de coût) dont `valid_from` est NULL ou `<=` cette date est refusée par le trigger `guard_people_history` avec `ERRCODE = 'WN019'` (`migrations/0002_people_history.sql` lignes 125-129). L'API traduit ce code en 409 `PERSON_HISTORY_LOCKED`. Pour corriger, un Owner/Admin déverrouille d'abord les temps.
- Les tests H06a à H06h couvrent cette règle (brouillon ignoré, lendemain accepté, déverrouillage).

Conséquence à valider : une seule ligne soumise le 20/03 fige toute la capacité et tous les coûts datés antérieurs au 20/03 pour cette personne, et ce verrou ne recule jamais tant que les temps ne sont pas déverrouillés.

### 3.3 Question ouverte : vraie date de clôture

- Faut-il une date de clôture par compte (ou par période de paie) plutôt que le plus grand `work_date` non-draft par personne ? Une date de clôture est prévisible pour les utilisateurs ; le verrou actuel dépend de la dernière soumission.
- H06i acte que la suppression d'un département référencé est acceptée malgré le verrou (la cascade remet la référence à NULL, ce n'est pas une modification datée). À confirmer comme choix métier.

### 3.4 T18 à T20 (priorité de relecture)

- **T18 (RLS table par table, BR-32)** : vérifie l'inventaire fermé (seuls `users` et `accounts` sans `account_id`), l'absence de vues (une vue contournerait la RLS de l'appelant), le texte exact de la politique `tenant_isolation` (T18c compare la chaîne `qual`/`with_check` : fragile si Postgres reformate l'expression), une seule fonction SECURITY DEFINER (`user_id_for_subject`), puis la preuve table par table T18f à T18k. Points à regarder : le relâchement 0003 (section 3.1), et T18k qui vérifie que toutes les tables ont été sondées (pas de table oubliée dans la liste `t18`). Toute nouvelle table cloisonnée doit être ajoutée à cette liste.
- **T19 (`delete_log`, BR-14/BR-31)** : T19a vérifie une liste fermée de tables portant le trigger. Ajouter une table journalisée sans mettre à jour la liste fera échouer le test (voulu), mais la liste est à maintenir à la main. T19i (purge à 72 h pile acceptée) et T19f (71 h refusée) bornent la rétention minimale.
- **T20 (`users`, RLS sans FORCE)** : `users` a une RLS activée mais **sans FORCE**, volontairement (le propriétaire provisionne et résout la connexion). Donc le propriétaire de la table contourne la RLS : c'est le point de sécurité à valider. Les tests T20b à T20i vérifient l'isolation côté `app_user` (voir soi-même et les membres du compte courant, pas d'e-mail d'un autre compte, pas de création d'utilisateur). `user_id_for_subject` est la seule fonction SECURITY DEFINER (T18e).

### 3.5 Autres points

- **Trous de numérotation** : T09s, T10a à T10c, T14a et T16o n'existent pas. Vérifier si ce sont des tests retirés (à documenter) ou des oublis.
- **Revue humaine et CODEOWNERS** : `.github/CODEOWNERS` protège `/db/migrations/` et `/db/rls/` (@cpto, @dba-humain, @securite), mais le dépôt n'a ni répertoire `db/` (vérifié) ni de règle pour `migrations/` ni pour `tests/sql/`. Les migrations et les tests SQL ne sont donc pas soumis à une approbation humaine obligatoire par CODEOWNERS. La présente fiche ne remplace pas une règle de revue : à décider.

## 4. Commits de contrat à relire (CODEOWNERS `packages/contracts`)

`packages/contracts/` est sous `@cpto` (`.github/CODEOWNERS`, ligne 29) : revue humaine obligatoire. Liste complète des commits touchant ce chemin, du plus ancien au plus récent (`git log --reverse -- packages/contracts`). Les commits du **2026-10-20** sont marqués `[2026-10-20]` ; ils sont à relire en priorité (la fiche ne vérifie pas leur statut de revue sur GitHub).

Commits du 2026-10-20 (6) :

- `[2026-10-20]` `a551c70` : Contrat: POST /allocations/{id}/split, modifier ou supprimer une occurrence d'une serie repetee
- `[2026-10-20]` `69b4b86` : Contracts: BR-19 : PATCH /people/{id} accepte effectiveFrom, GET /people/{id}/history, code PERSON_HISTORY_LOCKED
- `[2026-10-20]` `86332f2` : Contracts: vues sauvegardées du Schedule : SavedView, filtres typés, /api/v1/saved-views (liste, création, PATCH, DELETE avec If-Match)
- `[2026-10-20]` `e1fb704` : Contracts: GET /api/v1/saved-views/{id} (relire la version après un conflit)
- `[2026-10-20]` `fa10928` : Contracts: descriptions seulement (aucune rupture) : asOf de la désactivation par défaut = aujourd'hui dans le fuseau du compte ; retrait d'équipe limité aux projets gérés pour un project_manager (BR-33)
- `[2026-10-20]` `f047256` : Contracts: GET /schedule porte l'horaire daté (SchedulePerson.workSchedule, BR-19) et les phases (SchedulePhase, BR-37), champs optionnels ; corps facultatif pour désactivation et retrait d'équipe (E-04) ; 404 documenté sur GET /logged-time (E-05)

Historique complet (du plus ancien au plus récent) :

- `5d71bc7` 2026-10-18 : P0 L1: squelette monorepo (workspaces contracts, engine, api, web)
- `3af9ba7` 2026-10-18 : P0 L7: chaîne Zod -> OpenAPI -> client TS (endpoint health), check:contract; scripts guard:* branchés
- `f9fa2a1` 2026-10-18 : Contrats (outillage): paramètres de requête dans la spec, le client généré et check:breaking
- `3f962bb` 2026-10-18 : Contrat: GET /api/v1/schedule (fenêtre, filtres, pagination par curseur, curseur de changement, version par entité)
- `c6f7df9` 2026-10-18 : Contrats (outillage): parametres de chemin, en-tetes, corps JSON, reponse 204; check:breaking cote requete
- `c7d4ca2` 2026-10-18 : Contrat: ecriture des allocations (POST/PATCH/DELETE /allocations, If-Match, 409 VERSION_CONFLICT, 428)
- `e1a7937` 2026-10-18 : Contrat: evenements temps reel (subscribe/changes/ready/resync/error), versionnes, references seules
- `da9100d` 2026-10-18 : Contrat: ecriture des conges (POST/PATCH/DELETE /timeoffs, If-Match, 409 TIMEOFF_OVERLAP)
- `4b3e255` 2026-10-18 : Contrat: ecriture des personnes (POST/PATCH /people, If-Match, desactivation plutot que suppression)
- `d958eaa` 2026-10-18 : Contrat: retrait d'equipe BR-10 (recapitulatif GET + execution POST avec confirmation, 3 codes dedies)
- `1388595` 2026-10-18 : Contrat: ajout a l'equipe projet (PUT /projects/{p}/team/{person}, idempotent, sans corps)
- `1432891` 2026-10-18 : Contrat: ecriture des entites de reference (departements, roles, types de conge, feries, projets), version sur les listes du Schedule, codes ALREADY_EXISTS et REFERENCE_IN_USE
- `c69af07` 2026-10-18 : Contrat: refus a l'upgrade temps reel (401/404/429/500), Retry-After et conduite du client, constantes REALTIME_UPGRADE_STATUS et REALTIME_RETRY_AFTER_SECONDS
- `4011e63` 2026-10-18 : Contrat: lecture des entites de reference (liste paginee et lecture par id pour departements, roles, types de conge, feries, projets)
- `3fb0e67` 2026-10-18 : Contrat: ticket d'upgrade du temps reel (POST /api/v1/realtime/ticket, ?ticket=, usage unique, 30 s) pour les navigateurs sans en-tete sur WebSocket
- `d3c81b4` 2026-10-18 : Contrat: clients, phases et taches de projet (lecture paginee, lecture par id, ecriture avec If-Match, suppression refusee si referencee)
- `b861fb0` 2026-10-18 : Contrat: lecture de l'equipe d'un projet (GET /projects/{projectId}/team, liste paginee)
- `ff9ea37` 2026-10-18 : Contrat: ajout en lot a l'equipe d'un projet (POST /projects/{projectId}/team, tout ou rien, idempotent)
- `60d2e4a` 2026-10-18 : Contrat: lecture des personnes (liste paginee filtrable, lecture par id) et projets d'une personne (equipe ou allocations)
- `ee8d78e` 2026-10-18 : Contrat: lecture des allocations (par id, et d'un projet sur une fenetre avec filtres personne et statut)
- `648dc6b` 2026-10-18 : Contrat: lecture des allocations d'une personne sur une fenetre (filtres projet et statut)
- `2fc2db8` 2026-10-18 : Contrat: jalons de projet (CRUD a plat, filtres projet, phase et intervalle d'echeance)
- `888a29c` 2026-10-18 : Contrat: depenses de projet et lignes de budget (montants decimaux, lecture reservee aux gestionnaires)
- `dca248c` 2026-10-18 : Contrat: limite de debit (code RATE_LIMITED, 429 sur le ticket temps reel, upgrade limite par compte)
- `f131376` 2026-10-18 : Contrat: allocations multi-personnes (BR-26) : creation de groupe, edition et suppression de tout le groupe
- `b4bceee` 2026-10-18 : Fusion: groupes d'allocations (sujet B) apres limitation de debit (sujet A); make check a 0
- `23e8187` 2026-10-18 : Contrat: temps reel de la structure des projets (clients, phases, taches, jalons, equipe) ; finances hors journal
- `43a9099` 2026-10-18 : Contrat: desactivation d'une personne avec ses allocations futures (BR-31) : recapitulatif puis confirmation, reaffecter ou supprimer
- `5dbd322` 2026-10-18 : Contrat: commentaires alignes sur le temps reel de la structure des projets
- `491aa7b` 2026-10-19 : Merge branch 'worktree-agent-a78079fb63fba1af2'
- `cf34afc` 2026-10-19 : Contrat: temps saisis (logged_time) : pre-remplissage depuis les allocations confirmees, soumission atomique, deverrouillage admin (BR-11, BR-12, BR-28)
- `f763c45` 2026-10-19 : Contrat: desactivation, remplacant deja membre du groupe d'une allocation (BR-26) : 409 reason already_in_group
- `5a884e6` 2026-10-19 : Contrat: GET /schedule expose le fuseau du compte (account.timezone), pour Aujourd'hui et les dates metier (BR-18)
- `d0dd82b` 2026-10-19 : Contrat: bornes du projet dans ScheduleProject (BR-37 calcule par le client), logged_time diffuse en temps reel
- `[2026-10-20]` `a551c70` : Contrat: POST /allocations/{id}/split, modifier ou supprimer une occurrence d'une serie repetee
- `[2026-10-20]` `69b4b86` : Contracts: BR-19 : PATCH /people/{id} accepte effectiveFrom, GET /people/{id}/history, code PERSON_HISTORY_LOCKED
- `[2026-10-20]` `86332f2` : Contracts: vues sauvegardées du Schedule : SavedView, filtres typés, /api/v1/saved-views (liste, création, PATCH, DELETE avec If-Match)
- `[2026-10-20]` `e1fb704` : Contracts: GET /api/v1/saved-views/{id} (relire la version après un conflit)
- `[2026-10-20]` `fa10928` : Contracts: descriptions seulement (aucune rupture) : asOf de la désactivation par défaut = aujourd'hui dans le fuseau du compte ; retrait d'équipe limité aux projets gérés pour un project_manager (BR-33)
- `[2026-10-20]` `f047256` : Contracts: GET /schedule porte l'horaire daté (SchedulePerson.workSchedule, BR-19) et les phases (SchedulePhase, BR-37), champs optionnels ; corps facultatif pour désactivation et retrait d'équipe (E-04) ; 404 documenté sur GET /logged-time (E-05)
