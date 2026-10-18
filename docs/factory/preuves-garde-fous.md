# Preuves des garde-fous (L6)

Les garde-fous `scripts/guardrails/` (commit `c598205`) doivent échouer sur de vraies PR fautives. Preuve rejouable : `node tests/guardrails/prove-guardrails.mjs` (depuis la racine du dépôt). Chaque cas tourne dans un worktree jetable (branche `l6/prove-<cas>`, base `main`), supprimé à la fin. Le dépôt principal, la branche courante et `main` ne sont pas modifiés.

## Cas et résultats

| Cas | Attendu | Obtenu | Verdict |
|---|---|---|---|
| 1a affaiblissement de test, sans label (`--base` = SHA du commit A) | code 1 | code 1 ; violations : expect-removed, matcher-weakened | OK |
| 1b idem, `PR_LABELS=test-change-approved` | code 0 + violations listées | code 0 ; violations : expect-removed, matcher-weakened | OK |
| 2a fichier source de 500 lignes (non exclu), `--base main` | code 1 | code 1 ; 500 lignes modifiées > 400 | OK |
| 2b fixture `tests/**/fixtures/` de 500 lignes, `--base main` | code 0 (exclue) | code 0 ; 0/400 lignes | OK |
| 3a `BR-99` dans `br-scope.json`, sans test `@BR-99` | code 1 | code 1 ; BR-99 sans test | OK |
| 3b idem, avec un test portant `@BR-99` | code 0 | code 0 ; 1 BR couverte | OK |

## Sortie réelle

```
| Cas | Attendu | Obtenu | Verdict |
|---|---|---|---|
| 1a affaiblissement, sans label | code 1 | code 1 ; violations : expect-removed, matcher-weakened | OK |
| 1b idem, PR_LABELS=test-change-approved | code 0 + violations listees | code 0 ; violations : expect-removed, matcher-weakened | OK |
| 2a fichier src de 500 lignes (non exclu), --base main | code 1 | code 1 ; pr-size : 500 lignes modifiees > 400. Decouper la PR. Plus gros fichiers : | OK |
| 2b fixture tests/**/fixtures de 500 lignes, --base main | code 0 (exclue) | code 0 ; pr-size : 0/400 lignes, OK | OK |
| 3a BR-99 dans br-scope.json, sans test @BR-99 | code 1 (BR-99 manquante) | code 1 ; br-coverage : BR sans test @BR-xx : BR-99 | OK |
| 3b idem, avec test @BR-99 | code 0 | code 0 ; br-coverage : 1 BR du perimetre couvertes, OK | OK |

### 1a
$ node scripts/guardrails/test-weakening.mjs --base 9b208e117f3a3fb3d61ceaf8039b8dfe94ef67e7
tests/guardrails/exemple-affaibli.test.ts: [expect-removed] 3 -> 2 assertions expect()
tests/guardrails/exemple-affaibli.test.ts: [matcher-weakened] toBe/toEqual/toStrictEqual 3 -> 1, toBeTruthy/Defined/Falsy 0 -> 1
test-weakening : echec. Seul un humain peut poser le label test-change-approved.

### 1b
$ node scripts/guardrails/test-weakening.mjs --base 9b208e117f3a3fb3d61ceaf8039b8dfe94ef67e7 (PR_LABELS=test-change-approved)
tests/guardrails/exemple-affaibli.test.ts: [expect-removed] 3 -> 2 assertions expect()
tests/guardrails/exemple-affaibli.test.ts: [matcher-weakened] toBe/toEqual/toStrictEqual 3 -> 1, toBeTruthy/Defined/Falsy 0 -> 1
test-weakening : derogation (label test-change-approved, pose par un humain)

### 2a
$ node scripts/guardrails/pr-size.mjs --base main
pr-size : 500 lignes modifiees > 400. Decouper la PR. Plus gros fichiers :
  500	packages/demo/gros.ts

### 2b
$ node scripts/guardrails/pr-size.mjs --base main
pr-size : 0/400 lignes, OK

### 3a
$ node scripts/guardrails/br-coverage.mjs --base main
br-coverage : BR sans test @BR-xx : BR-99

### 3b
$ node scripts/guardrails/br-coverage.mjs --base main
br-coverage : 1 BR du perimetre couvertes, OK

Resultat : tous les cas conformes
```

## Écarts et limites

- Aucun garde-fou n'a laissé passer une PR fautive dans ces trois cas.
- `br-coverage.mjs` n'accepte pas `--base` (le flag est ignoré) : il lit le périmètre et les tests de l'arbre de travail, pas le diff de la PR. Une BR retirée du périmètre n'est donc pas détectée, et le cas 3 ne prouve pas le comportement « par PR ».
- `test-weakening` ne voit que `toBe`/`toEqual`/`toStrictEqual` → `toBeTruthy`/`toBeDefined`/`toBeFalsy`. Un autre affaiblissement (ex. `toBe` → `toMatch`) n'est pas couvert par ces cas et n'a pas été testé.
