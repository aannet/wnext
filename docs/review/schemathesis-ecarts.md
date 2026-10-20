# Écarts contrat / API relevés par Schemathesis

Source : `npm run test:schemathesis` (Schemathesis 4.32.1, `packages/contracts/openapi.json`, 25 exemples par opération, phases examples + coverage + fuzzing, rôles admin puis member). Le contrat (`packages/contracts`) n'est pas modifié par ce lot : chaque écart est consigné avec la correction proposée, et neutralisé dans `tests/schemathesis/schemathesis.toml` (à retirer une fois le contrat corrigé).

Bilan : aucun 500, aucune réponse non conforme à son schéma, aucun code d'erreur hors `ErrorCode`, 403 conformes pour member. Les écarts sont tous du côté de l'expressivité du contrat.

## E-01 — Validations sémantiques non exprimées (check `positive_data_acceptance`, ST202)

Désactivé globalement. Sans l'exclusion, 45 à 50 opérations échouent : Schemathesis génère des requêtes valides au schéma que l'API refuse en 400, à juste titre.

| Cause | Opérations (exemples) | Exemple | Correction de contrat proposée |
|---|---|---|---|
| Curseur de pagination opaque (`string`) | toutes les listes (`GET /clients`, `/people`, `/projects`, `/phases`, ...) | `?cursor=%F2%A3...` -> 400 `SCHEDULE_CURSOR_INVALID` | Documenter le format (base64url) via `pattern`, ou accepter qu'un curseur invalide reste un 400 documenté et lever l'exclusion avec un `example` |
| Plage de dates plafonnée à 400 jours | `GET /schedule`, `/logged-time`, `/people/{id}/allocations`, `/projects/{projectId}/allocations`, `POST /logged-time/prefill` | `from=0216-05-19&to=3554-08-03` -> 400 `SCHEDULE_RANGE_INVALID` (`maxDays: 400`) | Exprimer la contrainte (extension `x-max-range-days`) ou la couvrir par la description ; `from <= to` ne l'est pas non plus |
| Objets stricts sans `additionalProperties: false` (seuls 2 schémas l'émettent, alors que les schémas Zod sont `.strict()`) | tous les `PATCH` et `POST` à corps | clé inconnue dans le corps -> 400 `VALIDATION_FAILED` `field=body` | Émettre `additionalProperties: false` pour les schémas `.strict()` dans le générateur OpenAPI |
| Id décimal non exprimé : `Id` = `string` `minLength: 1` | tous les chemins `{id}` et champs `*Id` | `personId: "WØ"` -> 400 | `pattern: "^[0-9]+$"` sur `Id` (déjà supposé par le fuzz local, `\\d`) |
| Contraintes inter-champs (`refine`) | `POST /allocations` (`endDate >= startDate`), `POST /timeoffs`, `POST /people` (`workDaysHours` <= 24, 7 valeurs), `POST /logged-time` (`hours`), `POST /allocations/{id}/split` (`delete` vs `patch`), `POST /allocation-groups` (`members`) | `endDate` avant `startDate` -> 400 | Exposer en `description` / `x-constraints`, ou accepter l'exclusion |
| Garde de confirmation | `POST /people/{id}/deactivation` | 428 `PERSON_DEACTIVATION_CONFIRMATION_REQUIRED` | Attendu (BR-31) ; 428 est documenté |

## E-02 — `If-Match` absent : 428 (check `missing_required_header`, ST203)

Désactivé globalement. Schemathesis n'accepte que 400/401/403/406/415/422 pour un en-tête requis manquant. L'API répond 428 `PRECONDITION_REQUIRED` (RFC 6585, le statut correct), et le contrat le documente (`428` présent sur les `DELETE`/`PATCH` concernés). Faux positif ; la couverture du `If-Match` (absent, malformé, périmé) reste assurée par `tests/e2e/api-fuzz.test.ts` et les tests d'API.

## E-03 — Méthode non déclarée : 404 (checks `unsupported_method`, `allow_header_conformance`)

Désactivés globalement. Le routeur maison répond 404 (ApiError) sur une méthode non déclarée au lieu de 405 + `Allow`. Sujet de routage, hors contrat de ressource ; à traiter si un client doit pouvoir distinguer les deux.

## E-04 — `requestBody` requis, mais l'API accepte l'absence de corps (check `negative_data_rejection`, ST201)

Opérations : `POST /api/v1/people/{id}/deactivation`, `POST /api/v1/projects/{projectId}/team/{personId}/removal`. Exclues par opération.

Exemple : `curl -X POST .../api/v1/people/51/deactivation` sans corps -> 200 (personne désactivée), alors que le contrat déclare `requestBody.required: true`. Le code fait volontairement `req.body ?? "{}"` (`apps/api/src/http.ts`) et des tests existants s'appuient sur cette tolérance (`apps/api/test/team.test.ts`, `person-deactivation.test.ts`) ; tous les champs du corps sont optionnels et la garde 428 (confirmation) reste appliquée, donc aucun risque métier.

Correction proposée (contrat) : `requestBody.required: false` pour ces deux opérations (corps optionnel). L'alternative, durcir l'API (400 sans corps), casserait ces tests et les clients qui n'envoient pas de corps ; non retenue dans ce lot.

## E-05 — 404 non documenté sur `GET /api/v1/logged-time` (check `status_code_conformance`, ST103)

Opération exclue pour ce check. Exemple : `GET /api/v1/logged-time?personId=0&from=2000-01-01&to=2000-01-01` -> 404 `{"code":"NOT_FOUND","params":{"entity":"person"}}`, alors que seuls 200, 400, 401, 500 sont documentés (le 403 n'y existe pas : lecture ouverte à member).

Correction proposée (contrat) : ajouter la réponse `404` (`ApiError`) à `listLoggedTime`. Constat voisin : les autres listes filtrées par une entité (`/people/{id}/allocations`, ...) documentent déjà leur 404.

## Hors périmètre / limites

- La phase `stateful` est désactivée : le contrat ne déclare aucun `links` ; 41 opérations (corps/ids inexistants) rebondissent surtout sur 404 (avertissement « Missing test data »). Ajouter des `links` OpenAPI (création -> lecture/modification/suppression) donnerait une vraie couverture des chemins heureux et de `use_after_free`.
- La phase `examples` est vide : aucun `example` dans le contrat.
