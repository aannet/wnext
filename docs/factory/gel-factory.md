# Gel de la factory — 2026-10-18

Décision CPTO : la factory est coupée. Constat de l'analyse du jour : ~7 500 lignes d'outillage (orchestrateur, dashboard d'observabilité, simulateur) pour 0 ligne de produit, 11 rôles d'agents, un budget de 420 M tokens sans mesure.

- **Gelé** : `factory/orchestrator`, `factory/observability`, ADR-006 (auto-surveillance, introspection), ADR-007 (orchestrateur). Aucun nouveau commit dans ces dossiers.
- **Conservé** : `make check`, CI, garde-fous déterministes (taille de PR, tests non affaiblis, matrice BR), lint de frontières, chaîne de contrats, kill-switch.
- **Rôles** : option B de `proposition-simplification-agents.md` (5 rôles LLM : architecte, spécifieur, testeur, implémenteur, réviseur ; le reste en code).
- **Mode de travail** : une session Claude à la fois, tranche verticale étroite, tests écrits avant le code.
- **Critère de dégel** : après P1, si lancer 2-3 sessions en parallèle à la main devient pénible (mesuré, pas supposé).
- Fichiers non suivis laissés tels quels : `factory/orchestrator/src/runner-claude/`, `agent-settings.template.json`, `tests/runner-claude/`.
