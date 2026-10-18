.PHONY: check typecheck lint test

# Étage rapide local = étage rapide CI (docs/factory/strategy.md §4.5).
# S'arrête au premier échec.
check:
	$(MAKE) typecheck
	$(MAKE) lint
	$(MAKE) test
	npm run check:contract
	npm run test:guardrails
	npm run test:boundaries
	npm run test:parity
	npm run test:e2e

typecheck:
	npm run typecheck

lint:
	npm run lint:boundaries

test:
	npm test
