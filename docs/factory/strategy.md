# Stratégie de la dark factory — clone Float.com

Statut : proposition v1.0 (AI Engineer senior, pour validation CPTO)
Sources : ADR-001, `docs/review/*`, dossier de fondamentaux, `CLAUDE.md`, `schema.sql.txt`.
Principes : (a) l'humain n'intervient qu'aux gates de fin de phase et sur les chemins CODEOWNERS ; (b) **les tests sont le juge**, jamais l'agent qui code ; (c) tout est borné (tokens, retries, durée, taille de PR) ; (d) modèles Claude uniquement.

Modèles : Fable 5.1 (`claude-fable-5-1`, noté **F**), Opus 5.5 (`claude-opus-5-5`, **O**), Sonnet 5.5 (`claude-sonnet-5-5`, **S**), Haiku 5.5 (`claude-haiku-5-5`, **H**).

---

## 1. Phasing P0..P5 (MVP réduit Schedule + capacité)

Périmètre MVP (ADR-001 §1) : personnes/projets, Schedule temps réel, capacité, congés/fériés, permissions simples, vues sauvegardées. Hors périmètre (T2+) : timesheets, rapports, budgets/rate cards, mobile natif, API v3, SSO, billing.

Les budgets sont **indicatifs** (tokens totaux entrée+sortie, cache compris, tous agents confondus). Plafond dur = 1,3 x budget ; atteint à 80 % : alerte ; à 100 % du plafond : arrêt de la phase et gate anticipé. Budget MVP total : ~ 420 M tokens (hypothèse haute, à recalibrer après P1 avec les métriques du §6).

| Phase | Objectif | Budget indicatif | Entrée (testable) | Sortie / gate humain (testable) |
|---|---|---|---|---|
| **P0 Fondations** | Repo, monorepo TS, CI complète, garde-fous, agents rodés à blanc, `CLAUDE.md` code-phase | 25 M | ADR-001 accepté ; questions ouvertes « avant P1 » listées avec propriétaire | `make check` vert sur repo vide ; CI < 3 min étage rapide ; garde-fous (§4.6) prouvés par PR de test qui DOIT échouer (affaiblissement de test, PR > 400 lignes, BR sans test) ; dashboard reçoit des événements d'un run factice ; kill-switch testé ; Superviseur : un agent bouclant volontairement est signalé, évalué, interrompu et relancé (§4.8) ; une introspection de phase est produite sur le run factice (§4.9) |
| **P1 Données et règles** | `schema.sql` v1.1 chargeable, migrations, RLS, triggers (BR-10/12/14), `@app/rules` (capacité, charge, répétitions, BR-01/04/07/15/18) avec parité SQL↔TS | 70 M | P0 signé ; réponses humaines : seuils de capacité, heures tentatives, base du % | Migrations depuis zéro OK ; RLS cross-tenant généré sur 100 % des tables ; jeu de tests SQL de non-régression (écrit/relu humain) vert ; couverture branches `rules/` >= 95 % ; mutation >= seuil (70 % puis 80 %) ; matrice BR : 100 % des BR du MVP ont >= 1 test `@BR-xx` |
| **P2 API et temps réel** | Fastify + Kysely, authN/authZ, CRUD personnes/projets/allocations, `/schedule`, outbox `change_log` + WebSocket, stratégie de conflit (ETag/409) | 90 M | P1 signé ; stratégie de conflit temps réel décidée (ADR) | Contrat OpenAPI vert (Schemathesis) ; authz rôle x action 100 % ; propagation WS p95 < 1 s à 50 clients (k6) ; rattrapage après coupure testé ; zéro fuite Member en WS |
| **P3 Schedule UI** | Canvas + overlay DOM, virtualisation 300 x 12 mois, drag-and-drop **avec alternative clavier/tactile (WCAG 2.5.7)**, undo de session, indicateurs de capacité, avertissement BR-04 | 120 M | P2 signé ; tokens du design system validés (accent AA distinct de `--cap-ok`) | Benchmark headless : 300 x 12 mois, 60 fps de défilement p95 >= 50, interaction < 100 ms ; E2E Playwright parcours créer projet -> allouer -> conflit ; axe-core 0 violation AA ; régression visuelle du canvas approuvée |
| **P4 Congés, fériés, vues, permissions** | Time off, jours fériés (`people.country`), vues sauvegardées, rôles simples, BR-10 avec confirmation récapitulative | 70 M | P3 signé | Parcours E2E complets ; BR-04/10/15 testées bout en bout ; BR-14 : suppression (cascades incluses) retrouvée dans `delete_log` >= 72 h |
| **P5 Durcissement et release MVP** | Perf 500 clients WS, sécurité, résilience, runbooks, staging -> prod canary | 45 M | P4 signé ; zéro bug bloquant ouvert | k6 nightly vert 7 jours consécutifs ; Semgrep/gitleaks/OSV/Trivy 0 critique ; restauration PITR testée ; smoke post-déploiement (allocation + réception WS) ; **gate de release humain** |

