# ADR-007 — Orchestrateur de la factory : code déterministe + sessions Claude Code headless

Statut : **différé** (2026-10-18, décision CPTO : la factory est gelée, voir `docs/00-factory/gel-factory.md`). Proposé à l'origine. Précise `docs/00-factory/strategy.md` §2 (Orchestrateur, Superviseur), §4.2, §4.3 et §4.5 ; ne les remplace pas. Complète ADR-006.

## Contexte

La stratégie demande un Orchestrateur « code déterministe + un LLM léger pour le routage » (§2, l.79 : la décision critique reste en code). Il manquait de trancher entre deux options pour P0 :

- **A. Claude Code interactif + sous-agents** : une session parent pilote tout.
- **B. Orchestrateur en code** qui lance des sessions Claude Code non interactives (une par rôle et par ligne).

Un spike de faisabilité a été mené le 2026-10-18 (`spikes/orchestrateur/RESULTATS.md`, claude 2.1.302, modèle haiku, coût total < 0,03 USD).

## Décision

**Option B.** L'Orchestrateur et le Superviseur sont du code TypeScript déterministe, sans appel LLM de décision. Les rôles (Architecte, Spécifieur, Testeur, Implémenteur, Réviseur, Dépanneur) sont des sessions `claude -p` avec un prompt système, un jeu d'outils restreint, un modèle et un worktree propres. Le seul LLM de l'orchestration est le routage de ligne (petit modèle).

| Responsabilité | Réalisation |
|---|---|
| File de tâches, retries, budgets, plafonds de cycles et de durée, worktrees, verrous de chemin, file de merge | Code orchestrateur |
| Détection de boucle et de stagnation (§4.8) | Superviseur (code), sur le flux JSONL |
| Kill-switch | Hook PreToolUse (fichier `factory/KILL`) **et** arrêt de processus par l'orchestrateur |
| Émission d'événements | Hook + lecture du flux `stream-json` |
| Interdictions d'écriture par rôle (`tests/`, CI, CODEOWNERS) | Outils restreints + hooks + CODEOWNERS |

## Raisons

1. Les décisions critiques (budgets, boucles, arrêt) ne doivent pas dépendre d'un LLM ; l'enforcement doit rester hors du contexte du modèle (sources 4, 5).
2. Les garanties exigées par la stratégie (plafonds durs, isolation, supervision) sont de la logique d'état, testable par des PR qui doivent échouer.
3. Une session parent unique s'épuise sur une phase de plusieurs dizaines de millions de tokens.
4. Claude Code fournit déjà la boucle d'agent, les outils et les hooks : inutile de les réécrire.

## Constats du spike (réserves à absorber par le design)

- **Session headless : OK.** `claude -p … --model haiku --tools … --system-prompt … --settings … --no-session-persistence --output-format json </dev/null`, dans un worktree. Stdin doit être redirigé. Tâche triviale : 8,5 s, 0,007 USD.
- **Kill-switch par hook : OK sous réserve.** Avec `KILL`, l'outil est refusé et la session s'arrête en ~6 s, mais elle se termine en `subtype:"success"`, code 0, `is_error:false`. Le kill se détecte via `permission_denials[]` ou le journal d'événements, jamais via le statut de sortie. Le hook ne coupe pas un appel modèle en cours : l'arrêt dur (< 30 s, §4.5) exige un SIGTERM de l'orchestrateur sur tout le groupe de processus (non testé).
- **Tokens et coût : OK.** Champs : `total_cost_usd`, `usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`, `modelUsage[modèle].*`, `num_turns`, `duration_ms`, `terminal_reason`, `permission_denials`.
- **Limites natives : insuffisantes.** `--max-turns` n'est pas fiable (des appels d'outils parallèles ont écrit 3 fichiers avec `--max-turns 1`). `--max-budget-usd` n'agit qu'en dollars, après coup (dépassement d'un tour). Pas de limite native en tokens : l'orchestrateur suit le flux `stream-json` et tue le processus ; la durée murale est bornée de son côté.
- **Coût fixe par session** : ~34 k tokens de prompt système en cache, même pour une tâche triviale. À intégrer au budget (P0 : 25 M) et à la matrice de modèles ; éviter de multiplier les micro-sessions.

## Références

1. Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents) : distinction workflows (chemins de code prédéfinis) / agents ; commencer simple ; se méfier des frameworks qui masquent les prompts.
2. Anthropic Engineering, [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) : lead + sous-agents parallèles, checkpointing et reprise. Les résumés secondaires indiquent une efficacité moindre sur les tâches de code interdépendantes et ~15 × plus de tokens (non vérifié dans le texte original). Conséquence : parallélisme limité aux lignes indépendantes (verrous de chemin, §4.2).
3. Cemri et al., [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/html/2503.13657v3) (MAST) : 14 modes d'échec ; les échecs viennent surtout de la conception et du désalignement entre agents. Appui à la séparation Testeur ≠ Implémenteur ≠ Réviseur et à la vérification explicite.
4. Cogent Infotech, [Multi-agent orchestration failure playbook](https://cogentinfo.com/resources/when-ai-agents-collide-multi-agent-orchestration-failure-playbook-for-2026) : plafond de dépense par session appliqué par l'orchestration, pas par le modèle ; points de contrôle à intervalles fixes. Source de praticien.
5. Waxell, [Multi-agent kill switch propagation](https://waxell.ai/blog/multi-agent-kill-switch-propagation) : arrêter l'orchestrateur n'arrête pas les sous-agents lancés ; le kill-switch doit couvrir tout le graphe de processus. Source de praticien.

Les références 4 et 5 ne sont pas académiques. Les extraits ont été lus via la recherche web, pas les articles en entier.

## Conséquences et travail P0

- Écrire l'orchestrateur et le superviseur (modules TS) avec un run factice ; ils portent les critères de sortie de P0 (kill-switch testé, agent bouclant interrompu et relancé).
- Tester le SIGTERM du groupe de processus et sa propagation aux sous-processus.
- Spécifier la détection du kill (`permission_denials` + journal) et le calcul de budget en tokens à partir du flux `stream-json`.
- Hooks consignés dans la config versionnée du repo ; l'Implémenteur ne peut pas les modifier (§2).
- Vérifier à chaque montée de version de Claude Code les options utilisées (`--max-turns` n'apparaît pas dans `--help`).
- Si le coût fixe par session se révèle trop élevé, étudier le SDK Agent pour des sessions plus légères (non évalué ici).

## Questions ouvertes

- Choix du SDK programmatique plutôt que le binaire en ligne de commande (non évalué).
- Seuils de parallélisme par phase, à calibrer avec les métriques de P1.
