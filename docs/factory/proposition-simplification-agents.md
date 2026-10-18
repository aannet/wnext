# Proposition — Simplifier les rôles de la dark factory

Statut : **proposé** (à instruire en ADR et approuver par le CPTO ; `strategy.md` n'est pas modifié).
Source : `docs/factory/strategy.md` §2, §3, §4, §6 ; contrat `factory/observability/schema/event.json`.

## 1. Constat

`strategy.md` §2 définit **11 rôles**, mais ils ne sont pas de même nature :

| Nature | Rôles | Modèle (§3) |
|---|---|---|
| Raisonnement LLM à fort enjeu | architecte (F), spécifieur (O), testeur (O/S), implémenteur (S/O), réviseur (O) | F, O, S |
| Support LLM ponctuel | dépanneur (O, rare : échec persistant), router (H), scribe (H) | O, H |
| Code déterministe (LLM léger optionnel) | orchestrateur, sentinelle, intégrateur | « code seul » en fallback |

Conséquences : coordination coûteuse avant la première ligne livrée (11 contrats d'entrée/sortie, 11 jeux de permissions, 11 prompts à rôder en P0), et un dashboard qui met au même niveau un architecte Fable et un merge automatique. La valeur de sûreté tient à **trois séparations** (testeur ≠ implémenteur ≠ réviseur, §2 et §4.6), pas au nombre de rôles.

## 2. Options

| | A — Statu quo | B — Cœur LLM réduit | C — Démarrage minimal + ajout piloté par les métriques |
|---|---|---|---|
| Rôles LLM | 11 (dont 3 surtout en code) | **5** : architecte, spécifieur, testeur, implémenteur, réviseur | **4** en P0/P1 : architecte+spécifieur fusionnés, testeur, implémenteur, réviseur |
| Dépanneur | rôle dédié (O) | fusionné : escalade de l'implémenteur vers O/F, puis humain | idem B |
| Router | rôle H | règle statique par taille de spec (déjà le fallback §3) | idem B |
| Scribe | rôle H | **fonction** du dashboard (Haiku appelé par gabarit ; existe déjà dans `scribe/`) | idem B |
| Automatismes en code | 0 déclaré | orchestrateur, sentinelle, intégrateur, router, scribe (5) | idem B |
| Séparation testeur/impl./réviseur | oui | **oui, inchangée** | **oui, inchangée** (architecte+spécifieur n'écrivent ni tests ni code) |
| Garde-fous §4.6 | inchangés | inchangés (déterministes, déjà en code) | inchangés |
| Matrice de modèles (§3) | 11 lignes | 5 lignes + « code » ; règles d'escalade et plafonds F ≤ 8 %, O ≤ 35 %, S ≥ 50 % conservés | idem, F consommé par un seul rôle |
| Budget tokens P0-P5 (~420 M) | base | légèrement ↓ (moins d'appels dépanneur/router/scribe, contexte moins dupliqué) ; à recalibrer après P1 | ↓ plus net en P0/P1 ; remonte si des rôles sont ajoutés |
| Effort de rodage en P0 | 11 agents « à blanc » | 5 agents + 5 scripts | 4 agents + 5 scripts |
| Contrat d'événements | 11 valeurs | inchangé | inchangé |
| Dashboard | 11 nœuds | 5 LLM + 5 automatismes distingués | idem B, rôles ajoutés apparaissent d'eux-mêmes |

**Compatibilité du contrat** (`agent` enum du schéma 1.0) : on **conserve les 11 valeurs**, sans changement de version. Les automatismes émettent avec `model: "none"` (déjà prévu) ; le dépanneur reste une valeur valide, émise par l'implémenteur en escalade avec `action: escalate.model` (ou par un futur rôle). Le dashboard classe « LLM » vs « automatisme » d'après `model` ; aucun événement historique n'est invalidé. Un champ explicite (`role_kind`) serait un ajout optionnel ultérieur (schéma 1.1), pas un prérequis.

## 3. Recommandation : option B, avec la souplesse de C

Adopter **B** : 5 rôles LLM + 5 automatismes. Pas de fusion architecte/spécifieur (C) d'emblée : ces deux rôles ont des modèles et des périmètres d'écriture différents (`docs/adr`, `contracts/` vs `specs/`), et fusionner affaiblirait le contrôle CODEOWNERS pour un gain de coordination modeste. En revanche, **C sert de règle d'évolution** : on part de B et on ajoute un rôle seulement si une métrique le justifie.

Pourquoi B : (1) supprime 6 rôles « sans raisonnement propre » sans toucher aux garde-fous qui portent la sûreté ; (2) le scribe et le router existent déjà comme code/appel Haiku ; (3) le dépanneur n'a de sens qu'après épuisement des retries (§4.3), cas rare au démarrage ; (4) compatible avec le contrat et le dashboard actuels.

**Critères de ré-ajout** (mesurés sur le flux §5, recalibrés après P1) :

| Rôle à (ré)introduire | Déclencheur mesurable |
|---|---|
| Dépanneur dédié | lignes `blocked`/`looping` > 5 % ou > 2 % sur 20 lignes, ou escalade F inefficace (> 30 % des escalades sans merge) |
| Router LLM | écart de coût > 30 % entre estimation (règle) et réel sur ≥ 20 lignes, ou dépassement de ligne > 10 % |
| Scribe LLM autonome | rapport de gate rejeté/corrigé par l'humain sur > 2 gates consécutifs |
| Spécifieur distinct de l'architecte (si C adopté) | taux de retours de spec > 20 % ou ambiguïtés BR non détectées avant impl. |

**Risques** : (R-a) l'escalade de l'implémenteur concentre l'analyse causale chez l'agent qui a échoué → l'analyse reste lecture seule et passe par le réviseur ; (R-b) perte de diversité de regard sans dépanneur → critère de ré-ajout ci-dessus ; (R-c) automatismes en code = surface de bugs déterministes → ils sont couverts par les mêmes tests que le reste (P0 « kill-switch testé »).

## 4. Impact sur `strategy.md` si adoptée

Sections à amender (via ADR) : **§2** (tableau : regrouper « Agents LLM » et « Automatismes », fusionner dépanneur, scribe en fonction, router en règle) ; **§3** (matrice : lignes dépanneur/router/scribe/orchestrateur/sentinelle/intégrateur → « code » ; règle 4 inchangée) ; **§1** (critères P0 : « agents rodés à blanc » → 5 rôles) ; **§4.3-4.4** (le Dépanneur devient l'escalade de l'implémenteur) ; **§5.1** (note : automatismes = `model: none`) ; **§6.2** (ajouter le suivi des critères de ré-ajout).

## 5. Questions ouvertes pour le CPTO

1. Le dépanneur fusionné doit-il pouvoir écrire un rapport (§2 : « écrit uniquement un rapport ») ou seulement émettre un événement ?
2. Les automatismes (sentinelle, intégrateur) gardent-ils une confirmation Haiku optionnelle (§3), ou strictement du code ?
3. Fusionner architecte et spécifieur en P0/P1 (option C) est-il acceptable côté CODEOWNERS ?
4. Seuils de ré-ajout : valeurs initiales à valider, recalibrage à la gate P1.

## Résumé

- 11 rôles dont 6 sans raisonnement propre (3 en code, 3 petits appels ou rares).
- Recommandation : option B = 5 rôles LLM + 5 automatismes en code.
- Séparation testeur ≠ implémenteur ≠ réviseur et garde-fous §4.6 inchangés.
- Contrat d'événements inchangé (11 valeurs conservées, automatismes `model: none`).
- Ré-ajout d'un rôle piloté par des métriques mesurables ; 4 questions ouvertes pour le CPTO.
