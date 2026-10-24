.PHONY: check typecheck lint test

# Étage rapide local = étage rapide CI (docs/00-factory/strategy.md §4.5).
# S'arrête au premier échec. Étapes courtes d'abord, pour échouer vite.
#   test  : un seul run vitest (vitest.check.config.ts) pour web, api, contracts-tools et les suites tests/ boundaries,
#           parity, guardrails, e2e, migrations ; pool de 4 threads au plus (chaque PGlite pèse ~0,6 Go), initdb de PGlite
#           pris une fois. Mémoire : pic ~2,5 Go pour cette étape, les autres sont séquentielles (< 1 Go).
#   concurrency : Postgres embarqué, seul, hors du pool partagé (sensible à la charge).
#   coverage : exécute tous les tests de packages/engine avec les seuils 95 % branches / 98 % lignes (ils ne tournent
#           donc qu'une fois, ici).
check:
	$(MAKE) typecheck
	$(MAKE) lint
	npm run check:contract
	$(MAKE) test
	npm run test:concurrency
	npm run coverage -w @wnext/engine

typecheck:
	npm run typecheck

lint:
	npm run lint:boundaries
	npm run lint:ui-strings
	npm run lint:raw-colors

# Tout sauf packages/engine (couvert par `coverage`) et tests/concurrency.
test:
	npm run test:fast
