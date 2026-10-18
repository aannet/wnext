# @wnext/contracts

Source de vérité du contrat d'API (ADR-003). Ce paquet ne dépend que de `zod` : schémas (`src/*.ts`) et table de routes (`src/routes.ts`, données pures).

## Chaîne contract-first

Zod (`src/`) -> `openapi.json` (généré, commité) -> client TS `apps/web/src/api/client.gen.ts` (généré, commité).
L'outillage vit dans `packages/contracts-tools` (hors graphe de `apps/*`) ; il n'est jamais exécuté dans le serveur.

## Procédure de régénération

1. Modifier les schémas / routes dans `packages/contracts/src` (commit séparé relu, CODEOWNERS).
2. `npm run generate:contract` : réécrit `openapi.json` et `client.gen.ts`.
3. `npm run check:contract` : échoue (code 1) si l'un des deux diffère de la génération (dérive).
4. `npm run check:breaking` : compare la spec courante à celle de `HEAD` (`--ref origin/main` ou `--base fichier.json`) ; échoue sur rupture.
5. Ne jamais éditer `openapi.json` ni `client.gen.ts` à la main.

Un nouveau schéma nommé doit porter `.meta({ id: "Nom" })` pour devenir un composant OpenAPI réutilisable.

## Limites

- `check:breaking` est une comparaison structurelle maison (oasdiff n'est pas installable via npm). Couvre : opération/réponse supprimée, propriété supprimée, `required` retiré, type ou `$ref` changé, valeur d'enum retirée (côté réponses), nouveau paramètre requis. Ne couvre pas : corps de requête (durcissement), `allOf`, changements sémantiques, ni la déclaration d'une rupture « autorisée » (bump de version).
- Le générateur de client est maison (`contracts-tools/src/client.ts`, sous-ensemble OpenAPI produit par zod-to-openapi ; erreur explicite sur construction inconnue). Pas encore de paramètres de chemin/requête ni de corps.
- WebSocket / AsyncAPI (ADR-003 §5) : non traité.