Réserve non allouée : ~ 10 % (environ 40 M) pour dépassements, relâchée par le CPTO uniquement.

Règles transverses de phase :
- Une phase ne démarre que si la précédente est **signée humainement** ; les lignes de production (§4) d'une même phase sont parallélisables selon le graphe de dépendances du plan de phase.
- Chaque phase produit un **rapport de gate** généré par le scribe (H) : critères de sortie, résultats bruts des tests, coût réel vs budget, incidents, décisions à prendre.
- Les « questions ouvertes » de l'ADR bloquent leur phase : l'agent Planificateur doit les lister en entrée et refuser de démarrer sans réponse.

---

## 2. Typologies d'agents

Une **ligne** = une unité de production (une tâche ≈ un PR < 400 lignes) suivie de bout en bout. Tous les agents tournent dans un sandbox sans accès réseau sortant hors liste blanche (registre de paquets via proxy, API Anthropic), sans secret de prod.

| Agent | Rôle et responsabilités | Entrées | Sorties | Outils | Permissions |
|---|---|---|---|---|---|
| **Orchestrateur** (ADR-007) | Pilote les phases, ordonnance les lignes, applique budgets, retries, kill-switch ; code déterministe + un LLM léger pour le routage | Plan de phase, budgets, état des lignes | Lancement/arrêt de lignes, événements `status` | API orchestrateur, file de tâches, git (lecture) | Ne modifie aucun code ; peut stopper tout agent ; pas d'écriture hors état d'orchestration |
| **Architecte** | ADR, découpage de phase en lignes, contrats (OpenAPI, schéma), arbitrage des escalades | Dossier, ADR, rapports de revue, état du repo | ADR, plan de phase (graphe de lignes + critères d'acceptation), contrats | Lecture repo, écriture `docs/`, `contracts/` | Écriture `docs/adr`, `contracts/` ; jamais `src/` ; ses ADR sont CODEOWNERS humain |
| **Spécifieur** | Transforme une ligne en spec exécutable : critères d'acceptation, cas limites, tags BR | Ligne du plan, BR, contrats | `specs/<ligne>.md`, squelettes de tests rouges (titres + fixtures) | Lecture repo, écriture `specs/`, `tests/**/pending` | N'écrit pas de code applicatif |
| **Testeur** | Écrit les tests **avant** l'implémentation à partir de la spec (unitaires, propriété fast-check, DB, contrat, E2E) | Spec, contrats | Tests rouges commités | Éditeur, runner de tests, Testcontainers | Écrit dans `tests/` uniquement ; **séparé de l'Implémenteur** (contexte et worktree distincts) ; ne lit pas l'implémentation |
| **Implémenteur** | Code la ligne pour faire passer les tests, dans le worktree isolé | Spec, tests rouges, `CLAUDE.md` | Commits sur la branche de la ligne | Éditeur, shell sandbox, `make check`, git (branche de la ligne) | Écriture `src/`, `db/migrations/` (nouvelle migration seulement) ; **interdit** : modifier `tests/`, CODEOWNERS, CI, config des garde-fous |
| **Réviseur** | Revue adversariale du diff : correction, sécurité (RLS, tenant), conformité BR/spec, dérive d'architecture | Diff, spec, résultats CI | Verdict structuré (approve / changes + findings classés), jamais de patch direct | Lecture repo, lecture CI, `git diff` | Lecture seule ; contexte vierge (n'a pas vu la génération) |
| **Garde-fous (Sentinelle)** | Script déterministe + LLM de confirmation : taille PR, tests non affaiblis, traçabilité BR, boucle, périmètre de fichiers | Diff, base de la ligne | Pass/fail motivé en CI (check requis) | Lecture seule, `git diff`, AST des tests | Check bloquant non contournable par les agents |
| **Intégrateur** | Rebase, résolution de conflits triviaux, merge si tous les checks sont verts et CODEOWNERS satisfaits, nettoyage du worktree | Branche, statut CI/revue | Merge trunk ou renvoi motivé | git, API de forge | Merge uniquement via file de merge ; pas de force-push ; ne merge pas si chemin CODEOWNERS sans approbation humaine |
| **Dépanneur** | Diagnostic d'un échec persistant (CI rouge après N retries, flaky, boucle) ; propose un plan, ne contourne pas | Logs, historique d'événements, diff | Rapport de cause + recommandation (retry stratégie différente / escalade / arrêt) | Lecture repo/logs, exécution sandbox | Lecture ; écrit uniquement un rapport |
| **Scribe** | Condense les événements en journal lisible, rapports de gate, changelog, alimente le dashboard | Flux d'événements (§5), résultats de tests | `docs/factory/runs/`, rapports de gate, résumés | Lecture événements, écriture `docs/factory/runs/` | Aucun accès à `src/` ni `tests/` |
| **Superviseur** (ADR-006) | Surveille le flux d'événements, signale un agent qui boucle ou stagne, déclenche l'évaluation puis l'interruption et la relance (§4.8) ; code déterministe | Flux d'événements, `factory/supervision.yaml` | Événements `supervisor.*`, arrêt/relance d'un agent | Lecture événements, API orchestrateur | Ne modifie ni code ni tests ; peut arrêter/relancer un agent ; pas d'appel LLM propre (le Dépanneur évalue) |
| **Introspecteur** (ADR-006) | Analyse un cycle (ligne ou phase) et propose au plus 3 optimisations du cycle suivant, sans sur-ingénierie (§4.9) | Événements du cycle, rapports du Dépanneur, métriques §6.2, rétros précédentes | `docs/factory/retro/<cycle>.md`, PR de configuration | Lecture événements, écriture `docs/factory/retro/` et `factory/*.yaml` (PR) | Ni `src/`, ni `tests/`, ni garde-fous, ni CI ; rien ne s'applique en cours de cycle |
| **Triage de coûts / Router** | Classe la difficulté d'une ligne (S/M/L) pour choisir le modèle de départ | Spec | Étiquette de complexité | Aucun | Aucune écriture |

