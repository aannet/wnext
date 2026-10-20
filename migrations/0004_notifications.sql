-- ============================================================
-- 0004_notifications : notifications in-app (FR-10, US-7.3 ; BR-36 / US-3.5 pour le conflit d'édition)
-- ============================================================
-- Socle minimal (décision 2026-10-20) : trois types, lu/non lu, désabonnement par type ; ni e-mail ni digest (T2).
--   allocation_changed : une allocation de MA personne (account_members.person_id) a été créée, modifiée ou supprimée par un autre ;
--   timeoff_decided    : un de MES congés est passé à approuvé ou refusé (ou a été posé directement dans cet état) par un autre ;
--   edit_conflict      : ma modification a perdu face à une version plus récente (409 VERSION_CONFLICT) ; écrit par l'API.
-- Les deux premiers sont émis par trigger : toutes les écritures (API, import CSV, cascades) sont couvertes, sans code applicatif.
--
-- Destinataire seul : une notification n'est lisible, modifiable ou supprimable que par son destinataire (politiques RESTRICTIVE,
-- en ET avec tenant_isolation). Exception bornée : la transaction qui ÉCRIT une notification la voit le temps de cette transaction
-- (tx_id = sa propre transaction), pour pouvoir la regrouper ; elle n'y lit que ce qu'elle vient de produire elle-même.
-- L'insertion pour un autre membre du compte est permise (c'est l'objet même) ; le compte reste imposé par tenant_isolation.
--
-- Pas de rafale : UNE notification par (destinataire, type, transaction). Les écritures suivantes de la même transaction
-- incrémentent des compteurs du payload (created/updated/deleted, approved/declined) : un import de 300 allocations donne
-- « 300 allocations créées » et non 300 lignes. entity_id est celui de la première entité touchée ; startDate le plus petit jour.
--
-- Payload minimal : compteurs et dates, jamais de taux, de coût, de nom de projet ni de note ; l'auteur est actor_user_id.
-- Temps réel : pg_notify('wnext_notifications', '<account_id>:<user_id>') à l'insertion et au marquage lu. Ce canal est distinct de
-- change_log, diffusé à tout le compte : une notification n'y figure jamais.
-- Rétention : purge_notifications() (90 jours par défaut), job d'exploitation BYPASSRLS comme purge_change_log.

CREATE TABLE notifications (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL,                                   -- destinataire
  type          TEXT   NOT NULL CHECK (type IN ('allocation_changed','timeoff_decided','edit_conflict')),
  entity        TEXT   NOT NULL CHECK (entity ~ '^[a-z_]{1,40}$'), -- table de l'entité (allocations, timeoffs, people...)
  entity_id     BIGINT NOT NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,     -- auteur du changement (ou de la version gagnante) ; NULL = système
  payload       JSONB  NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 1024),
  tx_id         xid8   NOT NULL DEFAULT pg_current_xact_id(),       -- clé de regroupement (une ligne par transaction)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at       TIMESTAMPTZ,
  -- Le destinataire est membre du compte ; quitter le compte efface ses notifications.
  FOREIGN KEY (account_id, user_id) REFERENCES account_members(account_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_notifications_group ON notifications (account_id, user_id, type, tx_id);
CREATE INDEX idx_notifications_inbox ON notifications (user_id, read_at, created_at DESC);
CREATE INDEX idx_notifications_age ON notifications (created_at);

-- Désabonnement par type. Absence de ligne = abonné (défaut). Lisible dans le compte (le trigger d'émission, qui tourne avec les
-- droits de l'auteur, doit connaître le choix du destinataire ; l'API ne sert que les siennes à chacun) ; écrite par soi seul.
CREATE TABLE notification_preferences (
  account_id  BIGINT NOT NULL,
  user_id     BIGINT NOT NULL,
  type        TEXT   NOT NULL CHECK (type IN ('allocation_changed','timeoff_decided','edit_conflict')),
  enabled     BOOLEAN NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id, type),
  FOREIGN KEY (account_id, user_id) REFERENCES account_members(account_id, user_id) ON DELETE CASCADE
);

-- ---------- RLS ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','notification_preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id())$p$, t);
  END LOOP;
END $$;

CREATE POLICY recipient_read ON notifications AS RESTRICTIVE FOR SELECT
  USING (user_id = app_user_id() OR tx_id = pg_current_xact_id_if_assigned());
CREATE POLICY recipient_update ON notifications AS RESTRICTIVE FOR UPDATE
  USING (user_id = app_user_id() OR tx_id = pg_current_xact_id_if_assigned())
  WITH CHECK (user_id = app_user_id() OR tx_id = pg_current_xact_id_if_assigned());
CREATE POLICY recipient_delete ON notifications AS RESTRICTIVE FOR DELETE
  USING (user_id = app_user_id());

CREATE POLICY own_preferences_insert ON notification_preferences AS RESTRICTIVE FOR INSERT
  WITH CHECK (user_id = app_user_id());
