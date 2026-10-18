# Observabilité de la dark factory

Sous-projet d'observabilité (contrat d'événements `docs/factory/strategy.md` §5, métriques §6.2) : schéma JSON, store SQLite append-only, dashboard Next.js temps réel, scribe Haiku, simulateur.

## Lancement

```bash
npm install
cp .env.example .env.local        # optionnel ; ANTHROPIC_API_KEY seulement pour le scribe
npm run dev                       # dashboard sur http://localhost:3100
npm run simulate                  # dans un autre terminal : émet des événements factices
npm test                          # vitest
```

## Contenu

| Chemin | Rôle |
|---|---|
| `schema/event.json` | JSON Schema du contrat (`schema_version` 1.0, 12 champs obligatoires + optionnels, `detail` borné sans contenu sensible) |
| `config/budgets.json` | Budgets par phase (P0 25 M … P5 45 M), alerte 80 %, plafond dur 1,3x |
| `src/lib/store.ts` | SQLite (better-sqlite3) : table `events` append-only (triggers), clé d'idempotence `(run_id, ts, action, agent)`, vues `v_cost_by_*`, `v_phase_budget`, `v_line_state`, `v_line_retries` |
| `POST /api/events` | JSON, tableau JSON ou lot JSONL (`application/x-ndjson`). Validation Ajv ; rejets comptés (`events_invalid_total`) ; 400 si rien d'exploitable |
| `GET /api/stream` | SSE ; reprise via `Last-Event-ID` (ou `?lastEventId=N`) |
| `GET /api/summary` | Agrégats, lignes, budgets, alertes, compteurs |
| `GET /api/production?phase=&line=` | Onglet Production : agents en cours (carrés par ligne), matrice phase × agent, arêtes « qui déclenche qui » et appels. Causalité déduite du flux (`src/lib/flow.ts`) : quand l'agent change dans un run, le précédent est l'appelant |
| `scribe/` | Journal de run et rapport de gate via `claude-haiku-5-5` |
| `scripts/simulate.ts` | Scénario de démo (retries, boucle, dépassement jusqu'au plafond, ligne bloquée, doublon, invalides) |

Variables : voir `.env.example` (`OBS_DB_PATH`, `OBS_BUDGETS_PATH`, `OBS_MUTE_AFTER_S`, `OBS_URL`, `ANTHROPIC_API_KEY`).

## Scribe

```bash
npm run scribe -- journal --line P1-001 --dry-run   # sans appel API
npm run scribe -- gate --phase P0 --dry-run
ANTHROPIC_API_KEY=... npm run scribe -- gate --phase P0   # appel réel à claude-haiku-5-5
```

Les rapports sont écrits dans `reports/` (ignoré par git). La base est ouverte en lecture seule. Les chiffres viennent des événements (section « Faits ») ; Haiku ne rédige que la synthèse.

## Onglet Projet

Vue haut niveau, ouverte par défaut (`#projet`) : santé du projet, indicateurs, feuille de route P0..P5 (lignes mergées / démarrées et budget par phase), lignes de la phase en cours (cliquer une ligne déplie sa boucle en 6 étapes), points à surveiller, agents repliés. Tout est dérivé de `/api/summary` et `/api/production` (`src/lib/project.ts`), sans nouvelle donnée.

- **Santé** : `Bloqué` s'il existe une alerte critique (plafond de budget, ligne arrêtée après boucle) ; `À surveiller` s'il existe une autre alerte, une ligne bloquée ou un agent muet ; sinon `En bonne voie`.
- **CI au 1er passage** : part des lignes dont la première `ci.result` est `ok`.
- Le total prévu de lignes par phase n'est pas dans le flux : le ratio compte les lignes déjà démarrées.

## Onglet Production

Deux onglets : **AI Ops** (coûts, budgets, alertes) et **Production** (qui tourne). Un carré = une ligne ; couleur et lettre = modèle (F/O/S/H, gris = code déterministe) ; bordure pleine = actif, pointillée = muet (> `OBS_MUTE_AFTER_S`), ⏸ = bloqué. Un agent est actif s'il tient une ligne non terminée ou a émis dans les `OBS_ACTIVE_WINDOW_S` dernières secondes (défaut 120). La matrice phase × agent sert de filtre ; le graphe et la timeline suivent le filtre phase/ligne. Les agents sont groupés en **Agents LLM** (architecte, spécifieur, testeur, implémenteur, réviseur, dépanneur + router/scribe marqués « léger », Haiku) et **Automatismes** (orchestrateur, sentinelle, intégrateur : code déterministe, cadre pointillé dans le graphe) ; classification dans `src/components/shared.ts` (`AGENT_KIND`). Le **graphe des flux** n'affiche par défaut que les agents ayant des liens dans le filtre courant (case « Afficher tous les agents »). La section **Boucle d'une ligne** (`src/lib/loop.ts`, `LineLoop.tsx`) montre les 6 étapes spec → tests → impl → CI → review → merge de la ligne filtrée (sinon la première ligne en cours) : agent, modèle, état (✓ fait, ● en cours, ✕ échec, ⏸ bloqué, ○ à venir), essais, tokens. Après une mise à jour du schéma (nouvelles vues), redémarrer `npm run dev` : le store est un singleton.

## Agents et sous-agents lancés

Section « Agents et sous-agents lancés » de l'onglet Production : arbre orchestrateur → agents → sous-agents (`src/lib/instances.ts`, `AgentTree.tsx`), filtré par phase/ligne. Il repose sur deux champs optionnels du contrat (additifs, `schema_version` reste 1.0) :

- `instance_id` : identifiant de l'instance (session) qui émet ; `parent_instance_id` : instance qui l'a lancée (absent = racine, p. ex. l'orchestrateur). Les événements sans `instance_id` n'apparaissent pas dans l'arbre.
- Convention : `agent.start` ouvre une instance (`detail.subagent_type` = libellé libre, p. ex. `Explore`), `agent.stop` ou un statut `killed` la ferme. Sans événement depuis `OBS_MUTE_AFTER_S` : muet.
- Un sous-agent émet avec le champ `agent` de son rôle (pas de nouvelle valeur d'enum) ; `instance_id` le distingue. Un parent inconnu ou un cycle fait de l'instance une racine. Tokens et coût sont donnés par instance et pour le sous-arbre.
- La clé d'idempotence devient `(run_id, ts, action, agent, instance_id)` pour que des sous-agents parallèles ne s'écrasent pas. Une base existante est migrée (colonnes ajoutées) mais garde l'ancienne contrainte tant qu'elle n'est pas recréée (supprimer `data/events.db`).
- `npm run simulate` émet la ligne `P1-004` pilotée par un orchestrateur avec sous-agents parallèles.

## Notes

- Tokens d'une phase = entrée + sortie + cache lu + cache écrit (§1 : « cache compris »).
- Agent muet : ligne active sans événement depuis plus de 5 min (`OBS_MUTE_AFTER_S`).
- Le dashboard supporte clair/sombre (bouton ou préférence système) ; la vue tableau double le graphe par modèle.
