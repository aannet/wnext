# Handoff — 2026-10-22 : recette n°2 exécutée (P6)

Point de départ : `main` à `97c09fb` (note n°2 cadrée et validée). Arrivée : `1cb7522` (26 commits). Rien n'est poussé (pas de remote).

État final vérifié : `make check` vert (2289 tests vitest, 30, 377), `npm run test:browser` 57/57 (axe compris), lints `raw-colors` et `ui-strings` verts.

## Ce qui a été fait

Source de vérité : `docs/05-project/recette/registre.md` (RT, lots, PO, Q6–Q13). Suivi : `docs/05-project/avancement.html`. Règles UX : `docs/02-design/design.md`.

| Lot | Commits | Retours | Résultat |
|---|---|---|---|
| L-H | `ce25e1f` (contrat), `4cdbb66`, `40ad202`, `66ffbe3` | RT-022 | Congé posé approuvé d'emblée ; « En attente » retiré du formulaire, gardé dans l'enum. US-5.1 amendée. |
| L-G | `c387f4f`, `4da5727`, `9ea1617`, `6a2d6a3`, docs `80aaeed`, `8e6f9c9`, `96b5989` | RT-020, RT-021, RT-023 | Socle shadcn/ui sur Base UI 1.9.0 (ADR-010). Button, Modal / Drawer sur Base UI Dialog, 66 boutons migrés, champs en couche `base`, preflight Tailwind actif. |
| RT-035 | `29de368`, `3f0622c` | RT-035 | `npm run dev:recette` : pile `--oidc` puis Vite en `VITE_AUTH_MODE=oidc`. Fin du « Session expirée ». |
| L-I | `53cec76`, `150cca2` | RT-026 à RT-029 | Séparateurs de colonnes, période courante (`aria-current="date"`), jours non travaillés hachurés selon l'horaire daté (BR-19), sam./dim. grisés en en-tête (vue jour). RT-029 conforme, tests de non-régression. |
| L-K | `65ac0cb`, `f57c27b`, `c892eef` | RT-024 | Éditeur d'allocation en drawer (création et édition, Q8), confirmation Q7 (allocation, couleur, congé), Combobox sur Base UI. Correctif : le 2e clic d'un double clic ne referme plus le drawer. |
| L-J | `dfdf1de`, `283e479`, `a16463f`, `6d8fd4d` | RT-025, RT-030, RT-032 | Popover sur Base UI ; en-tête du Planning en deux niveaux, Filtres (compteur, puces, panneau), menu Affichage (densité, « Charge par colonne » en mémoire, Q11), puce temps réel (Q12). Correctif : contraste du survol des boutons pleins (4,42:1 → AA). |
| L-L | `6972de2`, `f4a5ca8`, `1cb7522` | RT-031 | Personnes : tri par nom / rôle / équipe (`aria-sort`), regroupement par équipe. Test de zoom rendu indépendant de la date. |

Reportés en T2 : RT-033 (fériés nationaux par défaut), RT-034 (scinder les créneaux sous un congé).

## Prochaine étape

1. **Recette n°3 par Alec** : `npm run dev:recette`, puis `http://localhost:5173/` (compte Alec). Démo sans API : `?demo=1`.
2. Ses notes vont, verbatim, dans `docs/05-project/recette/notes/` ; cadrage en RT-036+ dans le registre, synthèse `cadrage-3.html` à valider avant d'exécuter.

## En attente d'Alec

- **PO-09** : « recherche (Ctrl+K) » du niveau 1 de l'en-tête (cadrage n°2, RT-025) sans objet défini (personne ? projet ?). Le contrat des vues n'a pas de filtre texte. Non faite.
- **PO-10** : libellés de la grille horaire de la fiche personne qui débordent du drawer de 420 px (antérieur à L-G). Petit correctif d'affichage, hors lot.
- PO-04 à PO-08 (cadrage n°1) toujours ouverts ; PO-08 (portée série / groupe dans l'éditeur) n'a pas été repris en L-K.
- Relecture CODEOWNERS du commit de contrat `ce25e1f` ; relecture des tests SQL (`docs/03-tech/quality/relecture-tests-sql.md`).
- CODEOWNERS vise `/db/migrations/` et `/db/rls/`, qui n'existent pas.

## À savoir pour reprendre

- **Modifications étrangères** : quelqu'un d'autre écrit parfois dans `docs/05-project/avancement.html` (dernier cas : la phrase NEXT, non commitée à l'heure de ce handoff). Ne pas l'écraser ; indexer seulement ses propres hunks (`git hash-object -w --stdin` + `git update-index --cacheinfo`). `factory/orchestrator/*` non suivi : à ignorer (factory gelée).
- **Base UI** :
  - Un portail monte au rendu suivant : `Dialog` et `Popover` prennent le panneau par ref-callback ; `useInitialFocus(el)` reçoit l'élément, pas une ref.
  - Derrière une modale, le reste de la page est `inert` : en Playwright, `includeHidden: true` ou un sélecteur CSS.
  - La Combobox n'ouvre sa liste que sur une vraie frappe (`InputEvent` avec `inputType: "insertText"` dans les tests jsdom). Sa liste et celle du Popover sont dans un portail : chercher les options dans la page, pas dans le dialogue.
  - `event.preventBaseUIHandler()` pour écarter un comportement par défaut (Échap sur Combobox fermée).
- **Dialog** : `data-variant` (modal | drawer) ; `onEscape` = retour d'une étape, sans confirmation ; plus de modale ancrée.
- **Tests navigateur** : mesurer un drawer après son animation (`getAnimations()` → `finished`). axe peut tomber sur un état `:hover` : le survol ne doit jamais éclaircir un bouton plein.
- **Captures** : `node scripts/captures-ecrans.mjs <dossier>` (serveur Vite lancé ; inclut vues semaine et mois). Captures de cette session dans `/tmp/opencode/captures/` (hors dépôt, volatiles).
- **Mémoire VM** : `free -h` avant `test:browser` ; jamais Playwright pendant un `make check`. `test:browser` ≈ 6 min, `make check` ≈ 1 min.
- **Encore natifs** : onglets, groupes radio (densité, couleur), menu de l'avatar, cloche, liens de tableau, liste de la saisie rapide (`.wn-quick-list`).
- **Démo** : le statut temps réel y affiche « Hors connexion » en rouge (pas de serveur temps réel) : attendu.

## Fichiers clés touchés

- `apps/web/src/design/` : `Dialog.tsx`, `Popover.tsx`, `Combobox.tsx`, `overlay.ts`, `ui/button.tsx`, `tokens.css` (`--z-menu`, `--wn-grid-line`, `--wn-nonwork-hatch`, `--wn-col-current`, `--color-*-hover`, `--color-status-offline`).
- `apps/web/src/schedule/` : `grid-model.ts` (`nonWorking`), `grid-dom.ts` (hachures, `data-load`), `grid-header.ts` (`columnsBackground`), `scroller.ts`, `slot-editor-ui.tsx` (drawer), `timeoff-ui.tsx` (`dirty`, `nested`), `filters-ui.tsx` (nouveau), `views-ui.tsx`, `capacity-label.ts` (`capacityTexter`).
- `apps/web/src/ScheduleScreen.tsx` (en-tête deux niveaux, menu Affichage), `ScheduleContainer.tsx` (`RealtimeStatus`), `people/people-model.ts` et `people-screen.tsx` (tri, regroupement).
- `scripts/dev-recette.mjs`, `scripts/captures-ecrans.mjs`, `docs/03-tech/runbooks/demarrage-local.md`.
