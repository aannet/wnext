# Spike orchestrateur : résultats (claude 2.1.302, modèle haiku -> claude-haiku-5-5)

Fichiers : `run.sh` (lanceur), `hook.sh` (PreToolUse), `settings.json`, `out1.json`/`out2.json` (sorties brutes), `tmp-repo/` + `tmp-wt/` (repo jetable et worktree `line/p0-1`). Coût total du spike < 0,03 USD.

## 1. Session headless, rôle propre, outils restreints, worktree : GO
Commande (exécutée depuis le worktree, cwd = worktree) :
```
cd tmp-wt && claude -p "<prompt>" --model haiku --tools "Write,Read" --allowedTools "Write,Read" \
  --system-prompt "<rôle>" --settings /abs/settings.json --no-session-persistence \
  --max-budget-usd 0.20 --output-format json </dev/null
```
- Résultat : `hello.txt` créé dans le worktree, `result:"DONE"`, 8,5 s, 0,0072 USD, 2 tours.
- `--tools` restreint le jeu d'outils disponibles ; `--allowedTools` évite les prompts de permission ; `--system-prompt` remplace le prompt système.
- Rediriger stdin (`</dev/null`) sinon avertissement et attente de 3 s.
- `git worktree add ../tmp-wt -b line/p0-1` fonctionne tel quel.
- Réserve : le cwd n'est pas une sandbox (Bash exclu ici ; avec Bash, il faut `--permission-mode`/sandbox en plus).

## 2. Hook PreToolUse + KILL + journal JSONL : GO sous réserve
`settings.json` : `hooks.PreToolUse[{matcher:".*", hooks:[{type:"command", command:"/abs/hook.sh"}]}]`, passé via `--settings`. Le hook lit le JSON stdin (`tool_name`, `tool_input`…), ajoute une ligne à `events.jsonl`, `exit 2` (message sur stderr) si `KILL` existe.
- Sans KILL : fichier créé, événement `{"event":"tool_call","tool":"Write"}`.
- Avec KILL : outil refusé, aucun fichier, événement `tool_denied` ; la session se termine proprement en ~6 s (le modèle constate le refus et s'arrête sans contournement). Latence de refus : immédiate (le hook s'exécute avant l'outil, ~ms). Arrêt de la session : 1 tour modèle après le refus, soit quelques secondes (6 s au total).
- Réserves :
  - La sortie est `is_error:false, subtype:"success", terminal_reason:"completed"` malgré le refus. L'orchestrateur doit détecter le kill via `permission_denials[]` non vide (ou via `events.jsonl`/le fichier KILL lui-même), pas via le code retour (rc=0).
  - Le hook ne bloque que les appels d'outils ; un appel de modèle en cours n'est pas interrompu. Pour l'exigence « < 30 s » : le hook couvre les outils, et l'orchestrateur doit en plus envoyer SIGTERM au process `claude` (non testé ici) pour un arrêt dur.
  - Un modèle peut réessayer ou répondre autrement ; avec KILL, chaque outil est refusé donc aucune écriture n'est possible.

## 3. Tokens et coût : GO
`--output-format json` renvoie un objet unique de fin de session (`stream-json` exige `--verbose` et donne le même objet en dernier événement `type:"result"`). Champs exacts :
- Coût : `total_cost_usd`
- Tokens agrégés : `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` (+ `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`)
- Par modèle : `modelUsage["claude-haiku-5-5"].{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,costUSD}`
- Autres : `num_turns`, `duration_ms`, `duration_api_ms`, `session_id`, `is_error`, `subtype`, `terminal_reason`, `stop_reason`, `permission_denials[]`, `result`.
- Exemple : input 4, output 112, cache_creation 33 885, cache_read 33 653, coût 0,00717 USD.
- Constat : le prompt système par défaut de l'outillage pèse ~34 k tokens en cache même pour une tâche triviale (coût fixe par session ; le cache de 1 h aide). Pour le budget « tokens totaux cache compris » de strategy.md §2, sommer les 4 champs.

## 4. Limites dures depuis l'extérieur : GO sous réserve
- `--max-turns` : accepté par la CLI (absent de `--help`) ; essai avec `--max-turns 1` et 3 écritures : `subtype:"error_max_turns"`, `is_error:true`, `terminal_reason:"max_turns"`, mais les 3 fichiers ont été écrits (appels d'outils parallèles dans un même tour) et `num_turns` = 2. Limite donc approximative.
- `--max-budget-usd` : fonctionne (`subtype:"error_max_budget_usd"`, `terminal_reason:"budget_exhausted"`, `is_error:true`) mais en USD, pas en tokens, et vérifié après coup (essai à 0,0001 USD : dépassé, 0,0019 consommé). Plafond approximatif avec dépassement possible d'un tour.
- Pas de limite en tokens native : l'orchestrateur doit convertir le budget tokens en USD ou surveiller le flux `stream-json --verbose` et tuer le process.
- La durée murale se borne côté orchestrateur (timeout + SIGTERM), non testé ici.

## Verdicts
1. Session headless / rôle / outils / worktree : **GO**
2. Hook KILL + JSONL : **GO sous réserve** (détecter via `permission_denials`, ajouter SIGTERM pour l'arrêt dur)
3. Tokens et coût : **GO**
4. Limites dures : **GO sous réserve** (`--max-turns` et `--max-budget-usd` approximatifs, en USD ; compléter par surveillance et kill côté orchestrateur)
