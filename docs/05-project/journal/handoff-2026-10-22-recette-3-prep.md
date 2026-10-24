# Handoff — 2026-10-22 : cadrage n°3 autonome exécuté (P6), recette n°3 à faire

Point de départ : `main` à `4f66900` (handoff de la recette n°2). Arrivée : voir `git log` (environ 95 commits, rien n'est poussé, pas de remote).

Mode : à la demande d'Alec (2026-10-22), les points ouverts de la recette n°2 ont été finalisés **sans validation intermédiaire** ; Alec ne fait qu'une recette, à la fin. Chaque décision est au statut « validé (auto) » dans `docs/recette/registre.md` et se confirme ou s'annule à la recette n°3.

État final vérifié sur `main` : `make check` vert (≈ 2 600 tests vitest + 30 + 377), `npm run test:migrations` 26/26, `npm run test:browser` 89/89 (axe compris), `npm run test:browser:oidc` 1/1, `npm run test:recette` 30/30 (pré-recette contre la vraie pile, seed de recette, OIDC).

## Ce qui a été fait

Source de vérité : `docs/recette/registre.md` (section « Cadrage n°3 »). Synthèses : `docs/recette/cadrage-3.html` (cadrage) et `docs/recette/recette-3-preparation.html` (dossier de recette). Suivi : `docs/avancement.html`.

| Lot | Retours | Résultat |
|---|---|---|
| L-M | RT-036, RT-037 | Grille horaire de la fiche personne (jours abrégés) ; onglets, radios, bascules, menus, cloche, liens de tableau, saisie rapide sur Base UI |
| L-R | RT-044 | `npm run dev:recette:seed` (compte « WNEXT Recette », 18 personnes, 6 comptes de connexion) et `dev:recette:vide`, sur bases dédiées gardées (marqueur, realpath, `.dev-pg/` jamais touché) ; `scenarios.md` R-01..R-32 ; `npm run test:recette` |
| L-O1 | RT-039 | `managerUserIds` dans les projets (co-gestion BR-33 dans l'éditeur) — contrat |
| L-N | RT-038 | Palette Ctrl+K / ⌘K : personne (défilement, mise en évidence, confirmation avant de retirer les filtres, « Rétablir les filtres »), projet (`/projets?projet=<id>`) |
| L-O2 | RT-040 | Colonne « Accès » (owner, admin, chef de projet) — contrat ; `check:breaking` : exceptions relues dans `packages/contracts-tools/breaking-allowlist.json` |
| L-P | RT-042 | Portée série (occurrence / série) et groupe (ligne / groupe) dans le drawer |
| L-O3 | RT-041 | `GET` / `PATCH /account`, Réglages > Compte éditable — contrat |
| L-Q | RT-043 | Appui long au toucher en case vide |
| L-S | RT-045 | CODEOWNERS sur `/schema.sql`, `/migrations/`, `/tests/sql/` |
| L-T | RT-046 | Création à la souris bornée à la vue ; deuxième doigt annule un glisser |
| L-U | RT-047 | Supprimer, dupliquer, scinder (Suppr, Ctrl+D, S, Alt+glisser, menu du bloc, drawer), annulables — contrat (option `Prefer` du DELETE de groupe) |
| L-V | RT-048 | Un member ne voit que sa personne (REST : autre personne = 404 ; temps réel filtré, `resync` au besoin) ; migration `0006_change_log_person` — contrat (descriptions) |
| L-W | RT-049, RT-050 | Focus rendu au bouton qui ouvre le drawer ; tailles de densité de nouveau effectives |

RT-046 à RT-050 ont été trouvés pendant l'exécution : RT-046 par la revue croisée de L-Q, RT-047 à RT-050 par la pré-recette automatisée.

## Méthode (pour reprendre la même)

- Orchestrateur (Opus) dans la session principale ; un sous-agent par lot dans un worktree `/home/alec/projects/wnext-wt/<lot>` (`npm ci`, `scripts/init-worktree.sh`, `/usr/bin/git`, port Playwright propre). Briefs : un brief commun (règles du dépôt, tests d'abord, rapport) + un brief de lot avec l'analyse préalable (fichiers et lignes).
- Modèles : Opus pour le contrat, la grille, les gestes, la sécurité ; Sonnet pour les écrans et les scripts ; Haiku/Sonnet pour la doc.
- Revue croisée de chaque diff par un modèle d'une autre famille (GPT-6.1 Sol), en lecture seule, verdict FUSIONNABLE / À CORRIGER : 9 lots sur 12 ont été renvoyés au moins une fois, avec de vrais défauts (garde-fous de données du seed, `check:breaking` trop permissif, multi-touch, focus, réponses tardives, fin de série, annulation de groupe incomplète, rattrapage temps réel après migration). À garder.
- Fusion : `rebase main` dans le worktree puis `merge --ff-only`, `make check` sur `main` après chaque fusion.

## En attente d'Alec

- Recette n°3 : `npm run dev:recette:seed`, puis `http://localhost:5173/` ; comptes dans `docs/recette/scenarios.md` (Mode d'emploi). Dossier : `docs/recette/recette-3-preparation.html`.
- Confirmer ou annuler les décisions RT-036 à RT-050 ; trancher PO-11 à PO-16 (registre).
- Relectures CODEOWNERS : commits de contrat `ce25e1f`, `562dc2b`, `329634a` (contient encore le contrôle permissif, annulé par `94d52e6`), `94d52e6`, `c77071d`, `4694afa`, `18030ac`, `a69d28e`, `3b7b5ec` ; migration `migrations/0006_change_log_person.sql` ; changement de `.github/CODEOWNERS` (`55a3456`).
- Relecture des tests SQL (`docs/review/relecture-tests-sql.md`).

## À savoir pour reprendre

- **Ta base de dev `.dev-pg`** n'a pas reçu la migration 0006 : elle s'appliquera au prochain `npm run dev:stack` / `dev:recette`. La pile lancée le 21 octobre (pid 40952) tourne toujours avec l'ancien code.
- **`test:browser:oidc`** : toujours avec `WNEXT_DEV_PG_DIR=/tmp/opencode/<neuf>` (sinon il vise `.dev-pg`). **`test:recette`** : `WNEXT_RECETTE_PG_DIR=/tmp/opencode/<neuf>` ; un répertoire non marqué est refusé (garde-fou).
- **Modification étrangère** de `docs/avancement.html` : la phrase NEXT non commitée (« Recette n°3 par Alec … PO-09 … PO-10 ») a été remplacée par la nouvelle liste NEXT, devenue obsolète (PO-09 et PO-10 traités).
- **Tests navigateur dépendants de la date** : le 23 octobre, `slot-editor`, `timeoffs` et `overlays` échouaient (la démo est relative à « aujourd'hui » et aucun bloc convenable ne commençait dans la vue) ; ces trois specs installent désormais l'horloge de la page sur un jeudi connu (`page.clock.install`). Autres specs à surveiller de la même façon.
- **Processus orphelins** : un sous-agent interrompu (crédit du fournisseur épuisé un moment) a laissé des piles et des Vite ; ils ont été arrêtés. Vérifier `ss -ltnp` si un port de test est occupé.
- Pièges Base UI : `docs/handoff-2026-10-22-recette-2.md` reste valable ; `docs/design/design.md` a reçu les nouvelles règles (palette, portée, commandes d'un bloc, création au toucher et à la souris, focus des étapes).