Séparation des pouvoirs : **Testeur != Implémenteur != Réviseur** (trois contextes, trois worktrees ou lectures seules). Aucun agent ne peut écrire à la fois le code et le test qui le juge.

---

## 3. Matrice rôle -> modèle

Hypothèse de coût relatif (à confirmer sur la grille tarifaire en vigueur) : H << S < O < F ; l'ordre de qualité est l'inverse. Principe : **F rare (décisions irréversibles), O pour le raisonnement à fort enjeu, S pour le volume, H pour le mécanique**.

| Rôle | Modèle par défaut | Justification coût/qualité | Escalade | Fallback (indispo / quota) |
|---|---|---|---|---|
| Architecte (ADR, plan de phase, contrats) | **F** | Décisions structurantes, peu de volume (< 5 % des tokens) ; une erreur coûte des phases entières | — (plafond) ; si échec : gate humain | O |
| Spécifieur | **O** | Cas limites des BR (capacité, répétitions, fuseaux) exigent un raisonnement fin ; volume modéré | F si BR ambiguë non résolue après 1 passe | S + relecture O |
| Testeur : règles critiques (capacité, RLS, authz, verrouillage) | **O** | Un test faible = faux sentiment de sécurité ; qualité prioritaire (+ relecture humaine, §4.5) | F si mutation < seuil après 2 itérations | S |
| Testeur : routine (contrat, E2E, UI) | **S** | Bon rapport qualité/prix, volume élevé | O après 2 échecs | H interdit |
| Implémenteur : ligne simple (CRUD, UI, glue) | **S** | Majorité du volume ; les tests jugent, la qualité marginale de O ne justifie pas 3-5x le coût | O au 3e échec ou si complexité L | S nouvelle tentative avec contexte réduit |
| Implémenteur : ligne complexe (moteur de règles, SQL de capacité, sync temps réel, canvas) | **O** | Algorithmique dense, invariants subtils | F au 3e échec (une fois) puis Dépanneur + humain | S avec Dépanneur O |
| Réviseur | **O** (S pour diff < 50 lignes sans chemin sensible) | Doit détecter ce que le générateur n'a pas vu ; modèle >= à celui de l'implémenteur | F sur chemins sensibles (`auth/`, `rls`, `rules/`, migrations) | O -> S + second passage |
| Sentinelle | **H** (confirmation) + code déterministe | Les contrôles durs sont déterministes ; H ne fait que formuler/classer | S si verdict ambigu | Code seul (fail-closed) |
| Intégrateur | **S** | Conflits de merge : mécanique mais à surveiller | O si conflit sémantique | S réessai puis humain |
| Dépanneur | **O** | Analyse causale multi-logs | F si cause non trouvée | S |
| Scribe | **H** | Résumé/formatage à fort volume, faible risque ; sortie vérifiable contre les événements | S si rapport de gate | Génération par gabarit sans LLM |
| Router | **H** | Classification simple et bon marché | — | Règle statique par taille de spec |
| Superviseur | code seul | Décision déterministe sur le flux ; l'évaluation causale est faite par le Dépanneur (O) | — | — |
| Introspecteur | **S** (ligne) / **O** (phase) | Synthèse chiffrée et bornée ; budget <= 1 % des tokens de phase | O sur phase | Gabarit de métriques sans recommandation |
| Orchestrateur (routage LLM) | **H** (logique en code) | La décision critique reste déterministe | — | Code seul |

