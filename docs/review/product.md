# Revue produit (PM senior) — Rebuild Float

Périmètre : dossier v1.0 + `schema.sql.txt` v1.0. Légende : **[BLOQUANT]** empêche de démarrer/livrer, **[IMPORTANT]** à trancher avant le sprint concerné, **[CONFORT]** amélioration.

## 0. Constat global

- **[BLOQUANT] Le P0 du dossier n'est pas un MVP.** FR-01..FR-10 = ~100 % de la parité Float (budgets 5 types, timesheets, rapports, permissions, notifications). Or la roadmap §5.5 place le time tracking en T2 et budgets/marge en T3 : **le backlog et la roadmap se contredisent**. Il faut un P0 réduit (section 2) et renommer le reste P0.5.
- **[IMPORTANT]** Le schéma ne couvre pas FR-09/FR-10 : pas de table `users`/auth/rôles de permission, pas de `saved_views`, `notifications`, `statuses`, ni table des tags normalisée. Ni sièges/abonnements (BR-15..17).
- **[IMPORTANT]** BR-15 est défini deux fois différemment : dossier = « toute personne sur le Schedule » ; schéma (note 3) = « `active` avec `work_days_hours > 0` ». À unifier (voir §3).

## 1. Backlog : epics, stories, critères d'acceptation (P0)

Format : Given/When/Then abrégé. Chaque CA doit devenir un test automatisé.

### E1 — Organisation & personnes (FR-01)
- **US-1.1** En tant qu'admin, je crée une personne (employee/contractor/placeholder) avec rôle, département, tags, jours/heures ouvrés.
  - CA : création < 3 champs obligatoires (nom, type, horaires par défaut du compte) ; `work_days_hours` accepte 7 valeurs, 0–24 ; un placeholder n'exige pas d'e-mail ; l'archivage (`active=false`) conserve l'historique et retire la personne du Schedule par défaut.
- **US-1.2** Import CSV de personnes/projets/clients (time-to-value < 1 jour — cf. KPI). **[IMPORTANT]** absent du backlog, indispensable à l'adoption.
  - CA : fichier de 300 lignes importé < 30 s ; rapport d'erreurs ligne par ligne ; ré-import idempotent (clé e-mail / project_code).

### E2 — Clients & projets (FR-02)
- **US-2.1** Je crée un client et un projet (code unique par compte, couleur auto avec contraste AA, dates, statut, tentatif, non-facturable).
  - CA : `project_code` dupliqué rejeté avec message clair ; couleur proposée respecte contraste ≥ 4.5:1 sur fond blanc et sombre ; `end_date < start_date` rejeté.
- **US-2.2** Retirer une personne de l'équipe projet (BR-10).
  - CA : modal récapitulatif « N allocations, M heures loggées seront supprimées » ; rien n'est supprimé sans confirmation ; entrée dans `delete_log` pour chaque suppression ; toast « Annuler » 10 s.

### E3 — Schedule (FR-03) — cœur de valeur
- **US-3.1** Créer une allocation par drag sur une cellule (h/jour ou % capacité).
  - CA : création < 100 ms perçue (optimistic UI) ; refusée sur jour non ouvré (BR-01) mais acceptée au-delà de la capacité ; mode % calcule `percent × work_days_hours[jour]`.
- **US-3.2** Déplacer, étirer, dupliquer, splitter, supprimer une allocation (+ undo/redo).
  - CA : undo de la dernière action en Ctrl+Z, y compris suppression ; split conserve projet/tâche/notes ; copie multi-personnes crée N allocations.
- **US-3.3** Allocation multi-personnes et répétition (quotidienne/hebdo/mensuelle + fin).
  - CA : modifier « cette occurrence » vs « toute la série » est proposé ; `repeat_end_date` obligatoire si répétition.
- **US-3.4** Vues jour/semaine/mois ; défilement fluide.
  - CA : 300 personnes × 12 mois : 1er rendu < 2 s, scroll ≥ 50 fps (poste de référence défini).
