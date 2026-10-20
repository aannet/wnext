# ADR-009 — Tailwind CSS pour l'interface web

Statut : accepté (2026-10-21, demande d'Alec, retour RT-019 de la note de recette n°1).

## Contexte

`apps/web` est stylé par une feuille provisoire (`styles.css`, environ 130 lignes) avec des couleurs en dur. P6 introduit un design system complet : tokens, primitives, écrans. Alec demande Tailwind, en tant que bibliothèque et non comme framework.

## Décision

- **Tailwind CSS v4** en mode CSS d'abord, via le plugin `@tailwindcss/vite`, avec des versions exactes épinglées.
- Les design tokens de `ux-ui.md` §3 vivent dans `apps/web/src/design/tokens.css`, dans un bloc `@theme`. Les utilitaires Tailwind et le CSS restant consomment les mêmes variables.
- **Aucune couleur en dur** hors `tokens.css`, ni valeur arbitraire de couleur (`bg-[#…]`). Le garde-fou `scripts/lint-raw-colors.mjs` l'impose dans `make check`.
- Le reset (preflight) de Tailwind n'arrive qu'avec les primitives (lot D2), pour ne pas casser l'existant.
- La grille garde ses contraintes de performance (`contain: strict`, DOM recyclé, styles posés par `grid-dom`). Tailwind ne s'applique pas aux éléments recyclés à chaud quand une classe dédiée est plus sûre.

## Conséquences

- Les primitives (D2) et les écrans (L-B, L-F) sont écrits avec les utilitaires Tailwind.
- Le futur mode sombre se fera par redéfinition des tokens, sans dupliquer les classes.