Règles d'escalade et de fallback :
1. **Escalade par échec, pas par défaut** : on monte d'un cran après N échecs de gates déterministes (tests/CI) ; une escalade consomme un retry. Max **une** montée vers F par ligne.
2. **Pas de descente silencieuse sur chemins sensibles** : fallback sur indisponibilité = retry/backoff exponentiel (3 tentatives) avant de changer de modèle ; sur `auth/`, `rls`, `rules/`, migrations, le fallback ne descend jamais sous O ; sinon la ligne est mise en attente.
3. **Qualité vérifiée par les gates, pas par la confiance** : tout résultat produit par un fallback inférieur passe par la revue au niveau du modèle nominal.
4. **Budget par modèle** : F <= 8 % des tokens de phase, O <= 35 %, S >= 50 %, H le reste ; dépassement = alerte au CPTO (indicateur de mauvais routage).
5. **Cache de prompt** systématique sur `CLAUDE.md`, spec, contrats et schéma (préfixes stables) ; l'agent ne relit que le diff.
6. Les ID de modèle sont en configuration (`factory/models.yaml`), jamais en dur dans les prompts, pour permettre un changement sans modifier les agents.

---

## 4. Boucle de production par ligne

### 4.1 Flux

```
spec (Spécifieur O) -> tests rouges (Testeur) -> impl (Implémenteur) -> make check local
   -> CI + Sentinelle -> review (Réviseur) -> merge (Intégrateur) [-> gate de phase humain]
```

1. **Spec** : critères d'acceptation, BR touchées (`@BR-xx`), fichiers autorisés (liste blanche), budget tokens de la ligne. Sortie validée par schéma ; sinon retour.
2. **Tests** : commités rouges ; la CI vérifie qu'ils **échouent pour la bonne raison** (échec d'assertion, pas d'erreur d'import) avant d'autoriser l'implémentation.
3. **Impl** : l'Implémenteur itère jusqu'à `make check` vert (lint + types + tests rapides). Commits petits.
4. **CI + Sentinelle** : étages rapide (< 3 min), DB (< 5 min), contrat/intégration (< 8 min), E2E sélectif, garde-fous.
5. **Review** : verdict structuré ; `changes` renvoie à l'impl avec findings (compte comme un retry).
6. **Merge** : file de merge sérialisée, rebase sur trunk, CI rejouée ; feature flags ; trunk-based.

### 4.2 Worktrees isolés
- Un worktree git par ligne et par agent écrivant (`/work/<run_id>/<line>/<agent>`), branche `line/<phase>-<id>` ; créé et détruit par l'orchestrateur.
- Base de données éphémère par worktree (Testcontainers, port aléatoire) ; aucun état partagé ; horloge injectée, pas de `Date.now()`.
- Lectures d'autres lignes en lecture seule ; deux lignes touchant le même fichier = sérialisées par l'Orchestrateur (verrou de chemin).
- Ressources plafonnées (CPU, mémoire, durée de commande 10 min, disque).

