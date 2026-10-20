-- ============================================================
-- Tests SQL — notifications in-app (FR-10, US-7.3, BR-36), migration 0004_notifications
-- Exécution (base migrée : schema.sql puis migrations/, rôle superuser/propriétaire) :
--   psql -v ON_ERROR_STOP=1 -f tests/sql/notifications_tests.sql <db>
-- Lancé par tests/migrations/notifications.test.ts (base vierge, migrations depuis zéro).
-- Tout est dans une transaction annulée à la fin. Première assertion en échec => exception 'FAIL: <libellé>'.
-- Le fichier entier est UNE transaction : le regroupement (une notification par destinataire, type et transaction) y regrouperait
-- tout. t.commit() simule la fin d'une transaction en donnant à chaque notification déjà écrite un tx_id passé et distinct ; les
-- vraies transactions successives sont couvertes par tests/migrations/notifications.test.ts.
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

CREATE FUNCTION t.rowcount(stmt text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;

CREATE FUNCTION t.id(k text) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT v FROM t.ids WHERE ids.k = $1 $$;
-- Contexte de session de l'API : compte et utilisateur courants.
CREATE FUNCTION t.as(acc text, usr text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.account_id', COALESCE(t.id(acc)::text, ''), true);
  PERFORM set_config('app.user_id', COALESCE(t.id(usr)::text, ''), true);
END $$;
-- « Fin de transaction » simulée (voir l'en-tête) : exécutée par le propriétaire, hors RLS.
CREATE FUNCTION t.commit() RETURNS void LANGUAGE sql AS $$
  UPDATE notifications SET tx_id = id::text::xid8 WHERE tx_id = pg_current_xact_id()
$$;
-- Notifications d'un utilisateur (lecture du propriétaire, hors RLS).
CREATE FUNCTION t.n(usr text, typ text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COUNT(*) FROM notifications WHERE user_id = t.id(usr) AND type = typ
$$;
CREATE FUNCTION t.last(usr text) RETURNS notifications LANGUAGE sql STABLE AS $$
  SELECT * FROM notifications WHERE user_id = t.id(usr) ORDER BY id DESC LIMIT 1
$$;

-- ---------- Jeu de données ----------
-- Compte A : ua (member, personne pa), ub (admin, personne pb), uc (member, sans personne), pz (personne sans utilisateur).
-- Compte B : ux (admin, personne px).
DO $$
DECLARE a bigint; b bigint; v bigint;
BEGIN
  INSERT INTO accounts(name) VALUES ('A') RETURNING id INTO a; INSERT INTO t.ids VALUES ('A', a);
  INSERT INTO accounts(name) VALUES ('B') RETURNING id INTO b; INSERT INTO t.ids VALUES ('B', b);
  INSERT INTO users(email) VALUES ('ua@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ua', v);
  INSERT INTO users(email) VALUES ('ub@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ub', v);
  INSERT INTO users(email) VALUES ('uc@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('uc', v);
  INSERT INTO users(email) VALUES ('ux@x.test') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ux', v);
  INSERT INTO people(account_id, name) VALUES (a, 'pa') RETURNING id INTO v; INSERT INTO t.ids VALUES ('pa', v);
  INSERT INTO people(account_id, name) VALUES (a, 'pb') RETURNING id INTO v; INSERT INTO t.ids VALUES ('pb', v);
  INSERT INTO people(account_id, name) VALUES (a, 'pz') RETURNING id INTO v; INSERT INTO t.ids VALUES ('pz', v);
  INSERT INTO people(account_id, name) VALUES (b, 'px') RETURNING id INTO v; INSERT INTO t.ids VALUES ('px', v);
  INSERT INTO account_members(account_id, user_id, role, person_id) VALUES
    (a, t.id('ua'), 'member', t.id('pa')), (a, t.id('ub'), 'admin', t.id('pb')), (a, t.id('uc'), 'member', NULL),
    (b, t.id('ux'), 'admin', t.id('px'));
  INSERT INTO projects(account_id, name) VALUES (a, 'prA') RETURNING id INTO v; INSERT INTO t.ids VALUES ('prA', v);
  INSERT INTO projects(account_id, name) VALUES (a, 'prA2') RETURNING id INTO v; INSERT INTO t.ids VALUES ('prA2', v);
  INSERT INTO projects(account_id, name) VALUES (b, 'prB') RETURNING id INTO v; INSERT INTO t.ids VALUES ('prB', v);
  INSERT INTO timeoff_types(account_id, name) VALUES (a, 'CP') RETURNING id INTO v; INSERT INTO t.ids VALUES ('ttA', v);
END $$;

-- ============================================================
-- N01 Inventaire : tables cloisonnées, RLS forcée, politiques restrictives
-- ============================================================
SELECT t.ok('N01a RLS activée ET forcée sur notifications et notification_preferences',
  (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE relname IN ('notifications', 'notification_preferences')
   HAVING COUNT(*) = 2));
SELECT t.ok('N01b politiques : tenant_isolation + restrictions au destinataire (liste fermée)',
  (SELECT array_agg(tablename || '.' || policyname || ':' || cmd || ':' || permissive ORDER BY tablename, policyname) FROM pg_policies
    WHERE tablename IN ('notifications', 'notification_preferences'))
  = ARRAY['notification_preferences.own_preferences_delete:DELETE:RESTRICTIVE', 'notification_preferences.own_preferences_insert:INSERT:RESTRICTIVE',
          'notification_preferences.own_preferences_update:UPDATE:RESTRICTIVE', 'notification_preferences.tenant_isolation:ALL:PERMISSIVE',
          'notifications.recipient_delete:DELETE:RESTRICTIVE', 'notifications.recipient_read:SELECT:RESTRICTIVE',
          'notifications.recipient_update:UPDATE:RESTRICTIVE', 'notifications.tenant_isolation:ALL:PERMISSIVE']);
SELECT t.ok('N01c index de la boîte de réception (user_id, read_at, created_at)',
  EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'notifications' AND indexname = 'idx_notifications_inbox'
            AND indexdef LIKE '%(user_id, read_at, created_at DESC)%'));
SELECT t.ok('N01d aucune fonction SECURITY DEFINER ajoutée (l émission tourne avec les droits de l auteur)',
  NOT EXISTS (SELECT 1 FROM pg_proc WHERE prosecdef AND proname IN ('notify_person', 'notify_allocation', 'notify_timeoff', 'notification_wake', 'purge_notifications')));
SELECT t.ok('N01e les notifications ne sont ni dans change_log (diffusé au compte) ni dans delete_log',
  NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
               WHERE c.relname IN ('notifications', 'notification_preferences') AND tg.tgname IN ('trg_92_change_log', 'trg_91_delete_log')));

-- ============================================================
-- N02 Allocations : création, modification, suppression ; auteur jamais notifié
-- ============================================================
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pa'), t.id('prA'), '2026-03-04', '2026-03-05', 4);
RESET ROLE;
SELECT t.eq('N02a création par ub d une allocation de pa : une notification pour ua', t.n('ua', 'allocation_changed'), 1);
SELECT t.ok('N02b forme : entité, auteur, compteur created=1, startDate, non lue',
  (SELECT entity = 'allocations' AND entity_id = (SELECT id FROM allocations WHERE person_id = t.id('pa'))
          AND actor_user_id = t.id('ub') AND payload = '{"created": 1, "startDate": "2026-03-04"}'::jsonb AND read_at IS NULL
          AND account_id = t.id('A') FROM t.last('ua')));
SELECT t.ok('N02c payload minimal : ni heures, ni taux, ni projet, ni note',
  NOT EXISTS (SELECT 1 FROM notifications, jsonb_object_keys(payload) k WHERE k NOT IN ('created', 'updated', 'deleted', 'approved', 'declined', 'startDate', 'version')));

SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pb'), t.id('prA'), '2026-03-04', '2026-03-04', 2);
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pz'), t.id('prA'), '2026-03-04', '2026-03-04', 2);
RESET ROLE;
SELECT t.eq('N02d auteur = destinataire (ub sur sa propre personne pb) : aucune notification', t.n('ub', 'allocation_changed'), 0);
SELECT t.eq('N02e personne sans utilisateur (pz) : aucune notification, ni pour uc', (SELECT COUNT(*) FROM notifications WHERE user_id <> t.id('ua')), 0);

-- N03 Regroupement dans la transaction
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pa'), t.id('prA2'), '2026-03-02', '2026-03-02', 1), (t.id('A'), t.id('pa'), t.id('prA2'), '2026-03-09', '2026-03-09', 1);
UPDATE allocations SET hours_per_day = 3 WHERE person_id = t.id('pa') AND project_id = t.id('prA');
RESET ROLE;
SELECT t.eq('N03a même transaction : toujours UNE notification pour ua', t.n('ua', 'allocation_changed'), 1);
SELECT t.ok('N03b compteurs cumulés : created=3, updated=1, startDate = plus petit jour',
  (SELECT payload = '{"created": 3, "updated": 1, "startDate": "2026-03-02"}'::jsonb FROM t.last('ua')));

SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
DELETE FROM allocations WHERE person_id = t.id('pa') AND project_id = t.id('prA2') AND start_date = '2026-03-09';
RESET ROLE;
SELECT t.eq('N03c transaction suivante : une nouvelle notification', t.n('ua', 'allocation_changed'), 2);
SELECT t.ok('N03d suppression : deleted=1', (SELECT payload = '{"deleted": 1, "startDate": "2026-03-09"}'::jsonb FROM t.last('ua')));

-- N04 Réaffectation : suppression pour l'ancienne personne, création pour la nouvelle
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'uc');
UPDATE allocations SET person_id = t.id('pb') WHERE person_id = t.id('pa') AND project_id = t.id('prA2');
RESET ROLE;
SELECT t.ok('N04a ancienne personne (ua) : deleted=1', (SELECT payload ->> 'deleted' = '1' AND payload ->> 'created' IS NULL FROM t.last('ua')));
SELECT t.ok('N04b nouvelle personne (ub) : created=1, auteur uc', (SELECT payload ->> 'created' = '1' AND actor_user_id = t.id('uc') FROM t.last('ub')));

-- N05 Écriture sans utilisateur (job, propriétaire) : notifiée, auteur NULL
SELECT t.commit();
SELECT t.as('', '');
UPDATE allocations SET notes = 'job' WHERE person_id = t.id('pa') AND project_id = t.id('prA');
SELECT t.ok('N05 écriture système : notification sans auteur', (SELECT actor_user_id IS NULL AND payload ->> 'updated' = '1' FROM t.last('ua')));

-- N06 Cascade : supprimer le projet supprime les allocations et les notifie
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
DELETE FROM projects WHERE id = t.id('prA');
RESET ROLE;
SELECT t.ok('N06 suppression du projet : l allocation de pa supprimée en cascade est notifiée', (SELECT payload ->> 'deleted' = '1' FROM t.last('ua')));

-- ============================================================
-- N07 Préférences : désabonnement par type
-- ============================================================
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ua');
INSERT INTO notification_preferences(account_id, user_id, type, enabled) VALUES (t.id('A'), t.id('ua'), 'allocation_changed', false);
SELECT t.as('A', 'ub');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pa'), t.id('prA2'), '2026-04-01', '2026-04-01', 1);
RESET ROLE;
SELECT t.eq('N07a type désabonné : aucune ligne', (SELECT COUNT(*) FROM notifications WHERE tx_id = pg_current_xact_id()), 0);
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ua');
UPDATE notification_preferences SET enabled = true WHERE user_id = t.id('ua') AND type = 'allocation_changed';
SELECT t.as('A', 'ub');
UPDATE allocations SET hours_per_day = 2 WHERE person_id = t.id('pa') AND start_date = '2026-04-01';
RESET ROLE;
SELECT t.eq('N07b réabonné : notifié de nouveau', (SELECT COUNT(*) FROM notifications WHERE tx_id = pg_current_xact_id() AND user_id = t.id('ua')), 1);
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ua');
INSERT INTO notification_preferences(account_id, user_id, type, enabled) VALUES (t.id('A'), t.id('ua'), 'timeoff_decided', false);
SELECT t.as('A', 'ub');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('pa'), t.id('prA2'), '2026-04-02', '2026-04-02', 1);
RESET ROLE;
SELECT t.eq('N07c le désabonnement est par type : les allocations restent notifiées', (SELECT COUNT(*) FROM notifications WHERE tx_id = pg_current_xact_id()), 1);
DELETE FROM notification_preferences WHERE user_id = t.id('ua');

-- ============================================================
-- N08 Congés : décision approuvé / refusé
-- ============================================================
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
INSERT INTO timeoffs(account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (t.id('A'), t.id('pa'), t.id('ttA'), '2026-05-04', '2026-05-05');
RESET ROLE;
SELECT t.eq('N08a congé posé en attente : aucune notification', t.n('ua', 'timeoff_decided'), 0);
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
UPDATE timeoffs SET approval_status = 'approved' WHERE person_id = t.id('pa');
RESET ROLE;
SELECT t.ok('N08b passage à approuvé : timeoff_decided approved=1, entité timeoffs, auteur ub',
  (SELECT type = 'timeoff_decided' AND entity = 'timeoffs' AND actor_user_id = t.id('ub')
          AND payload = '{"approved": 1, "startDate": "2026-05-04"}'::jsonb FROM t.last('ua')));
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
UPDATE timeoffs SET approval_status = 'approved', notes = 'rien' WHERE person_id = t.id('pa');
RESET ROLE;
SELECT t.eq('N08c statut inchangé (l API réécrit toujours la colonne) : aucune notification', t.n('ua', 'timeoff_decided'), 1);
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
UPDATE timeoffs SET approval_status = 'declined' WHERE person_id = t.id('pa');
UPDATE timeoffs SET approval_status = 'pending' WHERE person_id = t.id('pa');
INSERT INTO timeoffs(account_id, person_id, timeoff_type_id, start_date, end_date, approval_status)
  VALUES (t.id('A'), t.id('pa'), t.id('ttA'), '2026-06-01', '2026-06-01', 'approved');
RESET ROLE;
SELECT t.ok('N08d refusé puis congé posé directement approuvé, même transaction : declined=1, approved=1 ; le retour à pending ne compte pas',
  (SELECT payload = '{"approved": 1, "declined": 1, "startDate": "2026-05-04"}'::jsonb FROM t.last('ua')));
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ua');
UPDATE timeoffs SET approval_status = 'approved' WHERE person_id = t.id('pa') AND start_date = '2026-05-04';
RESET ROLE;
SELECT t.eq('N08e la personne décide de son propre congé : non notifiée', (SELECT COUNT(*) FROM notifications WHERE tx_id = pg_current_xact_id()), 0);

-- ============================================================
-- N09 RLS : le destinataire seul (lecture, modification, suppression), cloisonnement par compte
-- ============================================================
SELECT t.commit();
CREATE TEMP TABLE n09 (who text, visible bigint, upd bigint, del bigint);
GRANT ALL ON n09 TO app_user;
SET LOCAL ROLE app_user;
DO $$
DECLARE w text[]; v bigint; u bigint; d bigint;
BEGIN
  FOREACH w SLICE 1 IN ARRAY ARRAY[['A','ua'],['A','ub'],['A','uc'],['B','ux'],['A',''],['','ua']] LOOP
    PERFORM t.as(w[1], w[2]);
    SELECT COUNT(*) INTO v FROM notifications WHERE user_id = t.id('ua');
    UPDATE notifications SET read_at = now() WHERE user_id = t.id('ua') AND read_at IS NULL;
    GET DIAGNOSTICS u = ROW_COUNT;
    BEGIN
      DELETE FROM notifications WHERE user_id = t.id('ua');
      GET DIAGNOSTICS d = ROW_COUNT;
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'n09_rollback';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    INSERT INTO n09 VALUES (w[1] || ':' || w[2], v, u, d);
  END LOOP;
END $$;
RESET ROLE;
SELECT t.ok('N09a ua voit, marque lues et peut supprimer ses notifications',
  (SELECT visible > 0 AND upd = visible AND del = visible FROM n09 WHERE who = 'A:ua'));
SELECT t.eq('N09b ub (admin du compte), uc, ux (autre compte), sans utilisateur, sans compte : rien de visible, modifiable ni supprimable',
  (SELECT SUM(visible + upd + del) FROM n09 WHERE who <> 'A:ua'), 0);
SELECT t.ok('N09c les marquages lus de ua ont bien porté', (SELECT bool_and(read_at IS NOT NULL) FROM notifications WHERE user_id = t.id('ua')));

SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
SELECT t.raises('N09d insérer une notification dans un autre compte : refusé (tenant_isolation)',
  format('INSERT INTO notifications(account_id, user_id, type, entity, entity_id) VALUES (%s, %s, ''edit_conflict'', ''people'', 1)', t.id('B'), t.id('ux')), '42501');
SELECT t.raises('N09e écrire les préférences d un autre : refusé',
  format('INSERT INTO notification_preferences(account_id, user_id, type, enabled) VALUES (%s, %s, ''edit_conflict'', false)', t.id('A'), t.id('ua')), '42501');
SELECT t.as('A', 'ua');
INSERT INTO notification_preferences(account_id, user_id, type, enabled) VALUES (t.id('A'), t.id('ua'), 'edit_conflict', false);
SELECT t.as('A', 'ub');
SELECT t.eq('N09f modifier ou supprimer les préférences d un autre : aucune ligne atteinte',
  t.rowcount('UPDATE notification_preferences SET enabled = true') + t.rowcount('DELETE FROM notification_preferences'), 0);
SELECT t.as('B', 'ux');
SELECT t.eq('N09g préférences : invisibles depuis un autre compte', (SELECT COUNT(*) FROM notification_preferences), 0);
RESET ROLE;
DELETE FROM notification_preferences;

-- N10 Exception de regroupement : la transaction qui écrit voit ce qu'elle vient d'écrire, rien d'autre
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
UPDATE allocations SET hours_per_day = 5 WHERE person_id = t.id('pa') AND start_date = '2026-04-02';
SELECT t.eq('N10a l auteur voit la seule notification produite par sa transaction', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ua')), 1);
RESET ROLE;
SELECT t.commit();
SET LOCAL ROLE app_user;
SELECT t.as('A', 'ub');
SELECT t.eq('N10c l auteur ne voit plus la notification une fois sa transaction passée', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ua')), 0);
RESET ROLE;

-- ============================================================
-- N11 Intégrité : destinataire membre du compte, types et payload bornés
-- ============================================================
SELECT t.raises('N11a destinataire non membre du compte : refusé (clé étrangère)',
  format('INSERT INTO notifications(account_id, user_id, type, entity, entity_id) VALUES (%s, %s, ''edit_conflict'', ''people'', 1)', t.id('A'), t.id('ux')), '23503');
SELECT t.raises('N11b type inconnu : refusé',
  format('INSERT INTO notifications(account_id, user_id, type, entity, entity_id) VALUES (%s, %s, ''mail'', ''people'', 1)', t.id('A'), t.id('ua')), '23514');
SELECT t.raises('N11c payload trop gros : refusé',
  format('INSERT INTO notifications(account_id, user_id, type, entity, entity_id, payload) VALUES (%s, %s, ''edit_conflict'', ''people'', 1, jsonb_build_object(''x'', repeat(''y'', 2000)))', t.id('A'), t.id('ua')), '23514');
SELECT t.raises('N11d payload non objet : refusé',
  format('INSERT INTO notifications(account_id, user_id, type, entity, entity_id, payload) VALUES (%s, %s, ''edit_conflict'', ''people'', 1, ''[1]'')', t.id('A'), t.id('ua')), '23514');

-- N12 Cascades : quitter le compte efface notifications et préférences ; supprimer un compte ne bute pas sur l'émission
INSERT INTO notification_preferences(account_id, user_id, type, enabled) VALUES (t.id('A'), t.id('ua'), 'edit_conflict', false);
DELETE FROM account_members WHERE account_id = t.id('A') AND user_id = t.id('ua');
SELECT t.eq('N12a membre retiré : ses notifications et préférences partent en cascade',
  (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ua')) + (SELECT COUNT(*) FROM notification_preferences WHERE user_id = t.id('ua')), 0);
UPDATE allocations SET hours_per_day = 6 WHERE person_id = t.id('pa');
SELECT t.eq('N12b personne qui n est plus liée : plus notifiée', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ua')), 0);
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('B'), t.id('px'), t.id('prB'), '2026-03-02', '2026-03-02', 1);
SELECT t.eq('N12c compte B : ux notifié (écriture système)', (SELECT COUNT(*) FROM notifications WHERE user_id = t.id('ux')), 1);
DELETE FROM accounts WHERE id = t.id('B');
SELECT t.eq('N12d suppression du compte B : aucune erreur, plus aucune notification du compte', (SELECT COUNT(*) FROM notifications WHERE account_id = t.id('B')), 0);

-- ============================================================
-- N13 Rétention bornée
-- ============================================================
INSERT INTO account_members(account_id, user_id, role, person_id) VALUES (t.id('A'), t.id('ua'), 'member', t.id('pa'));
INSERT INTO notifications(account_id, user_id, type, entity, entity_id, created_at) VALUES
  (t.id('A'), t.id('ua'), 'edit_conflict', 'people', 1, now() - interval '91 days');
INSERT INTO notifications(account_id, user_id, type, entity, entity_id, created_at, tx_id) VALUES
  (t.id('A'), t.id('ua'), 'edit_conflict', 'people', 2, now() - interval '89 days', '7'::xid8);
SELECT t.eq('N13a purge par défaut (90 jours) : seule la notification de plus de 90 jours part', purge_notifications(), 1);
SELECT t.ok('N13b la plus récente reste', EXISTS (SELECT 1 FROM notifications WHERE entity_id = 2 AND user_id = t.id('ua')));
SELECT t.raises('N13c rétention < 1 jour : refusée', 'SELECT purge_notifications(interval ''1 hour'')', '22023');

SELECT COUNT(*) AS tests_passed FROM t.results;
ROLLBACK;
