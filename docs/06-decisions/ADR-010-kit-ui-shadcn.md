# ADR-010 — Kit UI : shadcn/ui

Statut : accepté (2026-10-21, décision d'Alec, retour RT-020 de la note de recette n°2 ; socle Base UI acté au cadrage n°2, Q13).

## Contexte

ADR-009 pose Tailwind v4 et les tokens. Les primitives (Modal, Popover, Drawer, Combobox, Button) sont maison dans `apps/web/src/design/` : testées (a11y, axe, superposition), mais d'un rendu jugé peu moderne par Alec. La note n°2 demande un produit « moderne » avec un header de filtres et un drawer d'édition. Trois options ont été comparées : DaisyUI (habillage CSS seul), TailGrids v3 (composants copiés, jeune) et shadcn/ui (composants copiés sur un socle accessible).

## Décision

- **shadcn/ui** est le kit de composants. Le code des composants vit dans le dépôt, sous `apps/web/src/design/ui/`, et reste modifiable (principe « open code »).
- **Socle des primitives : Base UI.** Vérifié le 2026-10-21 dans le changelog shadcn : Base UI est le socle par défaut depuis juin 2026 ; Radix (paquet unifié) et React Aria restent supportés. Radix sert de repli si un test de comportement existant casse avec Base UI (changement par ADR).
- **Tokens** : les variables shadcn (`--background`, `--foreground`, `--primary`, `--ring`, etc.) sont définies dans `apps/web/src/design/tokens.css`, sous forme de valeurs `oklch`, et référencées via `@theme inline`. Aucune couleur n'est écrite ailleurs. Le garde-fou `npm run lint:raw-colors` reste inchangé et doit passer en l'état.
- **Preflight** : le reset Tailwind est introduit avec le lot socle, comme prévu par ADR-009 (« lot D2 »). Les écrans existants sont migrés en même temps.
- **Utilitaire `cn`** : `twMerge(clsx(...))`, en paquet `cn` ou en fichier local `lib/utils.ts` (`src/design/cn.ts`) ; choix à faire à l'implémentation, sans changer l'API.
- **Ce qui ne change pas** : la grille DOM virtualisée (ADR-005), `contain: strict` et les styles posés par `grid-dom` ne passent pas par les composants shadcn. Les tests de comportement des primitives actuelles (Échap, Fermer, focus, superposition) sont la référence de recette de la migration.
- **Frontières** : `apps/web` n'importe toujours que `contracts` et `engine` (ADR-003). Un composant shadcn ne doit pas introduire de dépendance vers `apps/api`.

## Conséquences

- Migration des primitives existantes (Button, Modal, Popover, Drawer, Combobox) vers shadcn avant les écrans : c'est le premier lot du cadrage n°2.
- Le principe de fermeture des drawers (clic hors panneau, Échap) est consigné dans `docs/02-design/ux-rules.md`.
- Un changement de socle (Radix ↔ Base UI) reste possible par un ADR ultérieur, sans toucher aux écrans.

## Alternatives écartées

- **DaisyUI** : habillage propre mais générique ; ne couvre pas le comportement (focus, clic hors panneau), donc les primitives resteraient à nous. Écarté au profit d'un rendu plus moderne.
- **TailGrids v3** : composants copiés comme shadcn, mais projet jeune et qualité d'accessibilité non vérifiée ; écarté au profit d'un socle plus mûr.
- **Untitled UI** (React Aria, noyau gratuit) : finition très soignée, mais système de styles plus lourd à reprendre et partie payante. Gardé en réserve si shadcn ne convient pas.
- **Catalyst** : payant (Tailwind Plus), catalogue restreint.
