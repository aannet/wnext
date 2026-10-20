-- ============================================================
-- Tests SQL — historisation datée des personnes (@BR-19), migration 0002_people_history
-- Exécution (base migrée : schema.sql puis migrations/, rôle superuser/propriétaire) :
--   psql -v ON_ERROR_STOP=1 -f tests/sql/people_history_tests.sql <db>
-- Lancé par tests/migrations/people-history.test.ts (base vierge, migrations depuis zéro).
-- Tout est dans une transaction annulée à la fin. Première assertion en échec => exception 'FAIL: <libellé>'.
-- Calendrier : 2026-03-30 = lundi, 2026-04-01 = mercredi.
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
CREATE FUNCTION t.ctx(acc text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('app.account_id', t.id(acc)::text, true); END $$;
CREATE FUNCTION t.at(d text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('app.effective_from', d, true); END $$;

-- Capacité de base d'une personne un jour donné (daily_capacity, migration 0002).
CREATE FUNCTION t.base(acc text, person text, d date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT base_hours FROM daily_capacity(t.id(acc), d, d) WHERE person_id = t.id(person)
$$;
-- Périodes d'un attribut, triées : 'debut..fin=valeur' (bornes ouvertes : '-' ; valeur : texte).
CREATE FUNCTION t.periods(person text, attr text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(COALESCE(valid_from::text, '-') || '..' || COALESCE(valid_to::text, '-') || '='
                    || COALESCE(CASE attr WHEN 'work_days_hours' THEN work_days_hours::text WHEN 'department_id' THEN department_id::text
                                          WHEN 'role_id' THEN role_id::text ELSE cost_rate::text END, 'null'),
                    ' | ' ORDER BY valid_from NULLS FIRST)
  FROM people_history WHERE person_id = t.id(person) AND attribute = attr
$$;

INSERT INTO accounts(name) VALUES ('A'), ('B');
INSERT INTO t.ids SELECT name, id FROM accounts WHERE name IN ('A','B');
INSERT INTO users(email) VALUES ('h1@example.com');
INSERT INTO t.ids SELECT 'u1', id FROM users WHERE email = 'h1@example.com';
SELECT set_config('app.user_id', t.id('u1')::text, true);
INSERT INTO departments(account_id, name) VALUES (t.id('A'), 'Design'), (t.id('A'), 'Dev');
INSERT INTO t.ids SELECT 'd_' || lower(name), id FROM departments WHERE account_id = t.id('A');
INSERT INTO roles(account_id, name) VALUES (t.id('A'), 'Lead');
INSERT INTO t.ids SELECT 'r_lead', id FROM roles WHERE account_id = t.id('A');
INSERT INTO people(account_id, name) VALUES (t.id('A'), 'Paul'), (t.id('A'), 'Quentin'), (t.id('B'), 'Bea');
INSERT INTO t.ids SELECT lower(name), id FROM people;
INSERT INTO projects(account_id, name) VALUES (t.id('A'), 'Pr');
INSERT INTO t.ids SELECT 'pr', id FROM projects WHERE account_id = t.id('A');

-- ============================================================
-- H01 Création : une période ouverte par attribut, valeurs de people
-- ============================================================
SELECT t.eq('H01a @BR-19 une personne créée a 4 périodes (une par attribut)',
  (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('paul')), 4);
SELECT t.ok('H01b période initiale : depuis toujours, sans fin, horaire par défaut',
  t.periods('paul', 'work_days_hours') = '-..-={8.00,8.00,8.00,8.00,8.00,0.00,0.00}');
SELECT t.ok('H01c audit : created_by renseigné par le contexte',
  (SELECT bool_and(created_by = t.id('u1')) FROM people_history WHERE person_id = t.id('paul')));

-- ============================================================
-- H02 Changement d'horaire au 1er du mois : capacité avant/après (@BR-19)
-- ============================================================
SELECT t.at('2026-04-01');
UPDATE people SET work_days_hours = '{4,4,4,4,4,0,0}' WHERE id = t.id('paul');
SELECT t.ok('H02a @BR-19 deux périodes : jusqu au 31/03 puis à partir du 01/04',
  t.periods('paul', 'work_days_hours') = '-..2026-03-31={8.00,8.00,8.00,8.00,8.00,0.00,0.00} | 2026-04-01..-={4.00,4.00,4.00,4.00,4.00,0.00,0.00}');
SELECT t.eq('H02b @BR-19 capacité le mardi 31/03 (avant) : 8 h', t.base('A', 'paul', '2026-03-31'), 8);
SELECT t.eq('H02c @BR-19 capacité le mercredi 01/04 (après) : 4 h', t.base('A', 'paul', '2026-04-01'), 4);
SELECT t.eq('H02d capacité sur la semaine du 30/03 : 8 + 8 + 4 + 4 + 4',
  (SELECT SUM(capacity_hours) FROM daily_capacity(t.id('A'), '2026-03-30', '2026-04-05') WHERE person_id = t.id('paul')), 28);
SELECT t.ok('H02e people porte la valeur de la période ouverte',
  (SELECT work_days_hours = '{4,4,4,4,4,0,0}' FROM people WHERE id = t.id('paul')));
-- Charge en pourcentage (BR-24) : base brute = horaire en vigueur le jour même.
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, mode, percent)
  VALUES (t.id('A'), t.id('paul'), t.id('pr'), '2026-03-31', '2026-04-01', 'percentage', 50);
SELECT t.ok('H02f @BR-24 charge à 50 % : 4 h le 31/03, 2 h le 01/04',
  (SELECT array_agg(planned_hours ORDER BY day) FROM daily_planned_load(t.id('A'), '2026-03-31', '2026-04-01') WHERE person_id = t.id('paul'))
  = ARRAY[4, 2]::numeric[]);
SELECT t.ok('H02g utilization suit : capacité 8 puis 4',
  (SELECT array_agg(capacity_hours ORDER BY day) FROM utilization(t.id('A'), '2026-03-31', '2026-04-01') WHERE person_id = t.id('paul'))
  = ARRAY[8, 4]::numeric[]);
-- Un jour devenu non ouvré n'a plus de charge (filtre jour ouvré daté).
SELECT t.at('2026-04-02');
UPDATE people SET work_days_hours = '{4,4,4,0,0,0,0}' WHERE id = t.id('paul');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  VALUES (t.id('A'), t.id('paul'), t.id('pr'), '2026-03-26', '2026-04-02', 2);
SELECT t.ok('H02h jeudi 26/03 ouvré (avant), jeudi 02/04 non ouvré (après) : charge 2 puis aucune',
  (SELECT array_agg(day::text || ':' || planned_hours::int ORDER BY day) FROM daily_planned_load(t.id('A'), '2026-03-26', '2026-04-02')
    WHERE person_id = t.id('paul') AND extract(isodow FROM day) = 4) = ARRAY['2026-03-26:2']);

-- ============================================================
-- H03 « À partir de » : une date antérieure remplace les périodes suivantes
-- ============================================================
SELECT t.at('2026-03-15');
UPDATE people SET work_days_hours = '{6,6,6,6,6,0,0}' WHERE id = t.id('paul');
SELECT t.ok('H03a @BR-19 la période du 01/04 et celle du 02/04 sont remplacées par celle du 15/03',
  t.periods('paul', 'work_days_hours') = '-..2026-03-14={8.00,8.00,8.00,8.00,8.00,0.00,0.00} | 2026-03-15..-={6.00,6.00,6.00,6.00,6.00,0.00,0.00}');
SELECT t.eq('H03b capacité le 01/04 : 6 h', t.base('A', 'paul', '2026-04-01'), 6);
-- Même date d'effet : la période est remplacée, pas dupliquée.
UPDATE people SET work_days_hours = '{7,7,7,7,7,0,0}' WHERE id = t.id('paul');
SELECT t.eq('H03c même date d effet : toujours deux périodes', (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('paul') AND attribute = 'work_days_hours'), 2);
SELECT t.eq('H03d capacité le lundi 16/03 : 7 h', t.base('A', 'paul', '2026-03-16'), 7);
-- Un attribut ne touche pas les autres.
SELECT t.at('2026-02-01');
UPDATE people SET department_id = t.id('d_design') WHERE id = t.id('paul');
SELECT t.ok('H03e changement de département daté : périodes du département seules',
  t.periods('paul', 'department_id') = '-..2026-01-31=null | 2026-02-01..-=' || t.id('d_design'));
SELECT t.eq('H03f l horaire n est pas réécrit', (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('paul') AND attribute = 'work_days_hours'), 2);
SELECT t.at('2026-05-01');
UPDATE people SET role_id = t.id('r_lead'), cost_rate = 55 WHERE id = t.id('paul');
SELECT t.ok('H03g rôle et taux de coût historisés à la même date',
  t.periods('paul', 'role_id') = '-..2026-04-30=null | 2026-05-01..-=' || t.id('r_lead')
  AND t.periods('paul', 'cost_rate') = '-..2026-04-30=null | 2026-05-01..-=55.00');
-- Un attribut non historisé ne crée aucune période.
UPDATE people SET name = 'Paul R.', tags = '{x}' WHERE id = t.id('paul');
SELECT t.eq('H03h nom et tags : aucune période ajoutée', (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('paul')), 8);
-- Valeur réaffectée à l'identique : rien ne bouge.
UPDATE people SET work_days_hours = work_days_hours WHERE id = t.id('paul');
SELECT t.eq('H03i valeur inchangée : aucune période ajoutée', (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('paul')), 8);

-- ============================================================
-- H04 Date d'effet par défaut : aujourd'hui dans le fuseau du compte
-- ============================================================
SELECT t.at('');
UPDATE accounts SET timezone = 'Pacific/Kiritimati' WHERE id = t.id('A');
UPDATE people SET work_days_hours = '{5,5,5,5,5,0,0}' WHERE id = t.id('quentin');
SELECT t.ok('H04a @BR-19 sans app.effective_from : la période commence aujourd hui (fuseau du compte, UTC+14)',
  (SELECT valid_from FROM people_history WHERE person_id = t.id('quentin') AND attribute = 'work_days_hours' AND valid_to IS NULL)
  = (now() AT TIME ZONE 'Pacific/Kiritimati')::date);
UPDATE accounts SET timezone = 'UTC' WHERE id = t.id('A');

-- ============================================================
-- H05 Chevauchement refusé ; écriture directe refusée
-- ============================================================
SELECT t.raises('H05a @BR-19 INSERT direct dans l historique refusé',
  $q$ INSERT INTO people_history(account_id, person_id, attribute, valid_from, work_days_hours)
      VALUES (t.id('A'), t.id('paul'), 'work_days_hours', '2026-06-01', '{1,1,1,1,1,0,0}') $q$, '42501');
SELECT t.raises('H05b UPDATE direct refusé', $q$ UPDATE people_history SET valid_to = '2026-01-01' WHERE person_id = t.id('paul') $q$, '42501');
SELECT t.raises('H05c DELETE direct refusé', $q$ DELETE FROM people_history WHERE person_id = t.id('paul') $q$, '42501');
-- La contrainte d'exclusion elle-même, garde levée le temps du test (transaction annulée).
ALTER TABLE people_history DISABLE TRIGGER trg_01_guard;
SELECT t.raises('H05d @BR-19 deux périodes qui se chevauchent pour la même personne et le même attribut : refusé (EXCLUDE)',
  $q$ INSERT INTO people_history(account_id, person_id, attribute, valid_from, valid_to, work_days_hours)
      VALUES (t.id('A'), t.id('paul'), 'work_days_hours', '2026-03-01', '2026-03-20', '{1,1,1,1,1,0,0}') $q$, '23P01');
SELECT t.raises('H05e valeur hors de la colonne de l attribut : refusé',
  $q$ INSERT INTO people_history(account_id, person_id, attribute, valid_from, role_id)
      VALUES (t.id('A'), t.id('paul'), 'department_id', '2030-01-01', t.id('r_lead')) $q$, '23514');
SELECT t.raises('H05f horaire de 6 jours : refusé',
  $q$ INSERT INTO people_history(account_id, person_id, attribute, valid_from, work_days_hours)
      VALUES (t.id('A'), t.id('bea'), 'work_days_hours', '2030-01-01', '{1,1,1,1,1,0}') $q$, '23514');
SELECT t.raises('H05g département d un autre compte : refusé (clé composite)',
  $q$ UPDATE people_history SET department_id = t.id('d_design') WHERE person_id = t.id('bea') AND attribute = 'department_id' $q$, '23503');
ALTER TABLE people_history ENABLE TRIGGER trg_01_guard;

-- ============================================================
-- H06 Période verrouillée (temps saisis non-draft, BR-12) : jamais modifiée (@BR-19, code WN019)
-- ============================================================
INSERT INTO logged_time(account_id, person_id, project_id, work_date, hours) VALUES (t.id('A'), t.id('quentin'), t.id('pr'), '2026-03-10', 4);
INSERT INTO logged_time(account_id, person_id, project_id, work_date, hours) VALUES (t.id('A'), t.id('quentin'), t.id('pr'), '2026-03-20', 4);
UPDATE logged_time SET status = 'submitted' WHERE person_id = t.id('quentin') AND work_date = '2026-03-10';
SELECT t.ok('H06a dernier jour verrouillé = plus grand work_date non-draft (le draft du 20/03 ne compte pas)',
  person_locked_through(t.id('quentin')) = '2026-03-10');
SELECT t.ok('H06b personne sans temps verrouillé : NULL', person_locked_through(t.id('paul')) IS NULL);
SELECT t.at('2026-03-10');
SELECT t.raises('H06c @BR-19 valid_from le jour verrouillé : refusé',
  $q$ UPDATE people SET work_days_hours = '{1,1,1,1,1,0,0}' WHERE id = t.id('quentin') $q$, 'WN019');
SELECT t.at('2026-03-01');
SELECT t.raises('H06d @BR-19 valid_from avant la période verrouillée : refusé (département)',
  $q$ UPDATE people SET department_id = t.id('d_dev') WHERE id = t.id('quentin') $q$, 'WN019');
SELECT t.raises('H06e @BR-19 taux de coût : même règle',
  $q$ UPDATE people SET cost_rate = 10 WHERE id = t.id('quentin') $q$, 'WN019');
SELECT t.ok('H06f refus : people et l historique sont inchangés',
  (SELECT department_id IS NULL AND cost_rate IS NULL FROM people WHERE id = t.id('quentin'))
  AND (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('quentin') AND attribute = 'department_id') = 1);
SELECT t.at('2026-03-11');
UPDATE people SET department_id = t.id('d_dev') WHERE id = t.id('quentin');
SELECT t.ok('H06g @BR-19 le lendemain du dernier jour verrouillé : accepté',
  t.periods('quentin', 'department_id') = '-..2026-03-10=null | 2026-03-11..-=' || t.id('d_dev'));
-- Déverrouillage par un admin : la modification redevient possible.
SELECT set_config('app.role', 'admin', true);
UPDATE logged_time SET status = 'draft' WHERE person_id = t.id('quentin');
SELECT set_config('app.role', '', true);
SELECT t.at('2026-03-01');
UPDATE people SET cost_rate = 10 WHERE id = t.id('quentin');
SELECT t.ok('H06h après déverrouillage : accepté', t.periods('quentin', 'cost_rate') = '-..2026-02-28=null | 2026-03-01..-=10.00');
UPDATE logged_time SET status = 'submitted' WHERE person_id = t.id('quentin') AND work_date = '2026-03-10';
-- Suppression d'un département référencé : la cascade n'est pas une modification datée, jamais bloquée.
DELETE FROM departments WHERE id = t.id('d_dev');
SELECT t.ok('H06i suppression du département : acceptée malgré le verrou, référence remise à NULL partout',
  (SELECT department_id IS NULL FROM people WHERE id = t.id('quentin'))
  AND t.periods('quentin', 'department_id') = '-..2026-03-10=null | 2026-03-11..-=null');

-- ============================================================
-- H07 Invariants : partition sans trou, people = période ouverte
-- ============================================================
SELECT t.ok('H07a @BR-19 chaque (personne, attribut) a exactement une période ouverte',
  NOT EXISTS (SELECT 1 FROM people pe CROSS JOIN (VALUES ('work_days_hours'), ('department_id'), ('role_id'), ('cost_rate')) a(attr)
              WHERE (SELECT COUNT(*) FROM people_history h WHERE h.person_id = pe.id AND h.attribute = a.attr AND h.valid_to IS NULL) <> 1));
SELECT t.ok('H07b aucune période sans début hormis la première, aucun trou entre deux périodes',
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT person_id, attribute, valid_from,
             lag(valid_to) OVER (PARTITION BY person_id, attribute ORDER BY valid_from NULLS FIRST) AS prev_to,
             row_number() OVER (PARTITION BY person_id, attribute ORDER BY valid_from NULLS FIRST) AS rn
      FROM people_history ) x
    WHERE (rn = 1 AND valid_from IS NOT NULL) OR (rn > 1 AND valid_from IS DISTINCT FROM prev_to + 1)));
SELECT t.ok('H07c people porte la valeur de la période ouverte, pour chaque attribut',
  NOT EXISTS (SELECT 1 FROM people pe JOIN people_history h ON h.person_id = pe.id AND h.valid_to IS NULL
              WHERE (h.attribute = 'work_days_hours' AND h.work_days_hours IS DISTINCT FROM pe.work_days_hours)
                 OR (h.attribute = 'department_id' AND h.department_id IS DISTINCT FROM pe.department_id)
                 OR (h.attribute = 'role_id' AND h.role_id IS DISTINCT FROM pe.role_id)
                 OR (h.attribute = 'cost_rate' AND h.cost_rate IS DISTINCT FROM pe.cost_rate)));

-- ============================================================
-- H08 RLS cross-tenant (@BR-32) et sous app_user
-- ============================================================
SELECT t.ok('H08a RLS active et forcée, politique tenant_isolation',
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.people_history'::regclass)
  AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'people_history' AND policyname = 'tenant_isolation'
                AND qual = '(account_id = app_account_id())' AND with_check = '(account_id = app_account_id())'));