- **US-3.5** Temps réel multi-client.
  - CA : mutation visible chez un 2e client en < 1 s (p95) ; conflit d'édition concurrent : dernière écriture gagne + notification, jamais de perte silencieuse.

### E4 — Capacité & alertes (FR-04, BR-01..03)
- **US-4.1** Indicateur par personne/jour (sous / OK / sur-allocation) et barre de capacité.
  - CA : jeu de test chiffré (ex. 8 h ouvrées, 1 férié, 4 h de congé, 5 h allouées → capacité 4, utilisation 125 %, surtemps 1 h) ; état exposé aussi par motif/icône, pas seulement la couleur.
- **US-4.2** Agrégats par équipe/département/semaine.

### E5 — Congés & fériés (FR-05, BR-02/04/05)
- **US-5.1** Demande, approbation, refus de congé ; types configurables ; demi-journées.
  - CA : un congé `pending` est affiché en hachuré ; **règle à trancher** : déduit ou non de la capacité tant que `pending` (le schéma déduit tout sauf `declined`).
- **US-5.2** Congé pleine journée sur jour alloué (BR-04, écart volontaire avec Float).
  - CA : aucune allocation supprimée ; avertissement listant les allocations impactées ; action « reporter / laisser / réduire » ; tant que non résolu, badge de conflit visible.
- **US-5.3** Jours fériés par pays (+ équipe) importés depuis un jeu de calendriers.
  - CA : une personne rattachée à FR ne voit pas les fériés US. Nécessite `people.country` (manquant au schéma, **[BLOQUANT]** côté data).

### E6 — Permissions & sécurité (FR-09)
- **US-6.1** Rôles Owner/Admin/PM/Member/Guest.
  - CA : Member ne voit que ses assignations (API incluse, pas seulement l'UI) ; Guest n'a aucune écriture ; matrice de droits testée endpoint par endpoint ; isolement multi-tenant testé (aucune fuite inter-compte).

### E7 — Recherche, filtres, vues sauvegardées, notifications (FR-10)
- **US-7.1** Filtres combinables (tags, dép., projet, client) + recherche instantanée (< 150 ms).
- **US-7.2** Vues sauvegardées personnelles puis partagées.
- **US-7.3** Notifications e-mail/in-app : nouvelle allocation, changement de dates, congé décidé. CA : digest quotidien configurable, désabonnement par type.

### E8 — Temps réel loggé (FR-07, BR-11/12) — P0.5
- **US-8.1** Timesheet pré-rempli depuis allocations confirmées uniquement ; confirmer en un clic.
  - CA : un projet tentatif ne pré-remplit rien ; heures décimales ; saisie hors allocation permise.
- **US-8.2** Soumission puis verrouillage ; déverrouillage Admin/Owner uniquement, tracé.
  - CA : modification d'un log `locked` par un Member renvoie 403 (contrôle applicatif : le schéma n'impose rien, à tester).

### E9 — Rapports (FR-08, BR-03/06/07/13) — P0.5
- **US-9.1** Rapport People : capacité, planifié, loggé, congés, surtemps, 3 % d'utilisation (BR-13). CA : chiffres réconciliables avec la somme des cellules du Schedule (test de non-régression sur jeu de référence) ; export CSV.
- **US-9.2** Rapport Projet : planifié vs loggé vs budget. CA : tentatif séparé (BR-07).

### E10 — Budgets (FR-06, BR-08/09) — P1
- Les 5 `budget_type` + baseline + marge. Dépend de rate cards (FR-12 classé P1) : **[IMPORTANT] incohérence** — BR-09 (marge) est P0 en règle mais FR-12 est P1.

