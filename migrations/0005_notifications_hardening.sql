-- ============================================================
-- 0005_notifications_hardening : durcissement des notifications in-app (relecture du lot K, 0004)
-- ============================================================
-- Constats corrigés :
--  1. Préférences lisibles par tout le compte (0004) : le trigger d'émission tournait avec les droits de l'auteur et devait lire le
--     choix du destinataire. Les fonctions de trigger passent en SECURITY DEFINER (propriétaire du schéma, search_path figé) ;
--     les préférences deviennent lisibles par soi seul (politique RESTRICTIVE own_preferences_read).
--  2. Fausse notification : app_user pouvait insérer une notification pour n'importe quel membre du compte (aucune politique
--     d'INSERT). Désormais pour lui-même seulement (recipient_insert) : seul le conflit d'édition de l'API écrit en app_user.
--  3. L'exception « la transaction qui écrit voit ses notifications » (tx_id, 0004) ne sert plus : le propriétaire contourne la RLS.
--     Elle est retirée : un auteur ne voit plus jamais les notifications d'autrui, même le temps de sa transaction.
--  4. Rétention : les notifications LUES partent 30 jours après leur lecture (au lieu de 90 jours après leur création) ; plafond de
--     90 jours inchangé pour toutes. purge_notifications n'est plus exécutable par app_user (job d'exploitation).
--
-- Exigence de déploiement (vérifiée ci-dessous) : la migration, donc le propriétaire des fonctions d'émission, est superuser ou
-- BYPASSRLS, comme pour 0002. Sinon la RLS FORCE s'appliquerait au propriétaire et masquerait les préférences du destinataire.
-- Les fonctions SECURITY DEFINER ne sont exécutables que par leur propriétaire (REVOKE ... FROM PUBLIC) : un trigger ne vérifie le
-- droit EXECUTE qu'à sa création, et app_user ne peut ni les appeler ni les brancher sur une table temporaire à lui.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '0005_notifications_hardening : à exécuter par un rôle superuser ou BYPASSRLS (propriétaire des fonctions d''émission)';
  END IF;
END $$;

-- ---------- ÉMISSION ----------
-- Corps inchangés (0004). Le compte reste celui de la ligne écrite, déjà contrôlé par la RLS de l'écriture métier.
ALTER FUNCTION notify_person(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, DATE) SET search_path = public, pg_temp;
ALTER FUNCTION notify_allocation() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION notify_timeoff() SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION notify_person(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION notify_allocation() FROM PUBLIC;
REVOKE ALL ON FUNCTION notify_timeoff() FROM PUBLIC;

-- ---------- RLS ----------
DROP POLICY recipient_read ON notifications;
DROP POLICY recipient_update ON notifications;
CREATE POLICY recipient_read ON notifications AS RESTRICTIVE FOR SELECT USING (user_id = app_user_id());
CREATE POLICY recipient_update ON notifications AS RESTRICTIVE FOR UPDATE
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY recipient_insert ON notifications AS RESTRICTIVE FOR INSERT WITH CHECK (user_id = app_user_id());

CREATE POLICY own_preferences_read ON notification_preferences AS RESTRICTIVE FOR SELECT USING (user_id = app_user_id());

-- ---------- RÉTENTION ----------
-- Lues : 30 jours après la lecture (p_retain_read) ; toutes : 90 jours après la création (p_retain). 1 jour <= lues <= toutes.
-- Rôle BYPASSRLS (job d'exploitation, comme purge_change_log) ; app_user n'y a pas accès. Retourne le nombre de lignes purgées.
DROP FUNCTION purge_notifications(INTERVAL);
CREATE FUNCTION purge_notifications(p_retain INTERVAL DEFAULT INTERVAL '90 days', p_retain_read INTERVAL DEFAULT INTERVAL '30 days')
RETURNS BIGINT LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_n bigint;
BEGIN
  IF p_retain IS NULL OR p_retain < INTERVAL '1 day' THEN
    RAISE EXCEPTION 'purge_notifications : rétention < 1 jour interdite' USING ERRCODE = '22023';
  END IF;
  IF p_retain_read IS NULL OR p_retain_read < INTERVAL '1 day' OR p_retain_read > p_retain THEN
    RAISE EXCEPTION 'purge_notifications : rétention des lues hors de [1 jour, rétention totale]' USING ERRCODE = '22023';
  END IF;
  DELETE FROM notifications
   WHERE created_at < clock_timestamp() - p_retain
      OR read_at < clock_timestamp() - p_retain_read;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION purge_notifications(INTERVAL, INTERVAL) FROM PUBLIC;
CREATE INDEX idx_notifications_read_age ON notifications (read_at) WHERE read_at IS NOT NULL;
