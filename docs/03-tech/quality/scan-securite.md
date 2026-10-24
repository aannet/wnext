# Scan de sécurité (amorce P5)

Commande : `npm run scan` (hors `make check`, job CI `security` non bloquant). Options : `--strict` (échec aussi sur un constat haut), `--only=secrets,deps,code`.
Rapports bruts dans `tests/security/out/` (ignoré par git) : `gitleaks.json`, `osv.json`, `semgrep.json`, `resume.json`.

## Outils (épinglés)

| Volet | Outil | Version | Épinglage |
|---|---|---|---|
| Secrets (historique git complet) | gitleaks | 8.30.1 | binaire dans `.tools/`, SHA-256 vérifié (`scripts/scan/tools.mjs`) |
| Dépendances (`package-lock.json`) | OSV-Scanner | 2.7.0 | idem |
| Code | Semgrep (venv `.venv-scan`) | 1.181.0 | `scripts/scan/requirements-semgrep.txt` ; règles du registre `p/typescript`, `p/nodejs`, `p/security-audit` (non épinglées : elles évoluent côté Semgrep) |

Docker n'est pas utilisé. Le venv s'amorce comme `tests/schemathesis/run.mjs` (pip via get-pip.py si `ensurepip` manque).

## Sévérités et code de sortie

Secrets : tout constat non justifié est critique. Dépendances : CVSS >= 9 critique, >= 7 haut. Code : Semgrep ERROR = haut, WARNING = moyen, impact CRITICAL = critique.
Sortie 1 si critique (ou erreur d'outil) ; avec `--strict`, aussi si haut.

## Exclusions justifiées

Dans `tests/security/` : `gitleaks.toml` (allowlists), `osv-scanner.toml` (aucune), `semgrep-exclusions.json` (chemins : `node_modules`, `factory` gelée, `spikes`, `.venv-scan`, `dist`).

Faux positifs gitleaks traités (3, règle `generic-api-key`, historique complet) :

- `apps/api/test/rate-limit.test.ts` et `apps/api/test/tickets.test.ts` : constante de test `0123456789abcdef` x2 (séquence évidente, sans valeur).
- `apps/api/test/auth-oidc.test.ts` : identifiant de clé de test (`kid` `p384`) ; les clés sont générées à l'exécution.
- `dev-only-secret-dev-only-secret-0123456789` (`scripts/dev-stack.mjs`) : secret de pile locale, déjà allowlisté ; l'API refuse `AUTH_MODE=dev` en production et exige `WS_TICKET_SECRET` (`apps/api/src/config.ts`).

## Résultat (2026-10-20)

| Volet | Critique | Haut | Moyen | Bas |
|---|---|---|---|---|
| Secrets | 0 (3 faux positifs allowlistés) | 0 | 0 | 0 |
| Dépendances | 0 | 0 | 0 | 0 |
| Code (181 fichiers) | 0 | 0 | 0 | 0 |

Aucune vulnérabilité à corriger ni à consigner ; aucune dépendance mise à jour.

## Limites

Semgrep communautaire ne voit pas les flux de données complexes (p. ex. concaténation dans `exec` sans source HTTP reconnue) : revue humaine toujours nécessaire sur `apps/api/src/{auth-oidc,tickets,ws,http}.ts`. OSV dépend de la base en ligne au moment du scan. Le scan ne couvre ni la configuration d'exploitation (TLS, en-têtes), ni les tests d'intrusion : restes de P5.