CREATE POLICY own_preferences_update ON notification_preferences AS RESTRICTIVE FOR UPDATE
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own_preferences_delete ON notification_preferences AS RESTRICTIVE FOR DELETE
  USING (user_id = app_user_id());

-- ---------- ÉMISSION ----------
-- Ajoute (ou regroupe dans la notification de la transaction) un événement pour l'utilisateur lié à la personne p_person_id.
-- Rien si : personne non liée à un utilisateur, auteur = destinataire, type désabonné, ou compte en cours de suppression
-- (la cascade de DELETE accounts ne doit pas buter sur la clé étrangère, comme log_team_change).
CREATE FUNCTION notify_person(p_account_id BIGINT, p_person_id BIGINT, p_type TEXT, p_entity TEXT, p_entity_id BIGINT,
                              p_counter TEXT, p_day DATE) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_user  bigint;
  v_actor bigint := app_user_id();
BEGIN
  SELECT m.user_id INTO v_user FROM account_members m WHERE m.account_id = p_account_id AND m.person_id = p_person_id;
  IF v_user IS NULL OR v_user = v_actor THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM notification_preferences p
              WHERE p.account_id = p_account_id AND p.user_id = v_user AND p.type = p_type AND NOT p.enabled) THEN
    RETURN;
  END IF;
  INSERT INTO notifications AS n (account_id, user_id, type, entity, entity_id, actor_user_id, payload)
  VALUES (p_account_id, v_user, p_type, p_entity, p_entity_id, v_actor, jsonb_build_object(p_counter, 1, 'startDate', p_day))
  ON CONFLICT (account_id, user_id, type, tx_id) DO UPDATE
    SET payload = n.payload || jsonb_build_object(
          p_counter, COALESCE((n.payload ->> p_counter)::int, 0) + 1,
          'startDate', LEAST(n.payload ->> 'startDate', p_day::text));
END $$;

-- Allocations : création, modification, suppression. Une réaffectation à une autre personne compte comme une suppression pour
-- l'ancienne et une création pour la nouvelle.
CREATE FUNCTION notify_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM notify_person(OLD.account_id, OLD.person_id, 'allocation_changed', 'allocations', OLD.id, 'deleted', OLD.start_date);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM notify_person(NEW.account_id, NEW.person_id, 'allocation_changed', 'allocations', NEW.id, 'created', NEW.start_date);
  ELSIF OLD.person_id IS DISTINCT FROM NEW.person_id THEN
    PERFORM notify_person(OLD.account_id, OLD.person_id, 'allocation_changed', 'allocations', OLD.id, 'deleted', OLD.start_date);
    PERFORM notify_person(NEW.account_id, NEW.person_id, 'allocation_changed', 'allocations', NEW.id, 'created', NEW.start_date);
  ELSE
    PERFORM notify_person(NEW.account_id, NEW.person_id, 'allocation_changed', 'allocations', NEW.id, 'updated', NEW.start_date);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_93_notify AFTER INSERT OR UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION notify_allocation();

-- Congés : décision (passage à approved / declined, ou création directement dans cet état). Le retour à pending n'est pas notifié.
CREATE FUNCTION notify_timeoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approval_status IN ('approved','declined')
     AND (TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM NEW.approval_status) THEN
    PERFORM notify_person(NEW.account_id, NEW.person_id, 'timeoff_decided', 'timeoffs', NEW.id, NEW.approval_status::text, NEW.start_date);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_93_notify AFTER INSERT OR UPDATE OF approval_status ON timeoffs
  FOR EACH ROW EXECUTE FUNCTION notify_timeoff();

-- Réveil temps réel du SEUL destinataire : livré au COMMIT, doublons d'une transaction fusionnés. Le payload ne porte que des
-- identifiants ; le serveur relit le compteur sous la RLS du destinataire.
CREATE FUNCTION notification_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('wnext_notifications', NEW.account_id::text || ':' || NEW.user_id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER trg_94_wake AFTER INSERT OR UPDATE OF read_at ON notifications
  FOR EACH ROW EXECUTE FUNCTION notification_wake();

-- ---------- RÉTENTION ----------
-- Purge des notifications plus anciennes que p_retain (défaut 90 jours, au moins 1 jour), lues ou non. Rôle BYPASSRLS (job
-- d'exploitation) : sous RLS FORCE, sans contexte, aucune ligne n'est visible. Retourne le nombre de lignes purgées.
CREATE FUNCTION purge_notifications(p_retain INTERVAL DEFAULT INTERVAL '90 days') RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  IF p_retain IS NULL OR p_retain < INTERVAL '1 day' THEN
    RAISE EXCEPTION 'purge_notifications : rétention < 1 jour interdite' USING ERRCODE = '22023';
  END IF;
  DELETE FROM notifications WHERE created_at < clock_timestamp() - p_retain;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
