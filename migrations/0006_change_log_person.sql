-- ============================================================
-- 0006_change_log_person : personne(s) concernée(s) par chaque ligne du journal de changements (RT-048, US-6.1)
-- ============================================================
-- Un member ne voit que ses assignations, « API et WebSocket incluses ». Le temps réel diffuse change_log, qui ne porte que des
-- références (entité, id) : impossible d'y retrouver la personne d'une ligne supprimée, ni l'ancienne personne d'une allocation
-- réaffectée. La colonne person_ids la fige au moment du changement, pour que l'API filtre le flux par abonné avec la même règle
-- que le REST (apps/api/src/scope.ts) :
--   * people : la personne elle-même ;
--   * allocations, timeoffs, logged_time : la personne de la ligne ; une mise à jour qui change de personne porte l'ancienne ET la
--     nouvelle (le member qui perd une allocation doit apprendre qu'elle a changé, celui qui la reçoit aussi) ;
--   * project_team : la personne ajoutée ou retirée (id du journal = le projet, inchangé) ;
--   * autres entités (référentiels) : NULL, diffusées à tous les rôles.
-- Les lignes écrites avant cette migration ont person_ids NULL (aucune ligne écrite après n'en a pour une entité par personne) : un
-- member qui reprend avant l'une d'elles reçoit `resync` (apps/api/src/changes.ts), au lieu de la sauter ; elles disparaissent à la
-- purge (BR-14).
-- Corps des triggers sinon inchangés (schema.sql) : numérotation sous verrou, NOTIFY.

ALTER TABLE change_log ADD COLUMN person_ids BIGINT[];

CREATE OR REPLACE FUNCTION log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_row record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_seq bigint;
  v_people bigint[];
BEGIN
  IF TG_TABLE_NAME = 'people' THEN
    v_people := ARRAY[v_row.id];
  ELSIF TG_TABLE_NAME IN ('allocations', 'timeoffs', 'logged_time') THEN
    v_people := ARRAY[v_row.person_id];
    IF TG_OP = 'UPDATE' THEN
      IF OLD.person_id IS DISTINCT FROM NEW.person_id THEN
        v_people := ARRAY[OLD.person_id, NEW.person_id];
      END IF;
    END IF;
  END IF;
  INSERT INTO account_change_seq (account_id, seq) VALUES (v_row.account_id, 1)
  ON CONFLICT (account_id) DO UPDATE SET seq = account_change_seq.seq + 1
  RETURNING seq INTO v_seq;
  INSERT INTO change_log (account_id, seq, entity, entity_id, op, version, changed_by, person_ids)
  VALUES (v_row.account_id, v_seq, TG_TABLE_NAME, v_row.id, lower(TG_OP),
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.row_version END, app_user_id(), v_people);
  PERFORM pg_notify('wnext_changes', v_row.account_id::text);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION log_team_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_row record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_seq bigint;
  v_people bigint[] := ARRAY[v_row.person_id];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = v_row.project_id AND account_id = v_row.account_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.person_id IS DISTINCT FROM NEW.person_id THEN
      v_people := ARRAY[OLD.person_id, NEW.person_id];
    END IF;
  END IF;
  INSERT INTO account_change_seq (account_id, seq) VALUES (v_row.account_id, 1)
  ON CONFLICT (account_id) DO UPDATE SET seq = account_change_seq.seq + 1
  RETURNING seq INTO v_seq;
  INSERT INTO change_log (account_id, seq, entity, entity_id, op, version, changed_by, person_ids)
  VALUES (v_row.account_id, v_seq, 'project_team', v_row.project_id, 'update', v_seq, app_user_id(), v_people);
  PERFORM pg_notify('wnext_changes', v_row.account_id::text);
  RETURN NULL;
END $$;