### 4.3 Retries bornés
- Par ligne : **max 5 cycles impl->CI**, dont max 2 par modèle ; **max 2 retours de review** ; durée murale max 3 h ; budget tokens par ligne = 3 x estimation du Router (plafond dur).
- Après épuisement : état `blocked`, Dépanneur produit un rapport, la ligne remonte au prochain gate (ou à l'Architecte si la spec est en cause). Pas de retry infini ; pas de contournement des garde-fous.
- Backoff exponentiel sur erreurs API (429/5xx), non comptés comme retries de ligne mais comptés au budget de temps.

### 4.4 Détection de boucle
Déclenche `status=looping` et arrêt de l'agent si l'un des signaux suivants :
- même hash de diff (ou diff avec similarité > 90 %) produit 2 fois de suite ;
- même signature d'erreur CI (test + message normalisé) 3 fois ;
- oscillation A -> B -> A sur un fichier ;
- > 40 appels d'outils sans nouveau commit, ou ratio tokens/ligne modifiée anormal (> 5 x médiane de la phase) ;
- consommation > 50 % du budget de la ligne sans progression du nombre de tests verts.
Action : arrêt, snapshot du contexte, Dépanneur, changement de stratégie (modèle supérieur ou re-spécification) une seule fois.

### 4.5 Kill-switch
- **Global** : fichier/flag `factory/KILL` + commande `factory stop --all` ; vérifié par l'orchestrateur avant chaque appel de modèle et d'outil ; arrêt en < 30 s, worktrees conservés pour analyse.
- **Par phase / par ligne / par agent** : mêmes mécanismes, ciblés.
- **Automatique** : plafond de tokens de phase atteint ; coût/heure > seuil ; > 3 lignes `looping` en 1 h ; taux d'échec CI > 60 % sur 20 lignes ; tentative de violation de permission (écriture hors liste blanche, accès réseau refusé, modification de CODEOWNERS/CI) -> arrêt immédiat de la phase et alerte humaine.
- Seul un humain peut lever le kill-switch.

### 4.6 Tests comme juge et anti-affaiblissement
1. **Spécification exécutable d'abord** : OpenAPI, migrations SQL et matrice BR sont le contrat ; chaque BR a >= 1 test `@BR-xx` ; un script CI échoue si une BR du périmètre n'a aucun test.
2. **Aucun agent ne valide son propre travail** (séparation Testeur/Implémenteur/Réviseur, §2).
3. **Sentinelle anti-affaiblissement** (check requis) : sur tout diff touchant `tests/`, échec si : assertion supprimée ou assouplie (analyse AST : `expect` en moins, `toBe` -> `toBeTruthy`, tolérances élargies), `skip/only/todo/xfail` ajouté, snapshot régénéré sans justification, seuil de couverture/mutation abaissé, fixture simplifiée. Dérogation = label **`test-change-approved`**, posable par un humain seulement.
4. **Interdit à l'Implémenteur** : modifier `tests/`, `.github/`, configuration de couverture/mutation/lint, `CODEOWNERS`, `factory/` (permissions de fichier + contrôle de la Sentinelle sur le périmètre de la spec). Un test faux se corrige par un **ticket de re-spécification** (Testeur), jamais par l'Implémenteur.
5. **Mutation testing** (Stryker) sur `@app/rules` : nightly + PR touchant `rules/` ; seuil 70 % (P1) puis 80 % ; détecte les tests « verts mais vides ».
6. **Tests critiques écrits ou relus par un humain** : capacité, répétitions, RLS cross-tenant, authz, verrouillage timesheet/BR-12, `delete_log`. Les agents peuvent proposer, pas valider.
7. **Parité SQL <-> TS** et **tests de propriété** (fast-check) pour limiter le sur-ajustement aux exemples.
8. **Jeu d'évaluation caché** (« holdout ») : un sous-ensemble de scénarios de règles non visible des Implémenteurs, exécuté en CI ; échec = signal de sur-ajustement.
9. Garde-fous complémentaires : PR < 400 lignes ; migrations mergées immuables ; couverture branches `rules/` >= 95 % ; ADR requis pour tout changement d'architecture ; requêtes SQL via la couche typée avec contexte tenant ; pas de `SET` de session ; données de test sans PII.
10. Contrat d'API (ADR-003) : contract-first. Toute ligne qui touche l'API modifie d'abord `packages/contracts` (commit séparé, relu) ; les agents front et back travaillent depuis le contrat figé, jamais depuis le code de l'autre ; `apps/web` n'importe pas `apps/api` (lint de frontières en CI) ; spec OpenAPI et client générés, jamais édités à la main ; aucune chaîne d'interface dans les réponses d'API (codes d'erreur stables, ADR-002 §4).

