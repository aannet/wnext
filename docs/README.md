# Documentation WNEXT

Rangement par domaine, numéroté pour l'ordre de lecture. Statut : **vivant** (tenu à jour), **figé** (référence qu'on ne modifie plus), **historique** (trace datée).

| Dossier | Contenu | Statut |
|---|---|---|
| [`00-factory/`](00-factory/) | Stratégie et phases P0..P6 (`strategy.md`), gel de la factory, preuves des garde-fous | figé (factory gelée) |
| [`01-product/`](01-product/) | Dossier de fondamentaux v1.1 : intention, règles `BR-xx`, exigences, feuille de route | vivant (les ADR priment) |
| [`02-design/`](02-design/) | Règles d'UX et de composants (`ux-rules.md`), écrans et parcours | vivant |
| [`03-tech/`](03-tech/) | Architecture front/back/base (`architecture.html`), doc API générée depuis le contrat (`api.html`, ne pas éditer), diagramme du schéma v1.1, `runbooks/` (exploitation), `quality/` (scan de sécurité, Schemathesis, charge temps réel, relecture des tests SQL) | vivant |
| [`04-specs/`](04-specs/) | Spécifications par fonctionnalité (gabarit dans son README) | vivant (à remplir) |
| [`05-project/`](05-project/) | Avancement (`avancement.html`), `recette/` (notes verbatim, registre `RT-NNN`, cadrages, scénarios), `journal/` (plans et handoffs datés) | vivant ; `journal/` historique |
| [`06-decisions/`](06-decisions/) | ADR-001 à ADR-010, questions ouvertes, direction visuelle et choix de l'accent (`direction-visuelle.md`), `reviews-v1.1/` (revues par rôle qui ont nourri ADR-001), `annexes/` (mesures du spike de grille, résultats du spike d'orchestrateur, comparatif des accents) | vivant ; revues et annexes figées |
| [`99-archive/`](99-archive/) | Matériel v1.0 remplacé (dossier et schéma), images de référence du 2026-10-18 (`input-dump/`) | figé, ne pas utiliser |

À la racine du dépôt, deux fichiers lus par l'outil Impeccable, qui doivent y rester : `DESIGN.md` (système visuel : tokens, typographie, marque, composants) et `PRODUCT.md` (résumé d'une page du dossier de fondamentaux).

Règle de conflit : les ADR de `06-decisions/` priment sur le dossier de fondamentaux.

## Anciens chemins

Rangement du 2026-10-24. Certains fichiers gelés citent encore les anciens chemins : `schema.sql` (sa somme SHA-256 est contrôlée par `scripts/migrate.mjs`) et le matériel archivé.

| Ancien | Nouveau |
|---|---|
| `docs/factory/` | `docs/00-factory/` |
| `docs/dossier-fondamentaux-v1.1.md` | `docs/01-product/dossier-fondamentaux-v1.1.md` |
| `docs/design/`, `docs/ecrans-et-parcours.html` | `docs/02-design/` |
| `docs/schema-v1.1-diagram.html` | `docs/03-tech/schema-v1.1-diagram.html` |
| `docs/runbooks/` | `docs/03-tech/runbooks/` |
| `docs/review/{scan-securite,schemathesis-ecarts,charge-temps-reel,relecture-tests-sql}.md` | `docs/03-tech/quality/` |
| `docs/avancement.html` | `docs/05-project/avancement.html` |
| `docs/recette/` | `docs/05-project/recette/` |
| `docs/plan-*.md`, `docs/handoff-*.md` | `docs/05-project/journal/` |
| `docs/decisions/` | `docs/06-decisions/` |
| `docs/review/{archi-fonctionnel,archi-solution,product,ux-ui}.md` | `docs/06-decisions/reviews-v1.1/` |
| `docs/archive/` | `docs/99-archive/` |
| `input-dump/` (racine) | `docs/99-archive/input-dump/` |
| `docs/02-design/design.md` | `docs/02-design/ux-rules.md` |
| `docs/02-design/direction.md` | `docs/06-decisions/direction-visuelle.md` |
| `docs/02-design/comparatif-accents.html` | `docs/06-decisions/annexes/comparatif-accents.html` |
| `spikes/grille/results/` | `docs/06-decisions/annexes/ADR-005-mesures/` (code du spike : historique git, `2f38ccb`) |
| `spikes/orchestrateur/RESULTATS.md` | `docs/06-decisions/annexes/ADR-007-spike-orchestrateur.md` (code : `3ed083c`, `d0d8fc5`) |
