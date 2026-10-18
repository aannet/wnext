# factory/orchestrator : orchestrateur et Superviseur (contrats L9.0)

Code TypeScript déterministe (ADR-007) hors des workspaces du monorepo. Ce dossier ne contient pour l'instant que les **contrats** ; les lignes L9.1 à L9.4 les implémentent en parallèle, sans se marcher dessus.

| Ligne | Possède | Implémente |
|---|---|---|
| L9.0 (fait) | `src/types.ts`, `src/runner.ts` (interface + `FakeRunner`), `src/ports.ts`, `src/clock.ts`, `src/config.ts`, `../supervision.yaml`, `tests/` | contrats, `ManualClock`, `FakeRunner`, validation de `supervision.yaml` |
| L9.1 | `src/supervisor/` | `SupervisorDecide` : fonction pure (§4.8, §4.4, §4.5), sans I/O ni horloge |
| L9.2 | `src/core/` | noyau : état des lignes, pipeline §4.1, retries §4.3, budgets, verrous, boucle du tick, émission d'événements |
| L9.3 | `src/runner-claude/` | `AgentRunner` réel : `claude -p` via `launchSession` (`factory/lib/kill.mjs`), flux `stream-json` -> événements §5 |
| L9.4 | `src/roles/` | `Depanneur` (O) et `Introspecteur` (S/O) |

Règle : modifier un fichier L9.0 = changement de contrat, à faire d'abord, séparément et relu (comme `packages/contracts`, ADR-003).

## Points de contrat à connaître

- Événements : on réutilise `FactoryEvent` de `factory/observability/src/lib/types.ts` (import de type seulement).
- Temps : toujours via `Clock` (`systemClock` ou `ManualClock` en test).
- Seuils : `factory/supervision.yaml`, chargé par `loadSupervisionConfig()` (clé inconnue ou nombre négatif refusé).
- `Supervisor.decide` reçoit tout dans `SupervisorInput` (état de ligne, agents, signaux de phase, verdicts du Dépanneur) et rend des `SupervisorAction[]` ; L9.2 les exécute et émet les événements `supervisor.*` (`SUPERVISOR_EVENT_ACTION`).

## Commandes

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

## Convention `detail` des événements (attendue par `src/core/aggregator.ts`)

Le noyau (L9.2) agrège ses entrées depuis ces champs ; le runner réel (L9.3) doit les émettre.

| `action` | Champs de `detail` |
|---|---|
| `git.commit` | `diff_hash`, `diff_simhash` (via `simhash64`), `lines_changed`, `file_hash:<chemin>` |
| `ci.result` | `tests_green`, `error_signature` |
| `llm.call` | `prompt_hash` |
| `tool.exec` | (aucun champ imposé) |

Un `kill.triggered` émis par un agent est traité comme une violation de permission.

## Suivis connus (issus de L9.1, non appliqués)

- `AgentState.assess_requested_at_ms` : rendrait `assess_request` idempotent (sans lui, la demande est ré-émise tant que le signal dure ; le noyau déduplique les `warn` et livre une seule fois chaque verdict).
- `LineState.last_green_gain_at_ms` : horodater la hausse des tests verts, qui est un progrès au sens du §4.8.
- Un signal de boucle de ligne vise l'Implémenteur, ou le premier agent à défaut (à confirmer).