### 4.7 CODEOWNERS (revue humaine obligatoire)
```
# CODEOWNERS de WNEXT (strategy.md §4.7, ADR-003 §7).
#
# Revue humaine obligatoire sur ces chemins. Les agents de la factory
# (Architecte, Implémenteur, Intégrateur, Testeur, etc.) n'ont PAS le rôle
# d'approbation sur ces chemins : une PR qui les touche ne peut pas être
# mergée sans approbation d'un humain listé ci-dessous. L'Intégrateur ne merge
# pas sans cette approbation.
#
# Les comptes @po-metier, @ai-engineer, @dba-humain et @securite sont des
# PLACEHOLDERS : à remplacer par de vrais comptes ou équipes GitHub avant
# d'activer la protection de branche.
#
# Écarts avec strategy §4.7 (chemins transposés à l'arborescence réelle) :
#   /contracts/          : absent ; le paquet réel est /packages/contracts/ (ADR-003 §2).
#   /packages/rules/     : absent ; pas de paquet "rules" dans ADR-003 §2. Non déclaré, à décider.
#   /packages/auth/      : absent du repo et de ADR-003 §2 (aucun paquet auth prévu). Non déclaré, à décider.
#   /docs/adr/           : remplacé par /docs/decisions/ (chemin réel des ADR).
#   /CODEOWNERS          : remplacé par /.github/CODEOWNERS (emplacement réel du fichier).
#   /.github/  /factory/ : scindé en deux lignes (un motif par ligne dans CODEOWNERS).
#
# Note : /.github/CODEOWNERS est repris explicitement ; sa règle est la dernière
# qui correspond, elle ne demande donc que @cpto (comme la stratégie).

# Données et sécurité
/db/migrations/        @cpto @dba-humain
/db/rls/               @cpto @securite

# Moteur de capacité (critique) et contrat d'API
/packages/contracts/   @cpto
/packages/engine/      @cpto

# Décisions d'architecture
/docs/decisions/       @cpto

# Tests critiques
/tests/critical/       @cpto @po-metier

# Factory (pipeline d'agents, garde-fous, CI)
/.github/              @cpto @ai-engineer
/factory/              @cpto @ai-engineer
/.github/CODEOWNERS    @cpto
```
Les agents n'ont pas le rôle d'approbation sur ces chemins ; l'Intégrateur ne merge pas sans l'approbation humaine, qui peut être **groupée** par lot pour limiter les interruptions (une revue par ligne sensible, jamais par commit). Le comptage du temps humain est une métrique (§6).

### 4.8 Auto-surveillance (ADR-006)
Le Superviseur (code, tick 30 s) lit le flux §5 et applique une échelle graduée par agent/ligne ; seuils par défaut dans `factory/supervision.yaml`.
1. **Signaler** : agent actif > 15 min sans commit ni changement d'état, ou > 20 appels d'outils sans commit, ou deux appels de modèle quasi identiques d'affilée -> alerte (`supervisor.warn`), pas d'interruption.
2. **Évaluer** : signal persistant 10 min, signal de boucle §4.4 ou agent muet -> le Dépanneur (O) lit le journal de la ligne et rend `continue` / `restart` / `escalate` / `stop` avec la cause (`supervisor.assess`).
3. **Interrompre** : verdict d'arrêt, ou > 45 min sans progrès mesurable, ou 3 h de durée murale -> arrêt de l'agent, snapshot du contexte et du worktree (`supervisor.interrupt`). Progrès = nouveau commit, tests verts en hausse, changement d'étape ; jamais le temps ni les tokens.
4. **Relancer** : une seule fois par agent et ligne (dans les 5 cycles de §4.3), **avec un changement** (contexte réduit au diff + spec, modèle supérieur une fois, ou re-spécification). Jamais à l'identique.
5. **Escalader** : seconde interruption -> ligne `blocked`, rapport au prochain gate.
Plus de 3 interruptions en 1 h sur la phase = problème systémique : kill-switch §4.5. Le Superviseur émet un `supervisor.tick` ; son absence 2 min alerte l'humain.

### 4.9 Introspection par cycle (ADR-006)
Un cycle = une ligne terminée (légère, S) ou une phase (complète, O, avant le gate). L'Introspecteur lit les événements du cycle et écrit `docs/factory/retro/<cycle>.md` : <= 3 constats chiffrés, <= 3 recommandations, chacune avec le constat source, le changement exact (seuil, routage, taille de ligne, consigne `CLAUDE.md`), la métrique §6.2 visée et le critère de retour arrière.
Anti sur-ingénierie : leviers existants uniquement (pas de nouvel agent/outil, ce sont des ADR) ; constat retenu s'il se répète (>= 2) ou coûte > 5 % du budget de phase ; budget <= 1 % des tokens de phase ; liste de règles actives plafonnée à 15.
Application : PR de configuration relue (CODEOWNERS `/factory/`), effective au cycle suivant seulement. Le Scribe mesure avant/après ; une recommandation sans effet au bout de 2 cycles est retirée.

