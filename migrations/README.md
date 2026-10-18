# Migrations

- `0001_init` est la baseline : `schema.sql` à la racine. Tant qu'aucune base n'a été déployée, on la modifie
  directement ; après le premier déploiement, elle est figée (sa somme de contrôle est vérifiée) et tout changement
  passe par un fichier ici.
- Nom : `NNNN_nom.sql` (4 chiffres, minuscules, chiffres et `_`), à partir de `0002`. Une migration par fichier,
  exécutée dans une transaction ; ne pas y mettre `BEGIN`/`COMMIT`.
- Appliquer : `DATABASE_URL=postgres://... npm run db:migrate` ; état : `npm run db:migrate -- --status`.
- Le registre est `wnext_migrations.applied` (hors du schéma `public`, sans droit pour `app_user`).
- Refus : migration appliquée puis modifiée ou supprimée, nouvelle migration numérotée sous la dernière appliquée.
- Tests : `npm run test:migrations` (base vierge sur embedded-postgres, puis la suite SQL de non-régression).
