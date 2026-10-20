-- ============================================================
-- 0002_people_history — BR-19 : historisation datée des attributs d'une personne
-- ============================================================
-- Conception (décision du 2026-10-20) :
--
-- 1. Quoi. Les attributs d'une personne qui changent sa capacité ou son coût : horaire hebdomadaire (work_days_hours,
--    index 0 = lundi), département, rôle, taux de coût individuel (people.cost_rate). Les grilles de taux (rate_cards)
--    ont déjà valid_from/valid_to : elles ne sont pas dupliquées ici ; seul le taux de dernier recours porté par la
--    personne (BR-23 « à défaut taux de coût de la personne ») est historisé.
--
-- 2. Une table unique `people_history`, une ligne par (personne, attribut, période), et non une ligne « instantané »
--    de tous les attributs. Raisons :
--    * les attributs changent indépendamment : un changement de département au 1er février ne doit pas réécrire un
--      changement d'horaire déjà prévu au 1er mars (un instantané forcerait à recopier chaque période) ;
--    * une seule table = une seule RLS, un seul jeu de triggers, une seule route de lecture (GET /people/{id}/history) ;
--    * colonnes de valeur typées (et non JSONB) : on garde les clés étrangères vers departments et roles, et la même
--      contrainte sur work_days_hours que people. Une contrainte impose que seule la colonne de l'attribut soit remplie.
--    Pas de recouvrement : EXCLUDE gist (person_id, attribute, daterange(valid_from, valid_to, '[]')).
--    Bornes : valid_from NULL = « depuis toujours », valid_to NULL = « sans fin », valid_to INCLUS (comme rate_cards).
--    Invariant : pour chaque (personne, attribut), les périodes forment une PARTITION de la ligne du temps (aucun trou),
--    la dernière est ouverte (valid_to NULL).
--
-- 3. Les colonnes de people restent en place (compatibilité : API, Schedule, moteur, tests existants) et portent la
--    valeur de la DERNIÈRE période (la période ouverte). C'est la valeur en vigueur aujourd'hui, sauf changement futur
--    déjà saisi. Voie retenue parce qu'elle est la moins risquée : aucune tâche planifiée pour « basculer » une valeur
--    à une date, aucune colonne qui devient périmée, et l'invariant people.<col> = valeur de la période ouverte se
--    vérifie par une requête. Les calculs datés (daily_capacity, daily_planned_load) lisent l'historique.
--
-- 4. L'historique n'est JAMAIS écrit directement : il suit people par trigger (trg_80_people_history).
--    * INSERT people : une période (NULL, NULL) par attribut.
--    * UPDATE people d'un attribut historisé : la nouvelle valeur s'applique « à partir de » D = app.effective_from
--      (SET LOCAL posé par l'API) ou, à défaut, aujourd'hui dans le fuseau du compte. Les périodes qui commencent à D
--      ou après sont remplacées, celle qui couvre D est fermée à D - 1, une période [D, ∞) est créée. Ainsi la valeur
--      ouverte est toujours la dernière saisie (invariant du point 3).
--    * Remises à NULL en cascade (ON DELETE SET NULL d'un département ou d'un rôle supprimé) : ignorées ici, car la même
--      cascade remet à NULL la référence dans toutes les périodes de l'historique (la référence n'existe plus). Elles ne
--      sont donc jamais bloquées par une période verrouillée.
--    * Écriture directe (INSERT/UPDATE/DELETE hors trigger) refusée : 42501.
--
-- 5. Période verrouillée (BR-19 « une modification ne change jamais une période verrouillée »). Le schéma n'a pas
--    d'entité « période » ni de date de clôture (Q-06 ouverte) ; la seule notion de verrou est celle des temps saisis :
--    une ligne logged_time non-draft (submitted, approved, locked) est verrouillée (BR-12). Définition retenue : la
--    période verrouillée d'une personne s'étend jusqu'au plus grand work_date de ses temps saisis non-draft
--    (person_locked_through). Une entrée datée dont valid_from tombe à cette date ou avant (NULL = depuis toujours)
--    changerait la capacité ou le coût de jours déjà verrouillés : refusée, SQLSTATE stable 'WN019'
--    (l'API le traduit en 409 PERSON_HISTORY_LOCKED). Pour corriger, un Owner/Admin déverrouille d'abord les temps.
--
-- 6. Journalisation (BR-14). Audit : created_by/modified_by/created_at/modified_at/row_version et trg_90_touch, comme
--    les autres tables. PAS de trg_91_delete_log ni de trg_92_change_log : l'historique est une propriété de la
--    personne, il n'évolue que par une écriture de people (journalisée : change_log 'people' avec sa nouvelle version,
--    delete_log 'people' à la suppression). Un client resynchronise l'historique en relisant la personne.
--
-- 7. RLS : tenant_isolation sur account_id, ENABLE + FORCE, comme toute table cloisonnée (l'inventaire T18 de
--    schema_tests.sql la couvre automatiquement : elle porte account_id).
--
-- Migration exécutée par le propriétaire du schéma (superuser ou BYPASSRLS, comme les purges) : l'amorçage lit toutes
-- les personnes de tous les comptes.
-- ============================================================

