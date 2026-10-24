# Runbook : incident temps réel

Chaîne : écriture (transaction) -> trigger `log_change` -> ligne dans `change_log` + `pg_notify('wnext_changes', <account_id>)` au COMMIT -> connexion d'écoute dédiée (`apps/api/src/pg-listen.ts`) -> `ChangeHub` (`change-hub.ts`) -> sessions WebSocket (`ws.ts`, `realtime.ts`) -> clients (`apps/web/src/realtime/client.ts`).
Le journal est la source de vérité : un NOTIFY perdu ne perd aucune donnée, il retarde seulement la livraison jusqu'au filet de sondage (`POLL_INTERVAL_MS`, 1 s par défaut ; 5 s dans `perf:realtime`).

## Symptômes -> diagnostic

| Symptôme | Cause probable | Vérifier |
|---|---|---|
| Les modifications d'autrui n'arrivent qu'après ~1 s | l'écoute NOTIFY est coupée, seul le sondage fonctionne | logs API : `"source":"listen"` ; `SELECT pid, state, query FROM pg_stat_activity WHERE query LIKE 'LISTEN%'` doit renvoyer une ligne par instance |
| Rien n'arrive, les écritures passent | WebSocket refusée ou hub bloqué | `curl -i` sur `/api/v1/realtime/ticket` (401, 429 ?) ; logs API ; nombre de connexions du compte (`WS_MAX_PER_ACCOUNT`) |
| Clients en boucle de reconnexion | 429 (plafond de connexions ou limites de débit), secret de ticket différent entre instances | en-tête `Retry-After` ; comparer `WS_TICKET_SECRET` des instances |
| Écran qui se recharge en entier | `resync` : curseur plus ancien que la rétention (`purged_through`) ou base restaurée | comportement prévu, voir « reprise » |
| Écritures lentes avec beaucoup de clients | fan-out du hub dans la boucle d'événements de l'API | `docs/03-tech/quality/charge-temps-reel.md` (écriture 5 ms -> 227 ms à 500 clients) |

## Diagnostics SQL (rôle `BYPASSRLS` ou propriétaire)

```
-- tête du journal par compte et plus grand seq purgé
SELECT account_id, seq, purged_through FROM account_change_seq ORDER BY account_id;
-- derniers changements d'un compte
SELECT seq, entity, entity_id, op, version, changed_at FROM change_log WHERE account_id = 1 ORDER BY seq DESC LIMIT 20;
-- le journal est-il alimenté ? (doit croître à chaque écriture)
SELECT count(*), max(changed_at) FROM change_log;
-- écouteurs actifs
SELECT pid, application_name, state, backend_start FROM pg_stat_activity WHERE query ILIKE 'LISTEN%';
```



Tester le NOTIFY à la main : `LISTEN wnext_changes;` dans une session `psql`, puis modifier une ligne depuis une autre : un message portant l'`account_id` doit apparaître au COMMIT.

Côté client, rejouer la chaîne : `npm run perf:realtime` (50 clients, base embarquée, doit passer) ; `npm run load:realtime` pour la charge.

## Reprise

1. L'écoute coupée se rétablit seule (attente croissante) ; à la reconnexion le hub relit tout : aucun message à rejouer. Si l'écoute ne revient pas : redémarrer l'API (SIGTERM, arrêt propre sous 10 s), les clients se reconnectent avec ticket neuf et attente croissante avec aléa (plancher `REALTIME_RETRY_AFTER_SECONDS` = 5 s).
2. Redémarrage en rolling : une instance à la fois ; les tickets sont valables 30 s et vérifiés par la signature (secret commun) : une autre instance accepte le ticket.
3. `resync` : rien à faire côté serveur, le client recharge `GET /schedule` puis se réabonne avec le nouveau `changeCursor`.
4. Journal trop purgé : vérifier que la rétention n'est pas inférieure à 7 jours conseillés (`purge_change_log`, minimum 72 h imposé par la fonction, BR-14).
5. Si tout échoue, le temps réel n'est qu'un confort de fraîcheur : l'écran continue sur ses dernières données, la persistance n'est pas touchée. Annoncer l'incident, redémarrer, puis consigner la cause.
