# Factory : kill-switch

Implémente `docs/factory/strategy.md` §4.5 (kill-switch) et ADR-007 (hook PreToolUse **et** arrêt de processus). Node seul, sans dépendance.

| Fichier | Rôle |
|---|---|
| `KILL` | Drapeau (ignoré par git). Sa seule existence active le kill-switch. |
| `lib/kill.mjs` | `isKilled()`, `launchSession()` (processus détaché, pgid consigné dans `state/sessions.json`), `stopAll()`, `resumeFactory()` |
| `hooks/kill-hook.mjs` | Hook PreToolUse : sans `KILL` exit 0 ; avec `KILL` exit 2 (outil refusé) et événement `kill.triggered` (POST `OBS_URL/api/events`, et JSONL si `OBS_EVENTS_FILE`) |
| `bin/factory.mjs` | CLI : `stop --all`, `resume --i-am-human`, `status` |
| `manual/real-claude-kill.sh` | Test manuel avec un vrai `claude -p` (haiku, < 0,03 USD) |

## Usage

```bash
node factory/bin/factory.mjs stop --all        # crée KILL, SIGTERM aux groupes suivis, SIGKILL après FACTORY_STOP_GRACE_MS (10 s)
node factory/bin/factory.mjs status
node factory/bin/factory.mjs resume --i-am-human   # HUMAIN UNIQUEMENT
```

Brancher le hook (à côté de `obs-hook.mjs`) : `hooks.PreToolUse[{matcher:".*", hooks:[{type:"command", command:"node /abs/factory/hooks/kill-hook.mjs"}]}]`.

## Règles

- Toute session doit être lancée par `launchSession()` (sinon son groupe n'est pas suivi et `stop --all` ne la tue pas). Elle refuse de lancer si `KILL` existe.
- Arrêt : SIGTERM au **groupe** (`process.kill(-pgid)`), donc aux sous-processus ; survivants en SIGKILL après le délai de grâce. Mesuré : ~50 ms (SIGTERM honoré), ~grâce + 70 ms avec un agent qui ignore SIGTERM ; objectif < 30 s. Les worktrees ne sont pas touchés.
- Le hook ne coupe pas un appel modèle en cours : c'est le SIGTERM qui le fait. La session `claude -p` finit en `success` / code 0 malgré le refus : détecter le kill via `permission_denials` ou l'événement, pas le code retour (ADR-007).
- **Les agents n'ont pas à appeler `factory resume` et ne doivent jamais le faire.** La commande exige `--i-am-human` et refuse si `OBS_RUN_ID` ou `FACTORY_SESSION` est défini (l'orchestrateur doit donc poser `OBS_RUN_ID` dans l'environnement des sessions). Ce n'est qu'une garde-fou de commodité, pas une barrière de sécurité : la vraie protection est que seul un humain dispose de la commande (permissions Claude Code à refuser sur `factory resume` et sur l'écriture de `factory/KILL`).

## Tests

Dans `observability/` (`npm test`) : `tests/kill.test.ts` (hook, resume, intégration avec un faux agent qui lance des enfants, escalade SIGKILL), `tests/dry-run.test.ts`. Run factice : `npm run dry-run` (store en mémoire) ou `npm run dry-run -- --url http://localhost:3100` (dashboard déjà lancé).