CREATE TABLE people_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  person_id       BIGINT NOT NULL,
  attribute       TEXT   NOT NULL CHECK (attribute IN ('work_days_hours','department_id','role_id','cost_rate')),
  valid_from      DATE,   -- NULL = depuis toujours
  valid_to        DATE,   -- inclus ; NULL = sans fin
  work_days_hours NUMERIC(4,2)[],
  department_id   BIGINT,
  role_id         BIGINT,
  cost_rate       NUMERIC(10,2) CHECK (cost_rate IS NULL OR cost_rate >= 0),
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by     BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version     INT NOT NULL DEFAULT 1,
  CONSTRAINT chk_people_history_bounds CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  -- Seule la colonne de l'attribut porte une valeur ; département, rôle et taux peuvent valoir NULL (« aucun »).
  CONSTRAINT chk_people_history_value CHECK (
    (attribute = 'work_days_hours') = (work_days_hours IS NOT NULL)
    AND (attribute = 'department_id' OR department_id IS NULL)
    AND (attribute = 'role_id'       OR role_id IS NULL)
    AND (attribute = 'cost_rate'     OR cost_rate IS NULL)),
  CONSTRAINT chk_people_history_wdh CHECK (work_days_hours IS NULL OR (
    array_length(work_days_hours, 1) = 7
    AND array_position(work_days_hours, NULL) IS NULL
    AND 0 <= ALL (work_days_hours) AND 24 >= ALL (work_days_hours))),
  CONSTRAINT ex_people_history_period EXCLUDE USING gist
    (person_id WITH =, attribute WITH =, daterange(valid_from, valid_to, '[]') WITH &&),
  FOREIGN KEY (person_id,     account_id) REFERENCES people(id, account_id)      ON DELETE CASCADE,
  FOREIGN KEY (department_id, account_id) REFERENCES departments(id, account_id) ON DELETE SET NULL (department_id),
  FOREIGN KEY (role_id,       account_id) REFERENCES roles(id, account_id)       ON DELETE SET NULL (role_id)
);
CREATE INDEX idx_people_history_account ON people_history (account_id, person_id);
CREATE INDEX idx_people_history_dept ON people_history (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX idx_people_history_role ON people_history (role_id) WHERE role_id IS NOT NULL;

-- Amorçage : une période (depuis toujours, sans fin) par personne et par attribut, aux valeurs actuelles.
INSERT INTO people_history (account_id, person_id, attribute, work_days_hours, department_id, role_id, cost_rate,
                            created_by, modified_by)
SELECT pe.account_id, pe.id, a.attribute,
       CASE WHEN a.attribute = 'work_days_hours' THEN pe.work_days_hours END,
       CASE WHEN a.attribute = 'department_id'   THEN pe.department_id END,
       CASE WHEN a.attribute = 'role_id'         THEN pe.role_id END,
       CASE WHEN a.attribute = 'cost_rate'       THEN pe.cost_rate END,
       pe.created_by, pe.modified_by
FROM people pe
CROSS JOIN (VALUES ('work_days_hours'), ('department_id'), ('role_id'), ('cost_rate')) a(attribute);

-- ---------- Période verrouillée ----------
-- Dernier jour verrouillé d'une personne : plus grand work_date de ses temps saisis non-draft (BR-12), NULL si aucun.
CREATE FUNCTION person_locked_through(p_person_id BIGINT) RETURNS DATE
LANGUAGE sql STABLE AS $$
  SELECT max(work_date) FROM logged_time WHERE person_id = p_person_id AND status <> 'draft'
$$;

-- Garde de l'historique : écriture uniquement par trigger (people ou cascade de clé étrangère) ; une entrée datée ne
-- commence jamais dans une période verrouillée (BR-19).
CREATE FUNCTION guard_people_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_locked date;
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'people_history : écriture directe refusée, modifier people (BR-19)' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_locked := person_locked_through(NEW.person_id);
    IF v_locked IS NOT NULL AND (NEW.valid_from IS NULL OR NEW.valid_from <= v_locked) THEN
      RAISE EXCEPTION 'people_history : % de la personne % à partir du % touche une période verrouillée (jusqu''au %, BR-19)',
        NEW.attribute, NEW.person_id, COALESCE(NEW.valid_from::text, '-infinity'), v_locked
        USING ERRCODE = 'WN019', DETAIL = v_locked::text;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_01_guard BEFORE INSERT OR UPDATE OR DELETE ON people_history
  FOR EACH ROW EXECUTE FUNCTION guard_people_history();
CREATE TRIGGER trg_90_touch BEFORE UPDATE ON people_history FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Date d'effet d'une modification : app.effective_from (SET LOCAL de l'API), sinon aujourd'hui dans le fuseau du compte.
CREATE FUNCTION history_effective_from(p_account_id BIGINT) RETURNS DATE
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.effective_from', true), '')::date,
    (now() AT TIME ZONE COALESCE((SELECT timezone FROM accounts WHERE id = p_account_id), 'UTC'))::date)
$$;

-- Maintien de l'historique depuis people (voir l'en-tête, point 4).
CREATE FUNCTION people_history_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_from date;
  a text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO people_history (account_id, person_id, attribute, work_days_hours, department_id, role_id, cost_rate)
    SELECT NEW.account_id, NEW.id, x.attribute,
           CASE WHEN x.attribute = 'work_days_hours' THEN NEW.work_days_hours END,
           CASE WHEN x.attribute = 'department_id'   THEN NEW.department_id END,
           CASE WHEN x.attribute = 'role_id'         THEN NEW.role_id END,
           CASE WHEN x.attribute = 'cost_rate'       THEN NEW.cost_rate END
    FROM (VALUES ('work_days_hours'), ('department_id'), ('role_id'), ('cost_rate')) x(attribute);
    RETURN NULL;
  END IF;
  FOREACH a IN ARRAY ARRAY['work_days_hours','department_id','role_id','cost_rate'] LOOP
    -- Remise à NULL issue d'une cascade (ON DELETE SET NULL : la référence n'existe plus) : ce n'est pas une modification
    -- datée, l'historique est remis à NULL par sa propre clé étrangère. (Les actions de clé étrangère mettent leurs
    -- triggers AFTER en file au niveau de la requête d'origine : pg_trigger_depth() ne les distingue pas.)
    CONTINUE WHEN a = 'department_id' AND NEW.department_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM departments WHERE id = OLD.department_id);
    CONTINUE WHEN a = 'role_id' AND NEW.role_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM roles WHERE id = OLD.role_id);
    IF (to_jsonb(NEW) -> a) IS DISTINCT FROM (to_jsonb(OLD) -> a) THEN
      v_from := COALESCE(v_from, history_effective_from(NEW.account_id));
      DELETE FROM people_history WHERE person_id = NEW.id AND attribute = a AND valid_from >= v_from;
      UPDATE people_history SET valid_to = v_from - 1
       WHERE person_id = NEW.id AND attribute = a
         AND (valid_from IS NULL OR valid_from < v_from) AND (valid_to IS NULL OR valid_to >= v_from);
      INSERT INTO people_history (account_id, person_id, attribute, valid_from, work_days_hours, department_id, role_id, cost_rate)
      VALUES (NEW.account_id, NEW.id, a, v_from,
              CASE WHEN a = 'work_days_hours' THEN NEW.work_days_hours END,
              CASE WHEN a = 'department_id'   THEN NEW.department_id END,
              CASE WHEN a = 'role_id'         THEN NEW.role_id END,
              CASE WHEN a = 'cost_rate'       THEN NEW.cost_rate END);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_80_people_history AFTER INSERT OR UPDATE OF work_days_hours, department_id, role_id, cost_rate ON people
  FOR EACH ROW EXECUTE FUNCTION people_history_sync();