### P1/P2 (épics seulement)
E11 Phases/milestones/tâches/dépenses (FR-11) · E12 Rate cards & marge (FR-12) · E13 Forecast & hiring plan (FR-13) · E14 Mobile (FR-14) · E15 API v3, webhooks, intégrations (FR-15) · E16 Baseline vs scope (FR-16) · E17 Smart Assign (FR-17) · E18 Talent Intelligence (FR-18) · E19 MCP/langage naturel (FR-19). **[IMPORTANT]** FR-13 « tentativa » (typo) : définir le forecast comme demande tentative pondérée par probabilité (champ manquant au schéma).

## 2. Périmètre MVP minimal réellement livrable

**Promesse testable du MVP :** « placer quelqu'un sur un projet en < 10 s sans surbooker personne, et voir en temps réel la capacité réelle (congés + fériés). »

**Dans le MVP (T1)** : E1 (hors import avancé : CSV simple), E2 (sans budget), E3 complet, E4, E5 (workflow simple, 2 statuts approuvé/refusé), E6 simplifié (Owner/Admin/Member/Guest ; PM par projet reporté), E7.1 + vues sauvegardées perso.

**Différer à T2** : timesheets (E8), rapports People/Projet de base (E9) + export CSV, PM par projet, notifications e-mail (garder in-app), digest.
**Différer à T3** : budgets 5 types, baseline, rate cards, marge, phases/tâches/dépenses, API publique, mobile natif.
**Couper / reporter** :
- Les 5 types de budget : en livrer 1 (heures par projet) d'abord ; le dossier cite lui-même le risque. **[IMPORTANT]**
- Mobile natif : un Schedule web responsive en lecture + log temps suffit avant un app store. **[IMPORTANT]**
- Répétitions mensuelles et multi-personnes avancées : garder daily/weekly. **[CONFORT]**
- Mode sombre, animations « rebond » : après stabilisation. **[CONFORT]**
- SSO, ISO 42001, Zapier/Slack/Jira : hors MVP. **[CONFORT]**
- Billing/sièges self-serve : MVP en design partners gratuits ; Stripe en T2. **[IMPORTANT]**

**Pré-requis bloquants avant sprint 1 :** corriger `COLESCE`, ajouter `people.country`, trancher vues/fonctions paramétrées, ajouter users/auth/permissions. **[BLOQUANT]** Aussi : l'expansion des allocations répétées dans `daily_planned_load` est fausse pour `weekly`/`monthly` (une série ne devrait générer que les occurrences, pas la plage continue) et pour `none` l'intervalle `text::interval` est invalide ; à valider par la matrice de tests (BR) plutôt que par lecture. **[BLOQUANT]** pour la fiabilité de E4.

## 3. KPIs, pricing/sièges, risques, go-to-market

### KPIs (corrections à apporter à §5.4)
- **[IMPORTANT] « WAU Schedule > 80 % des sièges payés » est inatteignable** : les sièges incluent des personnes sans accès (BR-15). Mesurer sur les *utilisateurs avec accès*, et ajouter « % de sièges ayant un compte actif ».
- Définir « adhérence » : `heures loggées / heures planifiées confirmées` par semaine, sur timesheets soumis, et séparer l'adhérence de soumission à l'échéance (processus) de l'adhérence d'heures (qualité du plan).
- Ajouter : **activation** (compte avec ≥ 5 personnes, ≥ 3 projets, ≥ 20 allocations en J7), North Star = « allocations confirmées / semaine / compte », conversion trial → payant, rétention W4/W12, latence p95 de propagation temps réel, taux de conflits résolus, part de plannings « sans surbooking non traité ».
- Indicateurs de santé technique à suivre dès le MVP : p95 drag-to-render, erreurs de sync.
- Le churn « < 10 %/an » est un objectif de maturité ; en phase design-partner, viser des seuils qualitatifs (utilisation hebdo de 5 comptes pilotes).

