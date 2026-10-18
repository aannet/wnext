# ADR-006 — Auto-surveillance de la factory et introspection par cycle

Statut : **différé** (2026-10-18, décision CPTO : la factory est gelée, voir `docs/factory/gel-factory.md`). Proposé à l'origine (demande utilisateur). Complète `docs/factory/strategy.md` §4.4, §4.5 et §6.3 ; ne les remplace pas.

## Contexte

La stratégie borne déjà les agents (retries, durée, budget, détection de boucle, kill-switch, watchdog 5 min). Il manque deux choses :

1. une **boucle de supervision** qui transforme ces signaux en réaction graduée (signaler, évaluer, interrompre, relancer) sans attendre un humain ;
2. un **apprentissage** : aujourd'hui, la revue des seuils et des routages n'a lieu qu'à chaque gate de phase (§6.3), donc trop tard et à la main.

## Décisions

### 1. Superviseur : code déterministe, pas un agent LLM

Un processus de l'orchestrateur lit le flux d'événements (§5, source de vérité unique) toutes les 30 s et applique une échelle de réaction par agent/ligne. Il ne modifie ni code ni tests. Le Dépanneur (O) n'est appelé qu'à l'étape « évaluer ».

| Niveau | Déclencheur (défauts, dans `factory/supervision.yaml`) | Action | Événement |
|---|---|---|---|
| 1 Signaler | agent actif > 15 min sans commit ni changement d'état de ligne ; ou > 20 appels d'outils sans commit ; ou 2 `llm.call` consécutifs au contenu quasi identique (hash) | alerte dashboard, aucune interruption | `supervisor.warn` |
| 2 Évaluer | niveau 1 persistant 10 min, ou un signal de boucle §4.4, ou agent muet 5 min | Dépanneur (O) sur le journal de la ligne uniquement : verdict `continue` / `restart` / `escalate` / `stop`, avec cause en une phrase | `supervisor.assess` |
| 3 Interrompre | verdict `restart`/`stop`, ou agent actif > 45 min sans progrès mesurable (nouveau commit, test rouge -> vert, changement d'état), ou durée murale ligne > 3 h (§4.3) | arrêt de l'agent, snapshot du contexte et du worktree | `supervisor.interrupt` |
| 4 Relancer | après interruption, si le budget de relances le permet | relance **avec un changement** (voir ci-dessous), jamais à l'identique | `supervisor.restart` |
| 5 Escalader | 2e interruption de la même ligne, ou relance épuisée | ligne `blocked`, rapport du Dépanneur remonté au prochain gate | `status=blocked` |

« Progrès mesurable » = nouveau commit, nombre de tests verts en hausse, ou changement d'étape de la boucle §4.1. Le temps seul n'est pas un progrès ; les tokens non plus.

Règles de relance : au plus **1 relance par agent et par ligne** (comptée dans les 5 cycles de §4.3, pas en plus) ; la relance change au moins un élément parmi contexte réduit au diff et à la spec, modèle supérieur (une seule montée vers F par ligne, §3), re-spécification par le Spécifieur. Les chemins sensibles ne descendent jamais sous O (§3 règle 2).

Garde-fous du Superviseur lui-même : kill-switch §4.5 prioritaire ; plafond de 3 interruptions par heure à l'échelle de la phase (au-delà : `kill.triggered`, c'est un problème systémique, pas une ligne) ; le Superviseur est supervisé par un watchdog externe trivial (heartbeat `supervisor.tick`, absent 2 min = alerte humaine) ; sa configuration est sous CODEOWNERS (`/factory/`).

### 2. Introspecteur : un agent, une fois par cycle, en lecture seule

Un « cycle » = une ligne mergée ou `blocked` (introspection légère) et une phase (introspection complète, avant le gate). Pas de boucle continue.

- **Modèle** : S pour une ligne, O pour une phase. Contexte : événements du cycle (pas de code ni de prompts, §5.3), rapports du Dépanneur, métriques §6.2, recommandations précédentes et leur sort.
- **Sortie** : `docs/factory/retro/<cycle>.md` au gabarit fixe : (a) 3 constats maximum, chacun chiffré à partir des événements ; (b) **au plus 3 recommandations** pour le cycle suivant, chacune avec le constat qui la justifie, le changement exact (clé de configuration, seuil, règle de routage, consigne de prompt), l'effet attendu mesurable et le critère de retour arrière.
- **Anti sur-ingénierie (contraintes dures)** :
  - uniquement des leviers existants : seuils, routage de modèle, taille de ligne, consignes `CLAUDE.md` code-phase, ordre des étapes. Pas de nouvel agent, de nouvel outil ni de nouveau composant proposé par l'Introspecteur : ce sont des ADR, hors boucle ;
  - un constat n'est retenu que s'il se répète (>= 2 lignes ou >= 2 occurrences) ou coûte plus de 5 % du budget de phase ; sinon il est noté « à observer » ;
  - une recommandation doit nommer la métrique §6.2 qu'elle doit améliorer ; sans métrique, elle est rejetée ;
  - **budget propre** : introspection <= 1 % des tokens de phase (ligne : <= 150 k tokens) ;
  - une règle ajoutée doit en retirer ou en justifier une autre si la liste active dépasse 15 entrées.
- **Application** : les recommandations sur seuils et routage (`factory/supervision.yaml`, `factory/models.yaml`) sont proposées dans une PR de configuration, relue par l'ai-engineer (CODEOWNERS `/factory/`) et appliquées au cycle suivant. Les modifications de garde-fous, de CI ou de tests restent interdites à l'Introspecteur (§4.6). Rien ne s'applique en cours de cycle.
- **Évaluation** : au cycle suivant, le Scribe (H) rapporte pour chaque recommandation appliquée la métrique avant/après. Une recommandation sans effet mesurable au bout de 2 cycles est retirée automatiquement ; c'est ce qui borne la dérive de l'apprentissage.

### 3. Contrats d'événements

Nouveaux `agent` : `superviseur` (model `none`), `introspecteur`. Nouvelles `action` : `supervisor.tick|warn|assess|interrupt|restart`, `retro.start|done`, `config.proposed|applied|reverted`. Schéma d'événement inchangé sinon ; extension de l'enum `agent` en `schema_version` 1.0 (valeurs ajoutées, rien de retiré).

## Conséquences

- Strategy : §2 (2 lignes d'agents), §3 (2 lignes de modèles), §4.8 et §4.9 (nouveaux), §5.1 (enum), §6 (R13, métriques).
- Observabilité (code, hors cette ADR) : enum `agent` dans `schema/event.json` et `src/lib/types.ts`, nœuds dans `FlowGraph.tsx` / `AGENT_KIND` (Superviseur dans les automatismes), alertes `supervisor.*` dans `summary.ts`. À planifier comme ligne de P0.
- P0 : critère de sortie ajouté : le Superviseur interrompt et relance, sur run factice, un agent bouclant volontairement (niveaux 1 à 4 observés dans le dashboard) ; une introspection complète est produite sur le run factice.
- Risque : le Superviseur interrompt un agent qui travaille lentement mais utilement. Atténuation : « progrès » mesuré sur des faits, jamais sur le temps ; seuils recalibrés par l'Introspecteur ; le niveau 2 évalue avant tout arrêt sauf plafond de durée.

## Questions ouvertes (avant P0 gate)

- Seuils initiaux (15/45 min, 20 outils) : valeurs de départ, à recalibrer sur le run factice puis après P1.
- Qui peut approuver une PR de configuration issue d'une rétro : ai-engineer seul, ou aussi CPTO ?