-- ---------- Calculs datés ----------
-- Horaire en vigueur d'une personne à une date ; NULL si l'historique est invisible (pas de contexte RLS) : l'appelant
-- retombe alors sur people.work_days_hours.
CREATE FUNCTION person_work_days_hours_on(p_person_id BIGINT, p_day DATE) RETURNS NUMERIC[]
LANGUAGE sql STABLE AS $$
  SELECT work_days_hours FROM people_history
  WHERE person_id = p_person_id AND attribute = 'work_days_hours' AND daterange(valid_from, valid_to, '[]') @> p_day
$$;

-- Nouvelle version de daily_planned_load (0001) : la base du pourcentage et le filtre « jour ouvré » lisent l'horaire en
-- vigueur à chaque jour (BR-19, BR-24). Le reste est inchangé.
CREATE OR REPLACE FUNCTION daily_planned_load(p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (person_id BIGINT, day DATE, planned_hours NUMERIC, tentative_hours NUMERIC, billable_hours NUMERIC)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'daily_planned_load : plage invalide ou > 400 jours (% .. %)', p_from, p_to
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT a.person_id, g.day,
         SUM(h.v)::numeric,
         COALESCE(SUM(h.v) FILTER (WHERE a.status = 'tentative' OR pr.status = 'tentative'), 0)::numeric,
         COALESCE(SUM(h.v) FILTER (WHERE a.billable AND NOT pr.non_billable
                                     AND NOT COALESCE(ph.non_billable, FALSE)
                                     AND COALESCE(pt.billable, TRUE)
                                     AND a.status = 'confirmed' AND pr.status <> 'tentative'), 0)::numeric
  FROM allocations a
  JOIN people   pe ON pe.id = a.person_id AND pe.account_id = a.account_id
  JOIN projects pr ON pr.id = a.project_id AND pr.account_id = a.account_id
  LEFT JOIN phases        ph ON ph.id = a.phase_id
  LEFT JOIN project_tasks pt ON pt.id = a.project_task_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN a.repeat_state = 'none' THEN a.end_date ELSE a.repeat_end_date END AS span_end
  ) s
  CROSS JOIN LATERAL (
    SELECT d::date AS day
    FROM generate_series(GREATEST(a.start_date, p_from)::timestamp,
                         LEAST(s.span_end, p_to)::timestamp, interval '1 day') d
  ) g
  CROSS JOIN LATERAL (
    SELECT wd_hours(COALESCE(person_work_days_hours_on(pe.id, g.day), pe.work_days_hours), g.day) AS wd
  ) w
  CROSS JOIN LATERAL (
    SELECT CASE a.mode WHEN 'hours' THEN a.hours_per_day
                       ELSE w.wd * a.percent / 100 END AS v
  ) h
  WHERE a.account_id = p_account_id
    AND daterange(a.start_date, COALESCE(a.repeat_end_date, a.end_date), '[]')
        && daterange(p_from, p_to, '[]')
    AND w.wd > 0
    AND allocation_covers_day(a.start_date, a.end_date, a.repeat_state, g.day)
  GROUP BY a.person_id, g.day;