### Pricing / sièges (BR-15..17)
- **[BLOQUANT avant facturation]** Définition du siège : trancher « toute personne sur le Schedule » (dossier) vs « active et capacité > 0 » (schéma). Cas limites : placeholder temporaire, personne archivée en cours de mois, contractor 1 semaine, congé long. Proposition : siège = personne `active` présente sur le Schedule à un moment du mois ; proratisation ou « pic mensuel » à décider.
- **[IMPORTANT]** Le plan est `TEXT` dans `accounts.plan` : prévoir table `subscriptions` (plan, sièges facturés, essai, dates), journal d'usage de sièges, et feature flags par plan (BR-17).
- **[IMPORTANT]** BR-16 : rétention 6 mois post-trial → à aligner avec RGPD (durée justifiée, purge, droit à l'effacement) et avec le delete log.
- Prix Starter ≈ 7–8 $, Pro ≈ 12–14 $ (valeurs Float à revérifier avant de s'aligner). Option de différenciation : tarif plus bas pour sièges « placeholder » ou moins de 10 sièges. **[CONFORT]**
- Ne pas faire dépendre la rétrogradation de la perte de données : cohérent avec BR-16, à tester (données Pro masquées mais intactes).

### Risques produit
1. **[BLOQUANT] Scope creep de la parité** : viser 100 % de Float avant toute valeur propre. Mitigation : MVP section 2, critères de sortie mesurables.
2. **[IMPORTANT] Performance de la matrice** à 300+ personnes (dossier §6) : prototype de virtualisation avant d'engager l'UI complète.
3. **[IMPORTANT] Fiabilité du calcul de capacité** : un seul chiffre faux détruit la confiance ; investir dans les tests dorés (matrice BR).
4. **[IMPORTANT] Concurrence frontale** avec un leader installé (4 500 équipes) et des alternatives (Resource Guru, Runn, Forecast, Productive, Kantata, Teamwork) : sans angle clair, pas de raison de migrer.
5. **[IMPORTANT] Risque juridique/IP** : copie de l'UI, marque, assets (le dossier le signale pour les captures) ; le nom, la DA (vert fluo) et le wording doivent être originaux ; ne pas utiliser « Float » ni l'API compatible comme argument marketing sans conseil juridique. Compatibilité API v3 : à valider (CGU).
6. **[IMPORTANT] Conformité** : SOC2/GDPR annoncés par Float sont des attentes d'achat B2B ; prévoir DPA, hébergement UE, journal d'audit dès le MVP.
7. **[CONFORT]** Mauvais usage de l'IA (V2) : recommandations biaisées sur la séniorité/coût ; exiger explicabilité et validation humaine.

### Go-to-market
- **[IMPORTANT]** Définir l'ICP unique : agences 20–100 personnes (créa/marketing) utilisant des tableurs, plutôt que 10–500 « tout secteur ». Le tableur est le concurrent n°1.
- Acquisition : design partners (5–10 agences) gratuits en échange de feedback hebdo ; migration assistée depuis Excel/Google Sheets et depuis Float (import CSV) comme levier ; contenu « coût réel du surbooking ».
- Différenciateur de lancement : parité du Schedule + import 1 jour + règle BR-04 (pas de suppression silencieuse) + exports illimités.
- Trial 30 j illimité en personnes : OK mais définir la limite d'abus (coût d'hébergement). **[CONFORT]**

## 4. Différenciation vs Float (parité puis IA)

Séquence : **parité ciblée (vitesse + capacité fiable) → pilotage (marge) → IA**.

1. **Parité (T1-T3)** : on ne rivalise sur rien d'autre tant que Schedule, capacité, congés ne sont pas irréprochables.
2. **Corrections de confiance (dès T1)** : BR-04 (pas de suppression silencieuse), BR-10 (confirmation + undo), historique des modifications visible par allocation (audit déjà au schéma).
3. **IA (T4)** — à conditionner par des données : l'IA de staffing a besoin de compétences structurées. **[IMPORTANT]** Le schéma ne stocke que des `tags TEXT[]` : sans niveau de séniorité, niveau de compétence, historique de réussite, Smart Assign (FR-17) n'a pas de signal. Prévoir : `skills` + `person_skills(level)`, `seniority`, capture implicite des résultats (réel vs prévu, satisfaction).
   - Parcours à valeur démontrable : « proposer 3 candidats pour ce besoin, avec raison, coût et impact sur la marge » ; l'humain valide toujours.
   - FR-19 (MCP/langage naturel) : peu coûteux si l'API est propre ; peut être avancé en T3 comme vitrine. **[CONFORT]**
4. **Talent Intelligence (FR-18)** : définir une première version utile et mesurable (détection de sur-allocation prévisible à 4 semaines, alerte marge) avant « carte du réseau de talents », trop vague.
5. Attention : ISO 42001 est un avantage Float ; ne pas s'y confronter, viser transparence IA (journal des recommandations).

## 5. Points faibles de Float à corriger

| Axe | Faiblesse (dossier §1.3) | Réponse produit | Priorité |
|---|---|---|---|
| Reporting | Avancé limité, export restreint selon plan | Export CSV/Excel sur tous les plans dès T2 ; rapports réconciliables avec le Schedule ; API de reporting | [IMPORTANT] |
| Reporting | Pas de rapport planifié/envoyé | Rapports récurrents par e-mail, vues sauvegardées partageables | [CONFORT] |
| Mobile | Popups non fermables, expérience bancale | Mobile = lecture + 3 actions ; règle « tout popup a un bouton fermer » en critère d'acceptation ; tests d'accessibilité | [IMPORTANT] |
| Intégrations | Natives limitées | API v3-like + webhooks + delete log dès T3 ; calendrier Google/Outlook en priorité (usage quotidien) avant Jira/Asana | [IMPORTANT] |
| Onboarding | Courbe d'apprentissage, interface écrasante pour petits projets | Mode compact, import guidé, projet de démonstration, checklist d'activation | [IMPORTANT] |
| Congés | Congé supprime les allocations | BR-04 modifié (report assisté) | [IMPORTANT] |
| Tarification | Par personne planifiée, coût qui monte avec les placeholders | Placeholders gratuits/limités ou pondérés ? à tester | [CONFORT] |

## 6. Questions ouvertes

1. **[BLOQUANT]** Quel est le MVP validé : le P0 complet (FR-01..10) ou le sous-ensemble de la section 2 ? Qui arbitre et sur quel critère de sortie ?
2. **[BLOQUANT]** Définition exacte du siège (BR-15) et traitement des cas limites ; qui implémente la facturation et quand ?
3. **[BLOQUANT]** Pays des personnes : ajout de `people.country` (ou rattachement à un calendrier de fériés / équipe) ? Fériés d'équipe (`team holidays`) : modélisation ?
4. **[IMPORTANT]** Un congé `pending` déduit-il la capacité ? (BR-02 dit « approuvés ou posés ».)
5. **[IMPORTANT]** BR-04 : quels choix proposés lors d'un conflit congé/allocation (reporter, réduire, réaffecter, ignorer) ? Que fait-on côté `logged_time` déjà saisi ?
6. **[IMPORTANT]** BR-12 : comportement après l'« échéance » sans soumission (verrou automatique ?) ; rappels et escalade ?
7. **[IMPORTANT]** Cible de marché et pays/langues de lancement (i18n, formats d'heures, semaine de 37,5 h) ; hébergement UE obligatoire ?
8. **[IMPORTANT]** Tentatif : `projects.tentative` booléen **et** `project_status = 'tentative'` **et** `allocations.status` : source de vérité unique pour BR-07 ?
9. **[IMPORTANT]** Compatibilité avec l'API v3 de Float comme argument d'adoption (migration, intégrations tierces) : juridiquement possible ?
10. **[CONFORT]** Nom du produit, identité visuelle distincte, stratégie open-source/self-host ?
11. **[CONFORT]** Quelle part du budget d'équipe pour l'IA en T4 avant d'avoir des données d'usage ?
