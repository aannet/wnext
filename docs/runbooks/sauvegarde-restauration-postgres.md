# Runbook : sauvegarde et restauration PostgreSQL

Statut : procédure cible, à vérifier sur l'environnement réel. Les outils clients (`pg_dump`, `pg_restore`, `psql`) ne sont pas installés dans la VM de développement (le Postgres embarqué ne les fournit pas) : les commandes ci-dessous n'ont pas été rejouées ici. Premier exercice à faire : sauvegarde puis restauration de `dev:stack` (port 54329) avec un client PG >= 15 installé.

Les données vitales : toute la base `wnext` (multi-tenant, `account_id`). Schéma de référence : `schema.sql` + `migrations/` ; registre : `wnext_migrations.applied`.

## 1. Sauvegarde logique (pg_dump)

```
pg_dump --format=custom --no-owner --file=wnext-$(date +%F).dump "postgres://postgres:***@HOTE:5432/wnext"
pg_restore --list wnext-AAAA-MM-JJ.dump | head      # contrôle de lisibilité
```

- Connexion en rôle propriétaire (ou `BYPASSRLS`) : sous RLS, `app_user` ne verrait aucune ligne et la sauvegarde serait vide.
- Cadence cible : quotidienne, conservation 30 jours, copie hors site, chiffrement au repos. Tester une restauration chaque mois.

## 2. Restauration (pg_restore)

Sur une base neuve (jamais par-dessus la production sans arrêt de l'API) :

```
createdb -h HOTE -U postgres wnext_restore
psql -h HOTE -U postgres -d wnext_restore -c "CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS citext;"
pg_restore --no-owner --exit-on-error -h HOTE -U postgres -d wnext_restore wnext-AAAA-MM-JJ.dump
```

Puis, vérifier :

```
DATABASE_URL=postgres://postgres:***@HOTE:5432/wnext_restore npm run db:migrate -- --status   # migrations toutes appliquées, aucune dérive
psql -d wnext_restore -c "SELECT count(*) FROM accounts" -c "SELECT account_id, max(seq) FROM change_log GROUP BY 1"
```

Rôles : recréer `app_user` (non propriétaire, ni BYPASSRLS) et ses droits avant de pointer l'API dessus ; `--no-owner` évite d'importer les propriétaires de la source.

Effet sur le temps réel : les `seq` de `change_log` reviennent à ceux de la sauvegarde. Un client dont le curseur est postérieur reçoit une erreur de curseur invalide ou un `resync` et recharge la fenêtre (comportement prévu, `docs/runbooks/incident-temps-reel.md`) ; aucune action manuelle.

## 3. PITR (cible, non mis en place)

Objectif : RPO de quelques minutes. Principe : `archive_mode=on` + `archive_command` vers un stockage durable, sauvegarde de base périodique (`pg_basebackup`), restauration à un instant par `recovery_target_time` + `recovery.signal`. Sur une offre Postgres gérée, activer l'option native et noter la fenêtre de rétention. À décider avec l'hébergement (non choisi) ; cible P5 : RPO <= 15 min, RTO <= 1 h.

## 4. Points de vigilance

- La purge de `change_log` et `delete_log` (`purge_change_log`, rétention >= 72 h, BR-14) s'exécute en rôle `BYPASSRLS` : ne pas la lancer pendant une restauration.
- Restaurer ne rejoue pas les NOTIFY : après reprise de l'API, le hub relit tout à la connexion d'écoute.