END $$;

-- Nouvelle version de daily_capacity (0001) : l'horaire de base est celui en vigueur à chaque jour (BR-19).
-- Le département utilisé pour les fériés d'équipe reste le département courant (people.department_id).
CREATE OR REPLACE FUNCTION daily_capacity(p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (person_id BIGINT, day DATE, base_hours NUMERIC, holiday_hours NUMERIC,
               timeoff_hours NUMERIC, capacity_hours NUMERIC)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'daily_capacity : plage invalide ou > 400 jours (% .. %)', p_from, p_to
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT pe.id, d.day, wd.h, a1.hh, a2.th, wd.h - a1.hh - a2.th
  FROM people pe
  CROSS JOIN LATERAL (
    SELECT g::date AS day FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ) d
  CROSS JOIN LATERAL (
    SELECT wd_hours(COALESCE(person_work_days_hours_on(pe.id, d.day), pe.work_days_hours), d.day) AS h
  ) wd
  CROSS JOIN LATERAL (
    SELECT MAX(COALESCE(ho.hours_off, wd.h)) AS hrs
    FROM holidays ho
    WHERE ho.account_id = pe.account_id AND ho.hdate = d.day
      AND (ho.country       IS NULL OR ho.country       = pe.country)
      AND (ho.department_id IS NULL OR ho.department_id = pe.department_id)
  ) hol
  CROSS JOIN LATERAL (
    SELECT SUM(CASE WHEN t.scope = 'full_day'
                    THEN wd.h * ((NOT (d.day = t.start_date AND t.start_half = 'pm'))::int
                               + (NOT (d.day = t.end_date   AND t.end_half   = 'am'))::int) / 2
                    ELSE t.hours_per_day END) AS hrs
    FROM timeoffs t
    JOIN timeoff_types tt ON tt.id = t.timeoff_type_id AND tt.deducted
    WHERE t.person_id = pe.id
      AND d.day BETWEEN t.start_date AND t.end_date
      AND t.approval_status <> 'declined'
  ) tof
  CROSS JOIN LATERAL (SELECT LEAST(wd.h, COALESCE(hol.hrs, 0)) AS hh) a1
  CROSS JOIN LATERAL (SELECT LEAST(COALESCE(tof.hrs, 0), wd.h - a1.hh) AS th) a2
  WHERE pe.account_id = p_account_id AND pe.active;
END $$;

-- ---------- RLS et droits ----------
ALTER TABLE people_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people_history
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON people_history TO app_user;
GRANT USAGE ON SEQUENCE people_history_id_seq TO app_user;
