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

### Exceptions relues de `check:breaking`

Un `$ref` renommé en réponse est une rupture. Seule exception : une entrée de `packages/contracts-tools/breaking-allowlist.json`, ajoutée dans le commit de contrat (donc relue avec lui), avec `method` (minuscules), `path`, `status`, `at` (emplacement sous la réponse tel que l'affiche le rapport : `""` à la racine, `".items[]"` pour les éléments d'une liste), `from` et `to` (`#/components/schemas/<Nom>`), `reason` et `rt` (`RT-NNN`). L'exception n'est acceptée que si l'entrée correspond exactement ET que le nouveau schéma est l'ancien plus des propriétés facultatives, sans autre écart (type, `required`, `nullable`, enum, `oneOf`/`anyOf`, `additionalProperties`, `allOf`...) ; sinon la rupture est signalée. Une entrée mal formée fait échouer la commande. Les entrées restent après fusion (elles ne couvrent plus rien une fois la base à jour) : on peut les retirer lors d'une version d'API.

Un nouveau schéma nommé doit porter `.meta({ id: "Nom" })` pour devenir un composant OpenAPI réutilisable.

## Limites

- `check:breaking` est une comparaison structurelle maison (oasdiff n'est pas installable via npm). Couvre : opération/réponse supprimée, propriété supprimée, `required` retiré, type ou `$ref` changé, valeur d'enum retirée (côté réponses), nouveau paramètre requis. Côté requête : propriété requise ajoutée, valeur d'enum retirée, type changé, variante d'union retirée, corps devenu requis. Ne couvre pas : `allOf`, changements sémantiques, ni la déclaration d'une rupture « autorisée » (bump de version).
- Le générateur de client est maison (`contracts-tools/src/client.ts`, sous-ensemble OpenAPI produit par zod-to-openapi ; erreur explicite sur construction inconnue). Gère paramètres de requête, de chemin et d'en-tête, corps JSON et réponse 204 (pas les cookies ni les corps non JSON).
- Temps réel (ADR-003 §5) : schémas Zod versionnés dans `src/realtime.ts` (messages `subscribe` / `changes` / `ready` / `resync` / `error` / `notifications`, chemin `REALTIME_PATH`). Ils ne sont PAS dans `openapi.json` (pas d'AsyncAPI généré) ni couverts par `check:breaking` ; la compatibilité repose sur `v` et la revue humaine.
