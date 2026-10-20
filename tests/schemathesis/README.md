# Schemathesis contre l'API

Critère de sortie P2 « contrat OpenAPI vert ». Hors `make check` (non bloquant en CI). Substitut local plus rapide : `tests/e2e/api-fuzz.test.ts`.

## Installation

Rien à faire à la main : `npm run test:schemathesis` crée `.venv-schemathesis/` au premier lancement (ignoré par le dépôt) et y installe les versions épinglées de `requirements.txt` (Schemathesis 4.32.1). Prérequis : `python3` 3.10+ (si le module `venv` n'a pas `ensurepip`, `pip` est amorcé avec `get-pip.py`, il faut donc un accès réseau) et `curl`.

## Lancement

```bash
npm run test:schemathesis                    # admin puis member, 25 exemples par opération (~1 min)
ST_EXAMPLES=100 ST_SEED=7 npm run test:schemathesis
ST_ROLES=member npm run test:schemathesis
ST_PHASES=fuzzing npm run test:schemathesis  # examples,coverage,fuzzing par défaut
```

Le script démarre une pile dédiée (`scripts/dev-stack.mjs --reset`, API :3200, Postgres embarqué :54349 dans `tests/schemathesis/out/pg`, RLS active, limites de débit des tickets relevées), attend `/api/v1/health`, lance Schemathesis sur `packages/contracts/openapi.json` avec les en-têtes `x-dev-*` (compte 1, utilisateur 1, rôle `admin` puis `member`), puis arrête la pile quoi qu'il arrive. Ports : `ST_API_PORT`, `ST_PG_PORT`. Prévoir ~1 Go de RAM libre. Code de sortie non nul si une passe échoue.

Le contrat doit être à jour : `npm run generate:contract` avant le test si `packages/contracts` a changé.

## Lire le rapport

Tout est dans `tests/schemathesis/out/` (ignoré par le dépôt) :

- `rapport-<rôle>.txt` : sortie texte. Chaque échec donne le code du check (`ST201`...), la réponse reçue, une commande `curl` de reproduction et `st replay <id>`. Les sections « Warnings » (données de test manquantes, absence de `links`) sont informatives.
- `junit-<rôle>.xml` : JUnit, un cas par opération (utilisé par le job CI `schemathesis`).
- `stack.log` : journal de la pile (utile pour un 500).

Sens des codes courants : ST103 statut non documenté, ST201 requête invalide acceptée, ST202 requête valide refusée, ST203 en-tête requis manquant accepté. `.venv-schemathesis/bin/schemathesis explain <code>` détaille chaque code.

## Checks et exclusions

Tous les checks sont actifs (`schemathesis.toml`), sauf des exclusions justifiées, chacune liée à un écart de contrat consigné dans [`docs/review/schemathesis-ecarts.md`](../../docs/review/schemathesis-ecarts.md) :

- global : `positive_data_acceptance` (E-01, le contrat n'exprime pas les validations sémantiques), `missing_required_header` (E-02, 428 attendu et documenté), `unsupported_method` et `allow_header_conformance` (E-03, 404 au lieu de 405) ;
- par opération : aucune (E-04 et E-05 corrigés au contrat le 2026-10-20).

Une exclusion se retire dès que le contrat est corrigé. Ne pas en ajouter sans entrée dans le fichier d'écarts. Le passage en `member` vérifie les 403 documentés (écritures refusées sans 5xx ni corps hors format).
