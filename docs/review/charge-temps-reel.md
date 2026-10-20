# Charge temps réel (amorce P5)

Objectifs (`docs/factory/strategy.md` §1) : P2, p95 de propagation < 1 s à 50 clients ; P5, même objectif à 500 clients.
Commande : `npm run load:realtime` (hors `make check`, pas de CI). Script : `tests/load/run.mjs` ; résultats bruts : `tests/load/out/resultats.json` (ignoré par git), journal de la pile : `tests/load/out/stack.log`.

## Méthode

- Pas de k6 : le protocole tient en trois appels (ticket, WebSocket, `subscribe`) et `ws` est déjà une dépendance ; un script node évite un binaire de plus. `npm run perf:realtime` (vitest) reste le contrôle rapide à 50 clients en base embarquée.
- Pile dédiée par `scripts/dev-stack.mjs --reset` : API `:3300`, Postgres embarqué `:54359`, dossier `tests/load/out/pg`, RLS active (`app_user`), `AUTH_MODE=dev`. Les limites de débit des tickets et upgrades sont relevées (elles protègent la production, elles fausseraient la mesure) ; `WS_MAX_PER_ACCOUNT` = clients + 100.
- N clients : ticket neuf (`POST /realtime/ticket`), WebSocket, `subscribe` depuis le `changeCursor` du Schedule, attente de `ready` (connexions par paquets de 50).
- Un écrivain : 100 `PATCH /allocations/{id}` (`If-Match`, corps `{notes}`) toutes les 200 ms (5/s) sur 20 allocations en rotation.
- Latence = arrivée du changement (id + version) chez un client moins le début de la requête PATCH : borne haute, elle inclut l'écriture HTTP. Perte = notification attendue (N par PATCH) non reçue dix secondes après la dernière écriture.
- Variables : `LOAD_CLIENTS` (`50,500`), `LOAD_WRITES`, `LOAD_GAP_MS`, `LOAD_SETTLE_MS`, `LOAD_P95_MS`, `LOAD_API_PORT`, `LOAD_PG_PORT`. Code de sortie 1 si p95 >= objectif, perte, ou écriture en erreur.

## Résultats (2026-10-20, WSL2 15 Go, Node 22, une seule machine pour pile et clients)

| Clients | Écritures | Reçus / attendus | Pertes | p50 | p95 | p99 | max | Écriture HTTP p50 / p95 | Objectif p95 < 1 s |
|---|---|---|---|---|---|---|---|---|---|
| 50 | 100 | 5 000 / 5 000 | 0 | 22 ms | 34 ms | 49 ms | 81 ms | 5 / 9 ms | atteint (P2) |
| 500 | 100 | 50 000 / 50 000 | 0 | 341 ms | 444 ms | 457 ms | 474 ms | 227 / 234 ms | atteint (P5) |

Aucune socket coupée, aucun refus (429), aucune écriture en erreur. Connexion de 500 clients : 1,6 s.

## Lecture

- Les deux objectifs tiennent avec marge (p95 444 ms à 500 clients), sous réserve des limites ci-dessous.
- Constat à suivre : à 500 clients la durée de l'écriture HTTP elle-même passe de 5 ms à 227 ms (cadence réelle 4,4/s au lieu de 5/s). La latence mesurée l'inclut : la propagation après validation vaut donc environ 110 à 220 ms. Hypothèse, non vérifiée : le fan-out du `ChangeHub` (une lecture de `change_log` partagée, puis 500 envois) occupe la boucle d'événements de l'API, qui sert aussi le PATCH. À profiler avant de monter au-delà (`--cpu-prof` sur `apps/api/src/main.ts`).

## Limites de la mesure

- Pile et 500 clients tournent sur la même machine (VM partagée avec d'autres charges) et le générateur est un seul processus node : une partie de la latence est du côté client. Les chiffres sont une borne haute sur ce point, mais pas une mesure réseau réelle.
- Un seul compte, un seul écrivain, 5 écritures/s : pas de rafale, pas de reconnexion en masse (thundering herd), pas de test de saturation de `WS_MAX_PER_ACCOUNT` ni des limites de débit. Base de 50 personnes et 300 allocations, donc `change_log` petit.
- Postgres embarqué (non réglé) : pas représentatif d'une base gérée ; pas de PgBouncer ni de plusieurs instances d'API (le NOTIFY est alors reçu par chacune, voir `docs/runbooks/incident-temps-reel.md`).
- Reste pour P5 : rafales (50 écritures/s), reconnexion simultanée de 500 clients, plusieurs comptes, test de longue durée (fuites mémoire), mesure sur environnement cible.