SET LOCAL ROLE app_user;
SELECT t.ctx('B');
SELECT t.eq('H08b @BR-19 contexte B : aucune période de A visible', (SELECT COUNT(*) FROM people_history WHERE account_id = t.id('A')), 0);
SELECT t.eq('H08c contexte B : ses propres périodes visibles', (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('bea')), 4);
SELECT t.eq('H08d contexte B : modifier une personne de A n atteint rien',
  t.rowcount($q$ UPDATE people SET work_days_hours = '{1,1,1,1,1,0,0}' WHERE id = t.id('paul') $q$), 0);
SELECT t.ok('H08e contexte B : la capacité de A est vide', NOT EXISTS (SELECT 1 FROM daily_capacity(t.id('A'), '2026-04-01', '2026-04-01')));
SELECT t.ctx('A');
SELECT t.at('2026-06-01');
UPDATE people SET work_days_hours = '{3,3,3,3,3,0,0}' WHERE id = t.id('paul');
SELECT t.ok('H08f sous app_user (contexte A) : historisation par trigger, capacité datée lue sous RLS',
  t.base('A', 'paul', '2026-06-01') = 3 AND t.base('A', 'paul', '2026-05-29') = 7);
SELECT t.raises('H08g sous app_user : écriture directe refusée',
  $q$ DELETE FROM people_history WHERE person_id = t.id('paul') $q$, '42501');