---

## 5. Contrat d'événements d'observabilité

Tout agent émet un événement **JSON Lines** (une ligne = un événement) vers l'orchestrateur (`POST /events` ou fichier `events/<run_id>.jsonl`) à chaque action significative : début/fin de session, appel de modèle, appel d'outil notable, commit, résultat de CI, verdict de review, retry, escalade, arrêt. Émission **non bloquante** mais obligatoire : un agent sans événement pendant 5 min est considéré mort (watchdog).

### 5.1 Schéma

| Champ | Type | Description |
|---|---|---|
| `ts` | string ISO-8601 UTC (ms) | Horodatage de fin de l'action |
| `run_id` | string (ULID) | Identifiant du run de ligne ; stable sur tous les retries |
| `line` | string | Ligne de production (`P1-017`) ; `_phase` ou `_global` pour les événements hors ligne |
| `phase` | enum `P0`..`P5` | Phase courante |
| `agent` | enum | `orchestrateur`, `architecte`, `specifieur`, `testeur`, `implementeur`, `reviseur`, `sentinelle`, `integrateur`, `depanneur`, `scribe`, `router`, `superviseur`, `introspecteur` |
| `model` | string | ID exact (`claude-opus-5-5`, ...) ou `none` pour code déterministe |
| `action` | string (taxonomie `verbe.objet`) | Ex. `llm.call`, `tool.exec`, `git.commit`, `ci.result`, `review.verdict`, `retry.start`, `escalate.model`, `loop.detected`, `kill.triggered`, `merge.done` |
| `tokens_in` | int | Tokens d'entrée (hors cache) |
| `tokens_out` | int | Tokens de sortie |
| `cost` | number (USD, 6 décimales) | Coût calculé via grille de prix versionnée (`cache_read`/`cache_write` inclus) |
| `duration_ms` | int | Durée de l'action |
| `status` | enum | `ok`, `error`, `retry`, `blocked`, `looping`, `killed`, `escalated`, `skipped` |

