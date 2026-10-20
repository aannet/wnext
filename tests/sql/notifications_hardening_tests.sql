-- ============================================================
-- Tests SQL — durcissement des notifications in-app, migration 0005_notifications_hardening
-- Exécution (base migrée : schema.sql puis migrations/, rôle superuser/propriétaire) :
--   psql -v ON_ERROR_STOP=1 -f tests/sql/notifications_hardening_tests.sql <db>
-- Lancé par tests/migrations/notifications.test.ts (base vierge, migrations depuis zéro).
-- Tout est dans une transaction annulée à la fin. Première assertion en échec => exception 'FAIL: <libellé>'.
-- ============================================================
BEGIN;

CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO app_user;
CREATE TABLE t.results (label text);
CREATE TABLE t.ids (k text PRIMARY KEY, v bigint);
GRANT ALL ON t.results, t.ids TO app_user;

CREATE FUNCTION t.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  INSERT INTO t.results VALUES (label);
END $$;
CREATE FUNCTION t.eq(label text, got numeric, want numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL: % (obtenu %, attendu %)', label, got, want; END IF;
  INSERT INTO t.results VALUES (label);
END $$;
CREATE FUNCTION t.raises(label text, stmt text, want text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    st := SQLSTATE;
    IF want IS NOT NULL AND st <> want THEN
      RAISE EXCEPTION 'FAIL: % (SQLSTATE attendu %, obtenu % : %)', label, want, st, SQLERRM;
    END IF;
    INSERT INTO t.results VALUES (label);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % (aucune erreur levée)', label;
END $$;
CREATE FUNCTION t.id(k text) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT v FROM t.ids WHERE ids.k = $1 $$;
CREATE FUNCTION t.as(acc text, usr text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.account_id', COALESCE(t.id(acc)::text, ''), true);
  PERFORM set_config('app.user_id', COALESCE(t.id(usr)::text, ''), true);
END $$;
-- Notifications de la transaction courante pour un utilisateur (lecture du propriétaire, hors RLS).
CREATE FUNCTION t.n(usr text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COUNT(*) FROM notifications WHERE user_id = t.id(usr) AND tx_id = pg_current_xact_id()
$$;
CREATE TABLE t.seen (label text PRIMARY KEY, n bigint);
GRANT ALL ON t.seen TO app_user;

-- Compte A : ua (member, personne pa), ub (admin, personne pb). Compte B : ux (admin, personne px).
DO $$
DECLARE a bigint; b bigint; v bigint;
BEGIN
  INSERT INTO accounts(name) VALUES ('A') RETURNING id INTO a; INSERT INTO t.ids VALUES ('A', a);
  INSERT INTO accounts(name) VALUES ('B') RETURNING id INTO b; INSERT INTO t.ids VALUES ('B', b);
  INSERT INTO users(email) VALUES ('ua@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ua', v);
  INSERT INTO users(email) VALUES ('ub@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ub', v);
  INSERT INTO users(email) VALUES ('ux@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ux', v);
  INSERT INTO people(account_id, name) VALUES (a, 'pa') RETURNING id INTO v; INSERT INTO t.ids VALUES ('pa', v);
  INSERT INTO people(account_id, name) VALUES (a, 'pb') RETURNING id INTO v; INSERT INTO t.ids VALUES ('pb', v);
  INSERT INTO people(account_id, name) VALUES (b, 'px') RETURNING id INTO v; INSERT INTO t.ids VALUES ('px', v);
  INSERT INTO account_members(account_id, user_id, role, person_id) VALUES
    (a, t.id('ua'), 'member', t.id('pa')), (a, t.id('ub'), 'admin', t.id('pb')), (b, t.id('ux'), 'admin', t.id('px'));
  INSERT INTO projects(account_id, name) VALUES (a, 'prA') RETURNING id INTO v; INSERT INTO t.ids VALUES ('prA', v);
  INSERT INTO projects(account_id, name) VALUES (b, 'prB') RETURNING id INTO v; INSERT INTO t.ids VALUES ('prB', v);
  INSERT INTO timeoff_types(account_id, name) VALUES (a, 'CP') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ttA', v);
END $$;

-- ============================================================
-- H01 Inventaire : émission en SECURITY DEFINER bornée, fonctions internes non appelables par app_user
-- ============================================================
SELECT t.ok('H01a notify_allocation et notify_timeoff : SECURITY DEFINER, search_path figé',
  (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']) FROM pg_proc
    WHERE proname IN ('notify_allocation', 'notify_timeoff') HAVING COUNT(*) = 2));
SELECT t.ok('H01b propriétaire des fonctions d émission : superuser ou BYPASSRLS (sinon la RLS FORCE masquerait les préférences)',
  (SELECT bool_and(r.rolsuper OR r.rolbypassrls) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.proname IN ('notify_allocation', 'notify_timeoff', 'notify_person')));
SELECT t.ok('H01c app_user ne peut exécuter ni notify_person, ni les fonctions de trigger, ni la purge',
  NOT has_function_privilege('app_user', 'notify_person(bigint,bigint,text,text,bigint,text,date)', 'EXECUTE')
  AND NOT has_function_privilege('app_user', 'notify_allocation()', 'EXECUTE')
  AND NOT has_function_privilege('app_user', 'notify_timeoff()', 'EXECUTE')
  AND NOT has_function_privilege('app_user', 'purge_notifications(interval,interval)', 'EXECUTE'));

SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
SELECT t.raises('H01d app_user : appel direct de notify_person (fausse notification pour autrui, autre compte) refusé',
  format('SELECT notify_person(%s, %s, ''allocation_changed'', ''allocations'', 1, ''created'', ''2026-01-01'')', t.id('B'), t.id('px')), '42501');
CREATE TEMP TABLE h01 (id bigint, account_id bigint, person_id bigint, start_date date);
SELECT t.raises('H01e app_user : brancher notify_allocation (SECURITY DEFINER) sur une table temporaire à lui refusé',
  'CREATE TRIGGER h01_t AFTER INSERT ON h01 FOR EACH ROW EXECUTE FUNCTION notify_allocation()', '42501');
RESET ROLE;

-- ============================================================
-- H02 Préférences : lisibles par soi seul, et toujours respectées par l'émission
-- ============================================================
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ua');
INSERT INTO notification_preferences(account_id, user_id, type, enabled) VALUES (t.id('A'), t.id('ua'), 'allocation_changed', false);
INSERT INTO t.seen SELECT 'ua', COUNT(*) FROM notification_preferences;
SELECT t.as('A', 'ub');
INSERT INTO t.seen SELECT 'ub', COUNT(*) FROM notification_preferences;
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pa'), t.id('prA'), '2026-03-02', '2026-03-02', 1);
RESET ROLE;
SELECT t.eq('H02a ua lit sa préférence', (SELECT n FROM t.seen WHERE label = 'ua'), 1);
SELECT t.eq('H02b ub (admin du même compte) ne lit pas les préférences de ua', (SELECT n FROM t.seen WHERE label = 'ub'), 0);
SELECT t.eq('H02c le désabonnement de ua est respecté alors que l auteur ub ne peut pas le lire', t.n('ua'), 0);
DELETE FROM notification_preferences;

-- ============================================================
-- H03 Émission inchangée sous SECURITY DEFINER : destinataire, auteur, regroupement, compte
-- ============================================================
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
UPDATE allocations SET hours_per_day = 2 WHERE person_id = t.id('pa');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pa'), t.id('prA'), '2026-03-03', '2026-03-03', 1);
INSERT INTO timeoffs(account_id, person_id, timeoff_type_id, start_date, end_date, approval_status)
  VALUES (t.id('A'), t.id('pa'), t.id('ttA'), '2026-05-04', '2026-05-04', 'approved');
INSERT INTO t.seen SELECT 'ub_tx', COUNT(*) FROM notifications;
RESET ROLE;
SELECT t.ok('H03a ua : une allocation_changed regroupée (updated=1, created=1), auteur ub, compte A',
  (SELECT payload = '{"created": 1, "updated": 1, "startDate": "2026-03-02"}'::jsonb AND actor_user_id = t.id('ub') AND account_id = t.id('A')
     FROM notifications WHERE user_id = t.id('ua') AND type = 'allocation_changed' AND tx_id = pg_current_xact_id()));
SELECT t.eq('H03b ua : une timeoff_decided', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ua') AND type = 'timeoff_decided'), 1);
SELECT t.eq('H03c l auteur ne voit plus, même dans sa transaction, les notifications d autrui qu il produit', (SELECT n FROM t.seen WHERE label = 'ub_tx'), 0);
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ua');
UPDATE allocations SET hours_per_day = 3 WHERE person_id = t.id('pa');
RESET ROLE;
SELECT t.eq('H03d auteur = destinataire : toujours rien de plus (regroupée, compteur inchangé)',
  (SELECT (payload ->> 'updated')::int FROM notifications WHERE user_id = t.id('ua') AND type = 'allocation_changed' AND tx_id = pg_current_xact_id()), 1);

-- ============================================================
-- H04 Insertion directe : app_user n'écrit une notification que pour lui-même (conflit d'édition de l'API)
-- ============================================================
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
SELECT t.raises('H04a fausse notification pour ua (même compte) : refusée',
  format('INSERT INTO notifications(account_id, user_id, type, entity, entity_id) VALUES (%s, %s, ''edit_conflict'', ''people'', 1)', t.id('A'), t.id('ua')), '42501');
INSERT INTO notifications(account_id, user_id, type, entity, entity_id) VALUES (t.id('A'), t.id('ub'), 'edit_conflict', 'people', 1);
RESET ROLE;
SELECT t.eq('H04b sa propre notification (edit_conflict) : acceptée', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ub') AND type = 'edit_conflict'), 1);

-- H05 Écriture système (sans contexte) et cascade : toujours notifiées, sans erreur
SELECT t.as('', '');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('B'), t.id('px'), t.id('prB'), '2026-03-02', '2026-03-02', 1);
SELECT t.eq('H05a écriture système : ux notifié, sans auteur', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ux') AND actor_user_id IS NULL), 1);
DELETE FROM accounts WHERE id = t.id('B');
SELECT t.eq('H05b suppression du compte (cascade des allocations) : aucune erreur, plus aucune notification du compte',
  (SELECT COUNT(*) FROM notifications WHERE account_id = t.id('B')), 0);

-- ============================================================
-- H06 Rétention : lues purgées après 30 jours (date de lecture), toutes après 90 jours
-- ============================================================
DELETE FROM notifications;
INSERT INTO notifications(account_id, user_id, type, entity, entity_id, created_at, read_at, tx_id) VALUES
  (t.id('A'), t.id('ua'), 'edit_conflict', 'people', 1, now() - interval '40 days', now() - interval '31 days', '11'::xid8), -- lue il y a 31 j : purgée
  (t.id('A'), t.id('ua'), 'edit_conflict', 'people', 2, now() - interval '40 days', now() - interval '29 days', '12'::xid8), -- lue il y a 29 j : gardée
  (t.id('A'), t.id('ua'), 'edit_conflict', 'people', 3, now() - interval '40 days', NULL, '13'::xid8),                       -- non lue, 40 j : gardée
  (t.id('A'), t.id('ua'), 'edit_conflict', 'people', 4, now() - interval '91 days', NULL, '14'::xid8);                       -- non lue, 91 j : purgée
SELECT t.eq('H06a purge par défaut : la lue de plus de 30 jours et la plus de 90 jours partent', purge_notifications(), 2);
SELECT t.ok('H06b restent la lue récente et la non lue de 40 jours',
  (SELECT array_agg(entity_id ORDER BY entity_id) = ARRAY[2, 3]::bigint[] FROM notifications));
SELECT t.eq('H06c rétention des lues paramétrable', purge_notifications(interval '90 days', interval '7 days'), 1);
SELECT t.raises('H06d rétention des lues < 1 jour : refusée', 'SELECT purge_notifications(interval ''90 days'', interval ''1 hour'')', '22023');
SELECT t.raises('H06e rétention des lues > rétention totale : refusée', 'SELECT purge_notifications(interval ''30 days'', interval ''60 days'')', '22023');
SELECT t.raises('H06f rétention totale < 1 jour : toujours refusée', 'SELECT purge_notifications(interval ''1 hour'')', '22023');
SELECT t.ok('H06g index de purge des lues', EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'notifications' AND indexname = 'idx_notifications_read_age'));

SELECT COUNT(*) AS tests_passed FROM t.results;
ROLLBACK;