RESET ROLE;
SELECT t.at('');

-- ============================================================
-- H09 Cascade et journalisation (BR-14)
-- ============================================================
INSERT INTO people(account_id, name) VALUES (t.id('A'), 'Jetable');
INSERT INTO t.ids SELECT 'jetable', id FROM people WHERE name = 'Jetable';
DELETE FROM people WHERE id = t.id('jetable');
SELECT t.eq('H09a suppression de la personne : son historique part en cascade', (SELECT COUNT(*) FROM people_history WHERE person_id = t.id('jetable')), 0);
SELECT t.ok('H09b la suppression est journalisée sur people seulement (l historique est une propriété de la personne)',
  EXISTS (SELECT 1 FROM delete_log WHERE entity = 'people' AND entity_id = t.id('jetable'))
  AND NOT EXISTS (SELECT 1 FROM delete_log WHERE entity = 'people_history'));
SELECT t.ok('H09c une modification datée est journalisée comme mise à jour de la personne (change_log, nouvelle version)',
  EXISTS (SELECT 1 FROM change_log c JOIN people pe ON pe.id = c.entity_id
          WHERE c.entity = 'people' AND c.entity_id = t.id('paul') AND c.version = pe.row_version));
SELECT t.ok('H09d trg_90_touch : row_version incrémentée sur la période fermée',
  (SELECT row_version > 1 FROM people_history WHERE person_id = t.id('paul') AND attribute = 'work_days_hours' AND valid_from IS NULL));

SELECT COUNT(*) AS tests_passed FROM t.results;
ROLLBACK;
