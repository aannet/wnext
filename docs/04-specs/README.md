# Spécifications par fonctionnalité

Une spec par fonctionnalité (`schedule.md`, `conges.md`, `capacite.md`…). Elle décrit le comportement attendu tel qu'il est livré. Elle ne remplace ni le dossier de fondamentaux (intention, `BR-xx`) ni les ADR (décisions) : elle y renvoie.

## Gabarit

```markdown
# <Fonctionnalité>

Statut : brouillon | à jour au <date> · Règles : BR-xx, BR-yy · ADR : ADR-00n

## Objectif
Le besoin utilisateur en deux ou trois phrases.

## Parcours
Étapes principales, renvoi vers `../02-design/ecrans-et-parcours.html#<ancre>`.

## Règles
Comportements et cas limites, chacun relié à sa règle `BR-xx` ou à son retour `RT-NNN`.

## Contrat
Routes, événements temps réel et codes d'erreur de `packages/contracts` concernés.

## Tests
Où se trouve la preuve (tests unitaires, navigateur, scénarios `R-xx` de `../05-project/recette/scenarios.md`).

## Questions ouvertes
```