Champs optionnels (hors contrat minimal, recommandés) : `attempt` (int), `parent_id` (corrélation), `tokens_cache_read`, `tokens_cache_write`, `detail` (objet court : test échoué, signature d'erreur, hash de diff, verdict), `budget_remaining` (tokens de ligne/phase).

### 5.2 Exemple
```json
{"ts":"2026-10-18T09:14:03.221Z","run_id":"01JAB...","line":"P1-017","phase":"P1","agent":"implementeur","model":"claude-sonnet-5-5","action":"llm.call","tokens_in":18420,"tokens_out":2310,"cost":0.0,"duration_ms":14250,"status":"ok","attempt":2}
```
(le coût réel est calculé, non plus à 0.0 ; valeur factice dans l'exemple)

### 5.3 Règles
- Schéma versionné (`schema_version`) et validé à l'ingestion ; événement invalide rejeté et compté (`events_invalid_total`).
- **Idempotence** : clé `(run_id, ts, action, agent)` ; at-least-once toléré.
- **Pas de contenu sensible** dans les événements (pas de code ni de prompts, ni PII) ; le détail brut va dans un stockage d'artefacts référencé par `parent_id`.
- Les événements sont **append-only** et conservés pour toute la durée du projet ; le scribe (H) lit, ne modifie jamais.
- **Consommateurs** : (1) Scribe : journal de run, rapports de gate, changelog ; (2) Dashboard : coût cumulé phase/ligne/modèle vs budget, lignes actives/bloquées, retries, boucles, taux de CI vert, latence par étape ; (3) Orchestrateur : décisions de plafond, boucle, kill-switch calculées sur ce même flux (une seule source de vérité).
- Réconciliation quotidienne : somme des `tokens`/`cost` des événements vs facturation API ; écart > 3 % = alerte (événements manquants).

---

## 6. Risques et métriques

### 6.1 Risques (probabilité x impact)

| # | Risque | P | I | Mitigation |
|---|---|---|---|---|
| R1 | Tests affaiblis ou « verts mais vides », fausse confiance | Haute | Critique | Sentinelle AST, mutation, holdout, séparation des rôles, tests critiques humains (§4.6) |
| R2 | Dérive de coûts / boucles d'agents | Haute | Élevé | Budgets bornés, détection de boucle, kill-switch automatique, alertes à 80 % |
| R3 | Défauts de sécurité multi-tenant (RLS, authz) non détectés | Moyenne | Critique | RLS généré sur toutes les tables, revue F + humain, CODEOWNERS, tests cross-tenant |
| R4 | Dérive d'architecture et incohérences entre lignes parallèles | Moyenne | Élevé | Contrats d'abord, ADR requis, verrous de chemin, Architecte en revue de plan |
| R5 | Goulot de revue humaine (gates, CODEOWNERS) | Moyenne | Moyen | Approbation par lots, rapports de gate synthétiques, périmètre sensible réduit |
| R6 | Spécification ambiguë (questions ouvertes ADR : capacité, tentatives, conflits RT) | Haute | Élevé | Entrée de phase conditionnée à la réponse ; Spécifieur remonte les ambiguïtés, ne les devine pas |
| R7 | Dépendance à un fournisseur unique / indisponibilité ou changement de modèle | Faible | Élevé | Config des modèles, fallback documenté, retry/backoff, suite d'évaluation pour valider un nouveau modèle avant bascule |
| R8 | Injection de prompt via contenu externe (dépendances, issues, données) | Moyenne | Élevé | Sandbox sans réseau, liste blanche, pas de secrets, contenu externe traité comme donnée, revue des dépendances (Renovate, OSV) |
| R9 | Dette technique cachée par volume de code généré | Moyenne | Moyen | Taille de PR, revue, métriques de complexité, passes de refactoring budgétées par phase |
| R10 | Flakiness des tests (E2E, temps réel) masquant les vrais échecs | Moyenne | Moyen | Quarantaine tracée, rejeu unique avec signature, horloge injectée, DB éphémère |
| R11 | Perte de traçabilité (événements manquants) | Faible | Moyen | Watchdog, réconciliation facturation, append-only |
| R12 | Performance Schedule non atteinte tardivement | Moyenne | Élevé | Prototype + benchmark en P3 avant le reste de l'UI ; budget perf en CI nightly dès P3 |
| R13 | Superviseur trop agressif (interrompt un travail utile) ou apprentissage qui dérive (règles qui s'accumulent) | Moyenne | Moyen | Progrès mesuré sur des faits, évaluation avant arrêt, 1 relance max, retour arrière des recommandations sans effet, plafond de règles (§4.8, §4.9) |

### 6.2 Métriques (collectées via le flux §5, seuils initiaux à recalibrer après P1)

| Famille | Métrique | Cible |
|---|---|---|
| Coût | Tokens et USD par phase / ligne / modèle vs budget | <= budget ; dépassement ligne < 10 % des lignes |
| Coût | Coût par ligne mergée (médiane, p90) | suivi, p90 <= 3 x médiane |
| Coût | Part de tokens par modèle (F/O/S/H) | F <= 8 %, O <= 35 %, S >= 50 % |
| Débit | Lignes mergées / jour ; lead time spec -> merge (p50, p90) | p50 < 2 h |
| Qualité | Taux de réussite CI au premier passage | >= 60 % puis 75 % |
| Qualité | Retries moyens par ligne ; taux d'escalade de modèle | <= 1,5 ; < 15 % |
| Qualité | Score de mutation `@app/rules` ; couverture branches `rules/` | >= 70 -> 80 % ; >= 95 % |
| Qualité | Couverture BR (BR du périmètre avec test) | 100 % |
| Fiabilité | Taux de lignes `blocked` / `looping` | < 5 % / < 2 % |
| Garde-fous | Tentatives d'affaiblissement de test bloquées ; violations de permission | suivi ; violations = 0 toléré (arrêt phase) |
| Escapes | Défauts trouvés après merge (par CI nightly, gate ou humain) par 100 lignes ; régression après gate | < 3 ; 0 sur BR critiques |
| Humain | Temps humain par gate et par ligne sensible ; délai d'attente de gate | < 4 h par gate ; suivi |
| Produit | Perf Schedule (fps, interaction, p95 sync WS), accessibilité AA | cibles P3/P2 ci-dessus |
| Observabilité | Événements invalides ; écart facturation | < 0,5 % ; < 3 % |
| Auto-surveillance | Temps médian entre début de stagnation et interruption ; part des interruptions jugées utiles (la relance aboutit) ; faux positifs (verdict `continue` après alerte) | < 20 min ; >= 70 % ; < 30 % |
| Apprentissage | Recommandations appliquées dont la métrique visée s'améliore ; coût de l'introspection | >= 60 % ; <= 1 % des tokens de phase |

### 6.3 Revue de la stratégie
Revue à chaque gate (P0 -> P5) : recalibrage des budgets, des seuils de retries et de la matrice de modèles à partir des métriques réelles. Toute modification de ce document passe par ADR et approbation CPTO.
