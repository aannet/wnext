-- ============================================================
-- Tests de non-régression SQL — schema.sql v1.1 (PostgreSQL >= 15)
-- Exécution (base vierge, schema.sql déjà chargé, rôle superuser/propriétaire) :
--   psql -v ON_ERROR_STOP=1 -f schema.sql   <db>
--   psql -v ON_ERROR_STOP=1 -f tests/sql/schema_tests.sql <db>
-- Tout est dans une transaction annulée à la fin (aucune trace). Première
-- assertion en échec => exception 'FAIL: <libellé>' et arrêt.
-- Traçabilité : BR-01..03 (charge/capacité), BR-04, BR-05, BR-07, BR-10, BR-12,
-- BR-14 (delete_log, change_log), BR-15, BR-20/21, BR-25 (répétitions), BR-27, BR-28, BR-30, BR-32, BR-38.
-- Calendrier de référence : 2026-03-02 = lundi (vérifié en T00).
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

-- Exécute stmt ; l'assertion réussit si une erreur (SQLSTATE want) est levée.
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

CREATE FUNCTION t.mkaccount(k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN INSERT INTO accounts(name) VALUES (k) RETURNING id INTO v; INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mkuser(k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN INSERT INTO users(email, name) VALUES (k || '@example.com', k) RETURNING id INTO v; INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mkdept(k text, acc text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN PERFORM t.ctx(acc);
  INSERT INTO departments(account_id, name) VALUES (t.id(acc), k) RETURNING id INTO v; INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mkperson(k text, acc text DEFAULT 'A', wdh numeric[] DEFAULT '{8,8,8,8,8,0,0}',
                           country text DEFAULT NULL, dept text DEFAULT NULL, ptype people_type DEFAULT 'employee')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN PERFORM t.ctx(acc);
  INSERT INTO people(account_id, name, work_days_hours, country, department_id, people_type)
  VALUES (t.id(acc), k, wdh, country, CASE WHEN dept IS NULL THEN NULL ELSE t.id(dept) END, ptype)
  RETURNING id INTO v;
  INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mkproj(k text, acc text DEFAULT 'A', st project_status DEFAULT 'in_progress', nb boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN PERFORM t.ctx(acc);
  INSERT INTO projects(account_id, name, status, non_billable) VALUES (t.id(acc), k, st, nb) RETURNING id INTO v;
  INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mkphase(k text, proj text, nb boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO phases(account_id, project_id, name, non_billable)
  SELECT account_id, id, k, nb FROM projects WHERE id = t.id(proj) RETURNING id INTO v;
  INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mktask(k text, proj text, bill boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO project_tasks(account_id, project_id, name, billable)
  SELECT account_id, id, k, bill FROM projects WHERE id = t.id(proj) RETURNING id INTO v;
  INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mkalloc(p text, pr text, s date, e date, v numeric, acc text DEFAULT 'A',
                          mode allocation_mode DEFAULT 'hours', st allocation_status DEFAULT 'confirmed',
                          rep repeat_state_t DEFAULT 'none', rend date DEFAULT NULL, bill boolean DEFAULT true,
                          phase text DEFAULT NULL, task text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r bigint;
BEGIN PERFORM t.ctx(acc);
  INSERT INTO allocations(account_id, person_id, project_id, phase_id, project_task_id, start_date, end_date,
                          mode, hours_per_day, percent, status, repeat_state, repeat_end_date, billable)
  VALUES (t.id(acc), t.id(p), t.id(pr), CASE WHEN phase IS NULL THEN NULL ELSE t.id(phase) END,
          CASE WHEN task IS NULL THEN NULL ELSE t.id(task) END, s, e, mode,
          CASE WHEN mode = 'hours' THEN v END, CASE WHEN mode = 'percentage' THEN v END,
          st, rep, rend, bill)
  RETURNING id INTO r;
  RETURN r; END $$;

CREATE FUNCTION t.mktype(k text, deducted boolean DEFAULT true, acc text DEFAULT 'A') RETURNS void LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN PERFORM t.ctx(acc);
  INSERT INTO timeoff_types(account_id, name, deducted) VALUES (t.id(acc), k, deducted) RETURNING id INTO v;
  INSERT INTO t.ids VALUES (k, v); END $$;

CREATE FUNCTION t.mktimeoff(p text, ty text, s date, e date, scope timeoff_scope DEFAULT 'full_day',
                            h numeric DEFAULT NULL, ap approval_status DEFAULT 'approved', acc text DEFAULT 'A',
                            sh day_half DEFAULT 'am', eh day_half DEFAULT 'pm')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx(acc);
  INSERT INTO timeoffs(account_id, person_id, timeoff_type_id, start_date, end_date, scope, hours_per_day, approval_status, start_half, end_half)
  VALUES (t.id(acc), t.id(p), t.id(ty), s, e, scope, h, ap, sh, eh); END $$;

CREATE FUNCTION t.mkholiday(nm text, d date, country text DEFAULT NULL, dept text DEFAULT NULL,
                            hrs numeric DEFAULT NULL, acc text DEFAULT 'A')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx(acc);
  INSERT INTO holidays(account_id, name, hdate, country, department_id, hours_off)
  VALUES (t.id(acc), nm, d, country, CASE WHEN dept IS NULL THEN NULL ELSE t.id(dept) END, hrs); END $$;

-- Accesseurs de résultats
CREATE FUNCTION t.load(p text, f date, e date, acc text DEFAULT 'A') RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(planned_hours), 0) FROM daily_planned_load(t.id(acc), f, e) WHERE person_id = t.id(p) $$;
CREATE FUNCTION t.days(p text, f date, e date, acc text DEFAULT 'A') RETURNS numeric LANGUAGE sql AS $$
  SELECT COUNT(*) FROM daily_planned_load(t.id(acc), f, e) WHERE person_id = t.id(p) $$;
CREATE FUNCTION t.cap(p text, d date, acc text DEFAULT 'A') RETURNS numeric LANGUAGE sql AS $$
  SELECT capacity_hours FROM daily_capacity(t.id(acc), d, d) WHERE person_id = t.id(p) $$;

-- ============================================================
-- FIXTURES
-- ============================================================
SELECT t.mkaccount('A'); SELECT t.mkaccount('B');
SELECT t.mkuser('u1'); SELECT t.mkuser('u2');
SELECT t.mkdept('design', 'A');
SELECT t.mkproj('pc', 'A');                          -- confirmé, facturable
SELECT t.mkproj('pt', 'A', 'tentative');             -- tentatif
SELECT t.mkproj('pn', 'A', 'in_progress', true);     -- non facturable
SELECT t.mkproj('pb', 'B');

-- ============================================================
-- T00 Convention de semaine : index 0 = lundi, ISODOW (BR-18)
-- ============================================================
SELECT t.eq('T00a 2026-03-02 est un lundi (ISODOW 1)', EXTRACT(ISODOW FROM DATE '2026-03-02'), 1);
SELECT t.eq('T00b {0,4,4,4,0,0,0} lundi = 0 h',   wd_hours('{0,4,4,4,0,0,0}', '2026-03-02'), 0);
SELECT t.eq('T00c {0,4,4,4,0,0,0} mardi = 4 h',   wd_hours('{0,4,4,4,0,0,0}', '2026-03-03'), 4);
SELECT t.eq('T00d {4,4,4,0,0,0,0} lundi = 4 h',   wd_hours('{4,4,4,0,0,0,0}', '2026-03-02'), 4);
SELECT t.eq('T00e {4,4,4,0,0,0,0} jeudi = 0 h',   wd_hours('{4,4,4,0,0,0,0}', '2026-03-05'), 0);
SELECT t.eq('T00f dimanche = index 6',             wd_hours('{1,2,3,4,5,6,7}', '2026-03-08'), 7);
SELECT t.mkperson('def');
SELECT t.ok('T00g défaut work_days_hours = {8,8,8,8,8,0,0}',
  (SELECT work_days_hours = '{8,8,8,8,8,0,0}'::numeric[] FROM people WHERE id = t.id('def')));
SELECT t.ok('T00h accounts.week_start défaut = 1 (lundi)', (SELECT week_start = 1 FROM accounts WHERE id = t.id('A')));
SELECT t.ok('T00i accounts.capacity_thresholds défaut : sous-allocation 80 % (Q5)', (SELECT (capacity_thresholds ->> 'under_percent')::numeric = 80 FROM accounts WHERE id = t.id('A')));
SELECT t.ok('T00j seuil de compte paramétrable (90 %)', t.rowcount($q$ UPDATE accounts SET capacity_thresholds = '{"under_percent": 90}' WHERE id = t.id('A') $q$) = 1);
SELECT t.raises('T00k seuil 0 refusé',   $q$ UPDATE accounts SET capacity_thresholds = '{"under_percent": 0}'   WHERE id = t.id('A') $q$, '23514');
SELECT t.raises('T00l seuil 101 refusé', $q$ UPDATE accounts SET capacity_thresholds = '{"under_percent": 101}' WHERE id = t.id('A') $q$, '23514');
SELECT t.raises('T00m seuil non numérique refusé', $q$ UPDATE accounts SET capacity_thresholds = '{"under_percent": "80"}' WHERE id = t.id('A') $q$, '23514');
SELECT t.raises('T00n seuil absent refusé', $q$ UPDATE accounts SET capacity_thresholds = '{}' WHERE id = t.id('A') $q$, '23514');
UPDATE accounts SET capacity_thresholds = DEFAULT WHERE id = t.id('A');

-- ============================================================
-- T01 Allocation multi-jours (BR-01) : somme jour par jour, week-end ignoré
-- ============================================================
SELECT t.mkperson('alice');
SELECT t.mkalloc('alice', 'pc', '2026-03-02', '2026-03-06', 6);
SELECT t.eq('T01a lun-ven x 6 h = 30 h',            t.load('alice', '2026-03-02', '2026-03-08'), 30);
SELECT t.eq('T01b 5 jours ouvrés avec charge',       t.days('alice', '2026-03-02', '2026-03-08'), 5);
SELECT t.eq('T01c aucun jour hors du bloc',          t.days('alice', '2026-03-09', '2026-03-31'), 0);
SELECT t.mkperson('alice2');
SELECT t.mkalloc('alice2', 'pc', '2026-03-04', '2026-03-10', 4);   -- mer -> mar suivant, week-end au milieu
SELECT t.eq('T01d bloc à cheval sur un week-end : 5 jours ouvrés x 4 h', t.load('alice2', '2026-03-01', '2026-03-31'), 20);
SELECT t.eq('T01e samedi/dimanche (jour non ouvré) ignorés', t.days('alice2', '2026-03-07', '2026-03-08'), 0);
SELECT t.eq('T01f fenêtre partielle (clamp p_from/p_to)', t.load('alice2', '2026-03-05', '2026-03-09'), 12);

-- ============================================================
-- T02 Pourcentage + horaire asymétrique (BR-01, H-01)
-- ============================================================
SELECT t.mkperson('bob', 'A', '{0,4,4,4,0,0,0}');                 -- mardi-jeudi 4 h
SELECT t.mkalloc('bob', 'pc', '2026-03-02', '2026-03-06', 50, mode => 'percentage');
SELECT t.eq('T02a 50 % de mar/mer/jeu 4 h = 3 x 2 h',  t.load('bob', '2026-03-02', '2026-03-08'), 6);
SELECT t.eq('T02b lundi/vendredi (0 h ouvrées) sans charge', t.days('bob', '2026-03-02', '2026-03-08'), 3);
SELECT t.mkperson('bob2');
SELECT t.mkalloc('bob2', 'pc', '2026-03-09', '2026-03-09', 150, mode => 'percentage');
SELECT t.eq('T02c 150 % accepté (BR-01) = 12 h',       t.load('bob2', '2026-03-09', '2026-03-09'), 12);

-- ============================================================
-- T03 Répétitions (BR-25)
-- ============================================================
SELECT t.mkperson('carol');
SELECT t.mkalloc('carol', 'pc', '2026-03-02', '2026-03-03', 5, rep => 'weekly', rend => '2026-03-29');
SELECT t.eq('T03a hebdo lun-mar jusqu au 29/03 : 4 semaines x 2 jours', t.days('carol', '2026-03-01', '2026-04-30'), 8);
SELECT t.eq('T03b hebdo : 8 x 5 h',                      t.load('carol', '2026-03-01', '2026-04-30'), 40);
SELECT t.eq('T03c hebdo : mercredi sans charge',          t.load('carol', '2026-03-04', '2026-03-04'), 0);
SELECT t.eq('T03d hebdo : 2ème occurrence (lundi 09/03)', t.load('carol', '2026-03-09', '2026-03-09'), 5);
SELECT t.eq('T03e hebdo : 4ème occurrence (mardi 24/03)', t.load('carol', '2026-03-24', '2026-03-24'), 5);
SELECT t.eq('T03f hebdo : rien après repeat_end_date',    t.days('carol', '2026-03-30', '2026-04-30'), 0);

SELECT t.mkperson('dave');
SELECT t.mkalloc('dave', 'pc', '2026-03-02', '2026-03-02', 3, rep => 'daily', rend => '2026-03-13');
SELECT t.eq('T03g quotidien jusqu au 13/03 : 10 jours ouvrés', t.days('dave', '2026-03-01', '2026-03-31'), 10);
SELECT t.eq('T03h quotidien : week-end sauté',                  t.days('dave', '2026-03-07', '2026-03-08'), 0);

SELECT t.mkperson('sam', 'A', '{8,8,8,8,8,8,8}');               -- 7 j / 7
SELECT t.mkalloc('sam', 'pc', '2026-01-31', '2026-01-31', 2, rep => 'monthly', rend => '2026-05-31');
SELECT t.eq('T03i mensuel le 31 : 5 occurrences (31/01,28/02,31/03,30/04,31/05)', t.days('sam', '2026-01-01', '2026-06-30'), 5);
SELECT t.eq('T03j mensuel : clamp au 28/02',   t.load('sam', '2026-02-28', '2026-02-28'), 2);
SELECT t.eq('T03k mensuel : pas de 03/03',     t.load('sam', '2026-03-03', '2026-03-03'), 0);
SELECT t.eq('T03l mensuel : retour au 31/03 (calcul depuis la date d origine)', t.load('sam', '2026-03-31', '2026-03-31'), 2);
SELECT t.eq('T03m mensuel : 30/04',            t.load('sam', '2026-04-30', '2026-04-30'), 2);

-- ============================================================
-- T04 Tentatif / facturable (BR-07, BR-13, BR-20, BR-21)
-- ============================================================
SELECT t.mkperson('erin');
SELECT t.mkphase('ph_nb', 'pc', true);
SELECT t.mktask('tk_nb', 'pc', false);
SELECT t.mkalloc('erin', 'pc', '2026-03-09', '2026-03-09', 4);                              -- confirmé facturable
SELECT t.mkalloc('erin', 'pt', '2026-03-09', '2026-03-09', 3);                              -- projet tentatif
SELECT t.mkalloc('erin', 'pc', '2026-03-09', '2026-03-09', 2, st => 'tentative');           -- allocation tentative
SELECT t.mkalloc('erin', 'pn', '2026-03-09', '2026-03-09', 1);                              -- projet non facturable
SELECT t.mkalloc('erin', 'pc', '2026-03-09', '2026-03-09', 1, bill => false);               -- allocation non facturable
SELECT t.mkalloc('erin', 'pc', '2026-03-10', '2026-03-10', 5, phase => 'ph_nb');            -- phase non facturable
SELECT t.mkalloc('erin', 'pc', '2026-03-10', '2026-03-10', 2, task => 'tk_nb');             -- tâche non facturable
SELECT t.eq('T04a planifié total (chevauchements autorisés) = 11', (SELECT planned_hours   FROM daily_planned_load(t.id('A'), '2026-03-09', '2026-03-09') WHERE person_id = t.id('erin')), 11);
SELECT t.eq('T04b tentatif = projet tentatif + allocation tentative = 5', (SELECT tentative_hours FROM daily_planned_load(t.id('A'), '2026-03-09', '2026-03-09') WHERE person_id = t.id('erin')), 5);
SELECT t.eq('T04c facturable = seulement confirmé facturable = 4', (SELECT billable_hours  FROM daily_planned_load(t.id('A'), '2026-03-09', '2026-03-09') WHERE person_id = t.id('erin')), 4);
SELECT t.eq('T04d phase/tâche non facturable : planifié 7, facturable 0',
  (SELECT planned_hours - billable_hours FROM daily_planned_load(t.id('A'), '2026-03-10', '2026-03-10') WHERE person_id = t.id('erin')), 7);

-- ============================================================
-- T05 Capacité de base : une ligne par jour, même non ouvré
-- ============================================================
SELECT t.eq('T05a 7 lignes de capacité pour 7 jours', (SELECT COUNT(*) FROM daily_capacity(t.id('A'), '2026-03-02', '2026-03-08') WHERE person_id = t.id('alice')), 7);
SELECT t.eq('T05b lundi = 8 h',   t.cap('alice', '2026-03-02'), 8);
SELECT t.eq('T05c samedi = 0 h (ligne présente)', t.cap('alice', '2026-03-07'), 0);
SELECT t.eq('T05d horaire asymétrique : mardi bob = 4 h', t.cap('bob', '2026-03-03'), 4);
SELECT t.eq('T05e horaire asymétrique : lundi bob = 0 h', t.cap('bob', '2026-03-02'), 0);
SELECT t.raises('T05f plage > 400 jours refusée', $q$ SELECT * FROM daily_capacity(t.id('A'), '2026-01-01', '2027-06-01') $q$, '22023');
SELECT t.raises('T05g plage inversée refusée',    $q$ SELECT * FROM daily_planned_load(t.id('A'), '2026-03-09', '2026-03-02') $q$, '22023');

-- ============================================================
-- T06 Jours fériés par pays / équipe / compte / partiel (BR-02, BR-30)
-- semaine du lundi 2026-04-06
-- ============================================================
SELECT t.mkperson('fr',  'A', '{8,8,8,8,8,0,0}', 'FR', 'design');
SELECT t.mkperson('fr2', 'A', '{8,8,8,8,8,0,0}', 'FR');
SELECT t.mkperson('de',  'A', '{8,8,8,8,8,0,0}', 'DE');
SELECT t.mkperson('nc',  'A');                                    -- pays NULL
SELECT t.mkholiday('Global',   '2026-04-06');
SELECT t.mkholiday('Ferie FR', '2026-04-07', 'FR');
SELECT t.mkholiday('Equipe design', '2026-04-08', NULL, 'design');
SELECT t.mkholiday('Demi DE',  '2026-04-09', 'DE', NULL, 3);
SELECT t.eq('T06a férié global : fr = 0 h',  t.cap('fr', '2026-04-06'), 0);
SELECT t.eq('T06b férié global : nc = 0 h',  t.cap('nc', '2026-04-06'), 0);
SELECT t.eq('T06c férié global : ligne conservée (pas de NOT EXISTS)', (SELECT COUNT(*) FROM daily_capacity(t.id('A'), '2026-04-06', '2026-04-06') WHERE person_id = t.id('de')), 1);
SELECT t.eq('T06d férié FR : fr = 0 h',      t.cap('fr', '2026-04-07'), 0);
SELECT t.eq('T06e férié FR : fr2 = 0 h',     t.cap('fr2', '2026-04-07'), 0);
SELECT t.eq('T06f férié FR : de = 8 h',      t.cap('de', '2026-04-07'), 8);
SELECT t.eq('T06g férié FR : pays NULL = 8 h', t.cap('nc', '2026-04-07'), 8);
SELECT t.eq('T06h férié équipe design : fr = 0 h',   t.cap('fr', '2026-04-08'), 0);
SELECT t.eq('T06i férié équipe design : fr2 (autre équipe) = 8 h', t.cap('fr2', '2026-04-08'), 8);
SELECT t.eq('T06j demi-journée DE : de = 5 h', t.cap('de', '2026-04-09'), 5);
SELECT t.eq('T06k demi-journée DE : fr = 8 h', t.cap('fr', '2026-04-09'), 8);
-- allocation posée sur un férié : visible en sur-allocation, jamais perdue
SELECT t.mkalloc('fr', 'pc', '2026-04-06', '2026-04-06', 6);
SELECT t.eq('T06l alloc sur férié : charge conservée (6 h)', (SELECT planned_hours FROM utilization(t.id('A'), '2026-04-06', '2026-04-06') WHERE person_id = t.id('fr')), 6);
SELECT t.eq('T06m alloc sur férié : surtemps = 6 h', (SELECT overtime_hours FROM utilization(t.id('A'), '2026-04-06', '2026-04-06') WHERE person_id = t.id('fr')), 6);
SELECT t.ok('T06n alloc sur férié : utilization infinie et is_overbooked (jamais NULL, BR-38)',
  (SELECT utilization = 'Infinity'::numeric AND is_overbooked FROM utilization(t.id('A'), '2026-04-06', '2026-04-06') WHERE person_id = t.id('fr')));

-- ============================================================
-- T07 Congés (BR-02, BR-04, BR-05, BR-29)
-- ============================================================
SELECT t.mktype('vac', true); SELECT t.mktype('tele', false);
SELECT t.mkperson('tom'); SELECT t.mkperson('tom2');
SELECT t.mkalloc('tom', 'pc', '2026-04-13', '2026-04-14', 6);
SELECT t.mkalloc('tom2', 'pc', '2026-04-13', '2026-04-14', 6);     -- coéquipier (BR-05)
SELECT t.mktimeoff('tom', 'vac', '2026-04-13', '2026-04-14', ap => 'pending');
SELECT t.eq('T07a congé pleine journée pending : capacité 0 (jour 1)', t.cap('tom', '2026-04-13'), 0);
SELECT t.eq('T07b congé pleine journée pending : capacité 0 (jour 2)', t.cap('tom', '2026-04-14'), 0);
SELECT t.eq('T07c BR-04 : aucune allocation supprimée par le congé', (SELECT COUNT(*) FROM allocations WHERE person_id = t.id('tom')), 1);
SELECT t.eq('T07d BR-04 : charge conservée => surtemps visible (2 jours x 6 h)', (SELECT SUM(overtime_hours) FROM utilization(t.id('A'), '2026-04-13', '2026-04-14') WHERE person_id = t.id('tom')), 12);
SELECT t.eq('T07e BR-05 : le congé de tom n affecte pas tom2', t.cap('tom2', '2026-04-13'), 8);
SELECT t.mktimeoff('tom', 'vac', '2026-04-15', '2026-04-15', ap => 'declined');
SELECT t.eq('T07f congé refusé : capacité inchangée', t.cap('tom', '2026-04-15'), 8);
SELECT t.mktimeoff('tom', 'vac', '2026-04-16', '2026-04-16', 'partial', 2);
SELECT t.mktimeoff('tom', 'vac', '2026-04-16', '2026-04-16', 'partial', 3);
SELECT t.eq('T07g deux congés partiels cumulés (2 h + 3 h) : capacité 3 h', t.cap('tom', '2026-04-16'), 3);
SELECT t.mktimeoff('tom', 'vac', '2026-04-17', '2026-04-17', 'partial', 6);
SELECT t.mktimeoff('tom', 'vac', '2026-04-17', '2026-04-17', 'partial', 6);
SELECT t.eq('T07h congés partiels > horaire du jour : plafonné, capacité 0', t.cap('tom', '2026-04-17'), 0);
SELECT t.eq('T07i congé plafonné : timeoff_hours = 8', (SELECT timeoff_hours FROM daily_capacity(t.id('A'), '2026-04-17', '2026-04-17') WHERE person_id = t.id('tom')), 8);
SELECT t.mktimeoff('tom', 'vac', '2026-04-18', '2026-04-19');                     -- week-end
SELECT t.eq('T07j congé sur jour non ouvré : aucun effet (déduction 0)', (SELECT timeoff_hours FROM daily_capacity(t.id('A'), '2026-04-18', '2026-04-18') WHERE person_id = t.id('tom')), 0);
SELECT t.mktimeoff('tom', 'tele', '2026-04-20', '2026-04-20', 'partial', 4);
SELECT t.eq('T07k type non déduit (télétravail) : capacité inchangée', t.cap('tom', '2026-04-20'), 8);
SELECT t.mkholiday('Global2', '2026-04-21');
SELECT t.mktimeoff('tom', 'vac', '2026-04-21', '2026-04-21');
SELECT t.eq('T07l férié + congé même jour : capacité 0', t.cap('tom', '2026-04-21'), 0);
SELECT t.eq('T07m férié prioritaire : pas de double déduction (timeoff_hours = 0)', (SELECT timeoff_hours FROM daily_capacity(t.id('A'), '2026-04-21', '2026-04-21') WHERE person_id = t.id('tom')), 0);
SELECT t.eq('T07n férié prioritaire : holiday_hours = 8', (SELECT holiday_hours FROM daily_capacity(t.id('A'), '2026-04-21', '2026-04-21') WHERE person_id = t.id('tom')), 8);
SELECT t.raises('T07o chevauchement de congés pleine journée refusé (EXCLUDE)',
  $q$ SELECT t.mktimeoff('tom', 'vac', '2026-04-14', '2026-04-15') $q$, '23P01');

-- Demi-journées (ADR-004)
SELECT t.mkperson('moi');
SELECT t.mktimeoff('moi', 'vac', '2026-05-04', '2026-05-04', sh => 'am', eh => 'am');
SELECT t.eq('T07p congé matin : capacité 4 h', t.cap('moi', '2026-05-04'), 4);
SELECT t.mktimeoff('moi', 'vac', '2026-05-04', '2026-05-04', sh => 'pm', eh => 'pm');
SELECT t.eq('T07q matin + après-midi (deux congés) : capacité 0', t.cap('moi', '2026-05-04'), 0);
SELECT t.raises('T07r deux congés sur le même matin refusés (EXCLUDE)',
  $q$ SELECT t.mktimeoff('moi', 'vac', '2026-05-04', '2026-05-04', sh => 'am', eh => 'am') $q$, '23P01');
SELECT t.mktimeoff('moi', 'vac', '2026-05-11', '2026-05-13', sh => 'pm', eh => 'am');
SELECT t.eq('T07s lundi après-midi : 4 h déduites', t.cap('moi', '2026-05-11'), 4);
SELECT t.eq('T07t mardi entier : capacité 0', t.cap('moi', '2026-05-12'), 0);
SELECT t.eq('T07u mercredi matin : 4 h déduites', t.cap('moi', '2026-05-13'), 4);
SELECT t.raises('T07v fin avant début dans la même journée (pm -> am) refusée',
  $q$ SELECT t.mktimeoff('moi', 'vac', '2026-05-18', '2026-05-18', sh => 'pm', eh => 'am') $q$, '23514');
SELECT t.raises('T07w congé partiel en heures avec une moitié de journée refusé',
  $q$ SELECT t.mktimeoff('moi', 'vac', '2026-05-19', '2026-05-19', 'partial', 2, sh => 'pm') $q$, '23514');
SELECT t.mkperson('moi6', 'A', '{6,6,6,6,6,0,0}');
SELECT t.mktimeoff('moi6', 'vac', '2026-05-04', '2026-05-04', sh => 'pm', eh => 'pm');
SELECT t.eq('T07x demi-journée sur un jour de 6 h : 3 h déduites', t.cap('moi6', '2026-05-04'), 3);
SELECT t.mkholiday('Global3', '2026-05-25');
SELECT t.mktimeoff('moi', 'vac', '2026-05-25', '2026-05-25', sh => 'am', eh => 'am');
SELECT t.eq('T07y férié + demi-journée de congé : pas de double déduction', t.cap('moi', '2026-05-25'), 0);

-- ============================================================
-- T08 Sur-allocation : calculée, jamais bloquée (BR-01, BR-03, BR-38)
-- ============================================================
SELECT t.mkperson('sue');
SELECT t.mkalloc('sue', 'pc', '2026-04-27', '2026-04-27', 6);
SELECT t.mkalloc('sue', 'pn', '2026-04-27', '2026-04-27', 5);       -- accepté malgré 11 h > 8 h
SELECT t.eq('T08a planifié 11 h',   (SELECT planned_hours  FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('sue')), 11);
SELECT t.eq('T08b capacité 8 h',    (SELECT capacity_hours FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('sue')), 8);
SELECT t.eq('T08c surtemps 3 h',    (SELECT overtime_hours FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('sue')), 3);
SELECT t.eq('T08d utilisation 1,375', (SELECT utilization  FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('sue')), 1.375);
SELECT t.ok('T08e is_overbooked',   (SELECT is_overbooked  FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('sue')));
SELECT t.mkperson('sue2');
SELECT t.mkalloc('sue2', 'pc', '2026-04-27', '2026-04-27', 4);
SELECT t.ok('T08f sous-charge : pas de surtemps, pas d overbooked',
  (SELECT overtime_hours = 0 AND NOT is_overbooked AND utilization = 0.5 FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('sue2')));
SELECT t.ok('T08g personne sans allocation : ligne présente, planifié 0',
  (SELECT planned_hours = 0 AND utilization = 0 FROM utilization(t.id('A'), '2026-04-27', '2026-04-27') WHERE person_id = t.id('nc')));
-- allocation posée sur un week-end : ignorée (BR-01), pas de ligne
SELECT t.mkperson('wk');
SELECT t.mkalloc('wk', 'pc', '2026-05-02', '2026-05-03', 8);       -- sam-dim
SELECT t.eq('T08h allocation uniquement week-end : aucune charge', t.days('wk', '2026-05-01', '2026-05-10'), 0);

-- ============================================================
-- T09 Contraintes d'intégrité
-- ============================================================
SELECT t.mkperson('bp', 'B');
SELECT t.ctx('A');
SELECT t.raises('T09a work_days_hours de taille 6 refusé',
  $q$ INSERT INTO people(account_id,name,work_days_hours) VALUES (t.id('A'),'x','{8,8,8,8,8,0}') $q$, '23514');
SELECT t.raises('T09b work_days_hours > 24 refusé',
  $q$ INSERT INTO people(account_id,name,work_days_hours) VALUES (t.id('A'),'x','{8,8,8,8,25,0,0}') $q$, '23514');
SELECT t.raises('T09c work_days_hours avec NULL refusé',
  $q$ INSERT INTO people(account_id,name,work_days_hours) VALUES (t.id('A'),'x','{8,8,NULL,8,8,0,0}') $q$, '23514');
SELECT t.raises('T09d pays invalide refusé',
  $q$ INSERT INTO people(account_id,name,country) VALUES (t.id('A'),'x','fr') $q$, '23514');
SELECT t.raises('T09e e-mail unique par compte, insensible à la casse',
  $q$ INSERT INTO people(account_id,name,email) VALUES (t.id('A'),'m1','Jo@x.io'), (t.id('A'),'m2','jo@X.io') $q$, '23505');
SELECT t.raises('T09f mode hours avec percent refusé',
  $q$ INSERT INTO allocations(account_id,person_id,project_id,start_date,end_date,mode,hours_per_day,percent)
     VALUES (t.id('A'),t.id('alice'),t.id('pc'),'2026-06-01','2026-06-01','hours',4,50) $q$, '23514');
SELECT t.raises('T09g mode percentage avec hours_per_day refusé',
  $q$ INSERT INTO allocations(account_id,person_id,project_id,start_date,end_date,mode,hours_per_day,percent)
     VALUES (t.id('A'),t.id('alice'),t.id('pc'),'2026-06-01','2026-06-01','percentage',4,50) $q$, '23514');
SELECT t.raises('T09h pourcentage > 500 refusé',
  $q$ SELECT t.mkalloc('alice','pc','2026-06-01','2026-06-01',600, mode => 'percentage') $q$, '23514');
SELECT t.raises('T09i répétition sans repeat_end_date refusée',
  $q$ SELECT t.mkalloc('alice','pc','2026-06-01','2026-06-01',4, rep => 'weekly') $q$, '23514');
SELECT t.raises('T09j repeat_end_date sans répétition refusée',
  $q$ SELECT t.mkalloc('alice','pc','2026-06-01','2026-06-01',4, rend => '2026-06-30') $q$, '23514');
SELECT t.raises('T09k fin de série avant fin d occurrence refusée',
  $q$ SELECT t.mkalloc('alice','pc','2026-06-01','2026-06-05',4, rep => 'weekly', rend => '2026-06-03') $q$, '23514');
SELECT t.raises('T09l allocation compte A sur personne du compte B refusée (FK composite, BR-32)',
  $q$ INSERT INTO allocations(account_id,person_id,project_id,start_date,end_date,hours_per_day)
     VALUES (t.id('A'),t.id('bp'),t.id('pc'),'2026-06-01','2026-06-01',4) $q$, '23503');
SELECT t.raises('T09m allocation compte A sur projet du compte B refusée',
  $q$ INSERT INTO allocations(account_id,person_id,project_id,start_date,end_date,hours_per_day)
     VALUES (t.id('A'),t.id('alice'),t.id('pb'),'2026-06-01','2026-06-01',4) $q$, '23503');
SELECT t.raises('T09n phase d un autre projet refusée (cohérence phase/projet)',
  $q$ SELECT t.mkalloc('alice','pt','2026-06-01','2026-06-01',4, phase => 'ph_nb') $q$, '23503');
SELECT t.raises('T09o tâche d un autre projet refusée',
  $q$ SELECT t.mkalloc('alice','pt','2026-06-01','2026-06-01',4, task => 'tk_nb') $q$, '23503');
SELECT t.raises('T09p férié global en double refusé (NULLS NOT DISTINCT)',
  $q$ SELECT t.mkholiday('Global', '2026-04-06') $q$, '23505');
SELECT t.raises('T09q férié partiel hours_off > 24 refusé',
  $q$ SELECT t.mkholiday('X', '2026-07-14', NULL, NULL, 30) $q$, '23514');
SELECT t.raises('T09r accounts.week_start hors 1..7 refusé',
  $q$ UPDATE accounts SET week_start = 0 WHERE id = t.id('A') $q$, '23514');
-- taux
INSERT INTO rate_cards(account_id, name, valid_from, valid_to) VALUES (t.id('A'), 'std', '2026-01-01', '2026-12-31');
INSERT INTO roles(account_id, name) VALUES (t.id('A'), 'dev');
SELECT t.ok('T09t rate card et rôle créés', (SELECT COUNT(*) FROM rate_cards) = 1);
INSERT INTO rates(account_id, rate_card_id, role_id, cost_rate, bill_rate)
  SELECT account_id, (SELECT id FROM rate_cards LIMIT 1), id, 50, 100 FROM roles WHERE name = 'dev';
SELECT t.raises('T09u taux en double (rate_card, rôle, personne NULL) refusé',
  $q$ INSERT INTO rates(account_id, rate_card_id, role_id, cost_rate, bill_rate)
     SELECT account_id, (SELECT id FROM rate_cards LIMIT 1), id, 60, 110 FROM roles WHERE name = 'dev' $q$, '23505');
SELECT t.raises('T09v taux sans rôle ni personne refusé',
  $q$ INSERT INTO rates(account_id, rate_card_id, cost_rate, bill_rate)
     VALUES (t.id('A'), (SELECT id FROM rate_cards LIMIT 1), 1, 1) $q$, '23514');
SELECT t.raises('T09w rate cards homonymes aux validités qui se recouvrent refusées',
  $q$ INSERT INTO rate_cards(account_id, name, valid_from) VALUES (t.id('A'), 'std', '2026-06-01') $q$, '23P01');
SELECT t.raises('T09x ligne de budget sans cible (ni tâche ni personne) refusée',
  $q$ INSERT INTO project_budget_lines(account_id, project_id, hours) VALUES (t.id('A'), t.id('pc'), 10) $q$, '23514');

-- ============================================================
-- T10 Placeholders : présents sur le Schedule, capacité calculée
-- ============================================================
SELECT t.mkperson('ph1', 'A', '{0,0,0,0,0,0,0}', NULL, NULL, 'placeholder');      -- placeholder à 0 h : compte quand même
SELECT t.mkperson('ctr', 'A', '{8,8,8,8,8,0,0}', NULL, NULL, 'contractor');
SELECT t.ctx('A');
SELECT t.eq('T10d capacité calculée pour le placeholder (0 h, ligne présente)', t.cap('ph1', '2026-03-02'), 0);

-- ============================================================
-- T11 Audit : created_by / modified_by / row_version (touch_row)
-- ============================================================
SELECT set_config('app.user_id', t.id('u1')::text, true);
SELECT t.mkperson('aud');
SELECT t.ok('T11a created_by renseigné par défaut depuis app.user_id', (SELECT created_by = t.id('u1') FROM people WHERE id = t.id('aud')));
SELECT t.eq('T11b row_version initial = 1', (SELECT row_version FROM people WHERE id = t.id('aud')), 1);
SELECT set_config('app.user_id', t.id('u2')::text, true);
UPDATE people SET name = 'aud2' WHERE id = t.id('aud');
SELECT t.eq('T11c row_version incrémenté', (SELECT row_version FROM people WHERE id = t.id('aud')), 2);
SELECT t.ok('T11d modified_by = utilisateur courant', (SELECT modified_by = t.id('u2') AND created_by = t.id('u1') FROM people WHERE id = t.id('aud')));
SELECT t.ok('T11e modified_at >= created_at', (SELECT modified_at >= created_at FROM people WHERE id = t.id('aud')));

-- ============================================================
-- T12 delete_log par trigger, cascades incluses (BR-14)
-- ============================================================
SELECT set_config('app.user_id', t.id('u1')::text, true);
SELECT t.mkperson('fran');
CREATE TABLE t.aid (k text PRIMARY KEY, v bigint);
INSERT INTO t.aid VALUES ('a1', t.mkalloc('fran', 'pc', '2026-06-01', '2026-06-02', 2));
INSERT INTO t.aid VALUES ('a2', t.mkalloc('fran', 'pc', '2026-06-03', '2026-06-04', 2));
DELETE FROM allocations WHERE id = (SELECT v FROM t.aid WHERE k = 'a1');
SELECT t.eq('T12a suppression d allocation journalisée',
  (SELECT COUNT(*) FROM delete_log WHERE entity = 'allocations' AND entity_id = (SELECT v FROM t.aid WHERE k = 'a1')), 1);
SELECT t.ok('T12b deleted_by et account_id renseignés',
  (SELECT deleted_by = t.id('u1') AND account_id = t.id('A') FROM delete_log WHERE entity = 'allocations' AND entity_id = (SELECT v FROM t.aid WHERE k = 'a1')));
-- cascade personne -> allocations
SELECT t.mktimeoff('fran', 'vac', '2026-07-01', '2026-07-02');
DELETE FROM people WHERE id = t.id('fran');
SELECT t.eq('T12c cascade : allocation a2 journalisée',
  (SELECT COUNT(*) FROM delete_log WHERE entity = 'allocations' AND entity_id = (SELECT v FROM t.aid WHERE k = 'a2')), 1);
SELECT t.eq('T12d cascade : congé journalisé',   (SELECT COUNT(*) FROM delete_log WHERE entity = 'timeoffs' AND account_id = t.id('A')), 1);
SELECT t.eq('T12e la personne elle-même journalisée', (SELECT COUNT(*) FROM delete_log WHERE entity = 'people' AND entity_id = t.id('fran')), 1);
-- cascade projet -> allocations
SELECT t.mkproj('pdel'); SELECT t.mkperson('gil');
INSERT INTO t.aid VALUES ('a3', t.mkalloc('gil', 'pdel', '2026-06-01', '2026-06-01', 2));
DELETE FROM projects WHERE id = t.id('pdel');
SELECT t.eq('T12f cascade projet -> allocation journalisée',
  (SELECT COUNT(*) FROM delete_log WHERE entity = 'allocations' AND entity_id = (SELECT v FROM t.aid WHERE k = 'a3')), 1);
SELECT t.ok('T12g curseur monotone : ids croissants', (SELECT bool_and(id > 0) FROM delete_log));
-- BR-04 : les suppressions ne sont jamais causées par un congé (déjà T07c)

-- ============================================================
-- T13 logged_time : RESTRICT, verrouillage, 24 h, placeholder (BR-10, BR-12, BR-27, BR-28)
-- ============================================================
SELECT t.mkperson('hal'); SELECT t.mkproj('plog');
SELECT t.mkphase('ph_log', 'plog');
SELECT set_config('app.role', 'member', true);
INSERT INTO logged_time(account_id, person_id, project_id, phase_id, work_date, hours)
  VALUES (t.id('A'), t.id('hal'), t.id('plog'), t.id('ph_log'), '2026-03-02', 8);
SELECT t.raises('T13a suppression de personne ayant du temps loggé : RESTRICT',
  $q$ DELETE FROM people WHERE id = t.id('hal') $q$, '23001');
SELECT t.raises('T13b suppression de projet ayant du temps loggé : RESTRICT',
  $q$ DELETE FROM projects WHERE id = t.id('plog') $q$, '23001');
UPDATE logged_time SET hours = 7 WHERE person_id = t.id('hal');
SELECT t.eq('T13c brouillon modifiable', (SELECT hours FROM logged_time WHERE person_id = t.id('hal')), 7);
UPDATE logged_time SET status = 'submitted' WHERE person_id = t.id('hal');
SELECT t.ok('T13d soumission : submitted_at posé automatiquement', (SELECT submitted_at IS NOT NULL FROM logged_time WHERE person_id = t.id('hal')));
SELECT t.raises('T13e ligne soumise : UPDATE refusé (member)',
  $q$ UPDATE logged_time SET hours = 6 WHERE person_id = t.id('hal') $q$, '42501');
SELECT t.raises('T13f ligne soumise : DELETE refusé (member)',
  $q$ DELETE FROM logged_time WHERE person_id = t.id('hal') $q$, '42501');
SELECT t.raises('T13g ligne soumise : retour en draft refusé (member)',
  $q$ UPDATE logged_time SET status = 'draft' WHERE person_id = t.id('hal') $q$, '42501');
SELECT t.raises('T13h member ne peut pas approuver/verrouiller',
  $q$ INSERT INTO logged_time(account_id, person_id, project_id, work_date, hours, status)
     VALUES (t.id('A'), t.id('hal'), t.id('plog'), '2026-03-03', 2, 'locked') $q$, '42501');
SELECT set_config('app.role', '', true);
SELECT t.raises('T13i rôle absent => fermé par défaut',
  $q$ UPDATE logged_time SET hours = 6 WHERE person_id = t.id('hal') $q$, '42501');
-- remise à NULL de référence (suppression de phase) autorisée sur ligne verrouillée
DELETE FROM phases WHERE id = t.id('ph_log');
SELECT t.ok('T13j suppression de phase : phase_id remis à NULL, ligne verrouillée intacte',
  (SELECT phase_id IS NULL AND status = 'submitted' AND hours = 7 FROM logged_time WHERE person_id = t.id('hal')));
-- déverrouillage admin audité
SELECT set_config('app.role', 'admin', true);
SELECT set_config('app.user_id', t.id('u2')::text, true);
UPDATE logged_time SET status = 'draft' WHERE person_id = t.id('hal');
SELECT t.ok('T13k déverrouillage admin : unlocked_by/unlocked_at journalisés, soumission effacée',
  (SELECT status = 'draft' AND unlocked_by = t.id('u2') AND unlocked_at IS NOT NULL AND submitted_at IS NULL
   FROM logged_time WHERE person_id = t.id('hal')));
SELECT set_config('app.role', 'member', true);
-- 24 h par jour
SELECT t.raises('T13l total > 24 h par personne et par jour refusé (BR-28)',
  $q$ INSERT INTO logged_time(account_id, person_id, project_id, work_date, hours)
     VALUES (t.id('A'), t.id('hal'), t.id('plog'), '2026-03-02', 18) $q$, '23514');
INSERT INTO logged_time(account_id, person_id, project_id, work_date, hours)
  VALUES (t.id('A'), t.id('hal'), t.id('plog'), '2026-03-02', 16);   -- 7 + 16 = 23 : accepté
SELECT t.raises('T13m placeholder ne peut pas loguer (BR-27)',
  $q$ INSERT INTO logged_time(account_id, person_id, project_id, work_date, hours)
     VALUES (t.id('A'), t.id('ph1'), t.id('plog'), '2026-03-02', 2) $q$, '23514');
-- pré-remplissage : pas de doublon allocation/jour (BR-11)
INSERT INTO t.aid VALUES ('a4', t.mkalloc('hal', 'plog', '2026-03-09', '2026-03-09', 4));
INSERT INTO logged_time(account_id, person_id, project_id, allocation_id, work_date, hours)
  VALUES (t.id('A'), t.id('hal'), t.id('plog'), (SELECT v FROM t.aid WHERE k = 'a4'), '2026-03-09', 4);
SELECT t.raises('T13n pré-remplissage dupliqué (même allocation, même jour) refusé',
  $q$ INSERT INTO logged_time(account_id, person_id, project_id, allocation_id, work_date, hours)
     VALUES (t.id('A'), t.id('hal'), t.id('plog'), (SELECT v FROM t.aid WHERE k = 'a4'), '2026-03-09', 1) $q$, '23505');
SELECT set_config('app.role', '', true);

-- ============================================================
-- T14 BR-10 : récapitulatif de retrait d'équipe
-- ============================================================
SELECT t.eq('T14b nb d allocations', (SELECT allocation_count FROM team_removal_summary(t.id('plog'), t.id('hal'))), 1);
SELECT t.eq('T14c nb de logs',        (SELECT log_count        FROM team_removal_summary(t.id('plog'), t.id('hal'))), 3);
SELECT t.ok('T14d aucun log verrouillé : retrait possible', (SELECT can_remove FROM team_removal_summary(t.id('plog'), t.id('hal'))));
SELECT set_config('app.role', 'admin', true);
UPDATE logged_time SET status = 'submitted' WHERE person_id = t.id('hal') AND work_date = '2026-03-09';
SELECT t.ok('T14e log soumis : retrait refusé (can_remove = false)', (SELECT NOT can_remove FROM team_removal_summary(t.id('plog'), t.id('hal'))));
SELECT set_config('app.role', '', true);

-- ============================================================
-- T15 Identité & vues sauvegardées
-- ============================================================
SELECT t.ctx('A');
INSERT INTO account_members(account_id, user_id, role, person_id) VALUES (t.id('A'), t.id('u1'), 'admin', t.id('alice'));
SELECT t.raises('T15a account_members : personne d un autre compte refusée (FK composite)',
  $q$ INSERT INTO account_members(account_id, user_id, role, person_id) VALUES (t.id('A'), t.id('u2'), 'member', t.id('bp')) $q$, '23503');
SELECT t.raises('T15b une personne ne peut être liée qu à un utilisateur',
  $q$ INSERT INTO account_members(account_id, user_id, role, person_id) VALUES (t.id('A'), t.id('u2'), 'member', t.id('alice')) $q$, '23505');
INSERT INTO saved_views(account_id, owner_user_id, name, filters) VALUES (t.id('A'), t.id('u1'), 'Design', '{"department":"design"}');
SELECT t.raises('T15c vue sauvegardée d un non-membre refusée',
  $q$ INSERT INTO saved_views(account_id, owner_user_id, name) VALUES (t.id('A'), t.id('u2'), 'X') $q$, '23503');
SELECT t.raises('T15d nom de vue unique par propriétaire et type',
  $q$ INSERT INTO saved_views(account_id, owner_user_id, name) VALUES (t.id('A'), t.id('u1'), 'Design') $q$, '23505');
SELECT t.ctx('B');
INSERT INTO account_members(account_id, user_id, role) VALUES (t.id('B'), t.id('u2'), 'owner');
SELECT t.ctx('A');
SELECT t.raises('T15e project_managers : utilisateur non membre du compte refusé',
  $q$ INSERT INTO project_managers(project_id, account_id, user_id) VALUES (t.id('pc'), t.id('A'), t.id('u2')) $q$, '23503');

-- ============================================================
-- T16 RLS (BR-32) : rôle applicatif, fermé par défaut, isolation, FORCE sur toutes les tables
-- ============================================================
SELECT t.ok('T16a app_user sans BYPASSRLS ni SUPERUSER',
  (SELECT NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'app_user'));
SELECT t.eq('T16b toute table à account_id (hors accounts) a RLS ENABLE+FORCE',
  (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'account_id' AND NOT a.attisdropped)
      AND c.relname <> 'accounts' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)), 0);
SELECT t.ok('T16c accounts a RLS activée', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.accounts'::regclass));
CREATE TEMP TABLE cnt AS
  SELECT (SELECT COUNT(*) FROM people WHERE account_id = t.id('A')) AS na,
         (SELECT COUNT(*) FROM people WHERE account_id = t.id('B')) AS nb;
GRANT SELECT ON cnt TO app_user;

SET LOCAL ROLE app_user;
SELECT set_config('app.account_id', '', true);
SELECT set_config('app.user_id', '', true);
SELECT t.eq('T16d sans app.account_id : aucune personne visible (fermé par défaut)', (SELECT COUNT(*) FROM people), 0);
SELECT t.eq('T16e sans app.account_id : aucune allocation',                          (SELECT COUNT(*) FROM allocations), 0);
SELECT t.eq('T16f sans app.account_id : aucun compte',                                (SELECT COUNT(*) FROM accounts), 0);
SELECT t.ctx('A');
SELECT t.eq('T16g contexte A : voit toutes les personnes de A', (SELECT COUNT(*) FROM people), (SELECT na FROM cnt));
SELECT t.eq('T16h contexte A : aucune personne de B',           (SELECT COUNT(*) FROM people WHERE account_id = t.id('B')), 0);
SELECT t.eq('T16i contexte A : voit uniquement son compte',     (SELECT COUNT(*) FROM accounts), 1);
SELECT t.raises('T16j contexte A : INSERT dans le compte B refusé (WITH CHECK)',
  $q$ INSERT INTO people(account_id, name) VALUES (t.id('B'), 'intrus') $q$, '42501');
SELECT t.eq('T16k contexte A : UPDATE d une ligne de B n affecte aucune ligne',
  t.rowcount($q$ UPDATE people SET name = 'pirate' WHERE account_id = t.id('B') $q$), 0);
SELECT t.eq('T16l contexte A : DELETE d une ligne de B n affecte aucune ligne',
  t.rowcount($q$ DELETE FROM people WHERE account_id = t.id('B') $q$), 0);
SELECT t.eq('T16m utilization(B) depuis le contexte A : aucune ligne',
  (SELECT COUNT(*) FROM utilization(t.id('B'), '2026-03-02', '2026-03-08')), 0);
SELECT t.ok('T16n utilization(A) fonctionne sous RLS',
  (SELECT COUNT(*) FROM utilization(t.id('A'), '2026-03-02', '2026-03-08')) > 0);
SELECT t.eq('T16p delete_log d un autre compte invisible', (SELECT COUNT(*) FROM delete_log WHERE account_id = t.id('B')), 0);
SELECT t.ctx('B');
SELECT t.eq('T16q contexte B : voit les personnes de B', (SELECT COUNT(*) FROM people), (SELECT nb FROM cnt));
SELECT t.eq('T16r contexte B : pas d allocation de A', (SELECT COUNT(*) FROM allocations WHERE account_id = t.id('A')), 0);
-- résolution des comptes d'un utilisateur avant de connaître le tenant
SELECT set_config('app.account_id', '', true);
SELECT set_config('app.user_id', t.id('u1')::text, true);
SELECT t.eq('T16s own_memberships : u1 voit ses appartenances sans contexte tenant', (SELECT COUNT(*) FROM account_members), 1);
SELECT t.ctx('A');
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.role', 'member', true);
SELECT t.raises('T16t verrou timesheet actif aussi pour app_user (member)',
  $q$ DELETE FROM logged_time WHERE person_id = t.id('hal') AND work_date = '2026-03-09' $q$, '42501');
RESET ROLE;

-- ============================================================
-- T17 Journal de changements (outbox temps réel) : seq par compte, sans trou, cascades, RLS, purge (BR-14)
-- ============================================================
SELECT t.mkaccount('C');
SELECT t.mkaccount('D');
SELECT set_config('app.user_id', t.id('u1')::text, true);
CREATE FUNCTION t.head(acc text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT seq FROM account_change_seq WHERE account_id = t.id(acc)), 0) $$;
SELECT t.eq('T17a compte neuf : journal vide', (SELECT COUNT(*) FROM change_log WHERE account_id = t.id('C')), 0);

INSERT INTO departments(account_id, name) VALUES (t.id('C'), 'Ops');
SELECT t.ok('T17b INSERT journalisé : seq 1, insert, version 1',
  (SELECT seq = 1 AND entity = 'departments' AND op = 'insert' AND version = 1 FROM change_log WHERE account_id = t.id('C') ORDER BY seq LIMIT 1));
UPDATE departments SET name = 'Ops 2' WHERE account_id = t.id('C');
SELECT t.ok('T17c UPDATE journalisé : seq 2, update, version 2 (row_version après trigger)',
  (SELECT seq = 2 AND op = 'update' AND version = 2 FROM change_log WHERE account_id = t.id('C') AND seq = 2));
SELECT t.ok('T17d changed_by = app.user_id', (SELECT changed_by = t.id('u1') FROM change_log WHERE account_id = t.id('C') AND seq = 2));
DELETE FROM departments WHERE account_id = t.id('C');
SELECT t.ok('T17e DELETE journalisé : seq 3, delete, version NULL',
  (SELECT seq = 3 AND op = 'delete' AND version IS NULL FROM change_log WHERE account_id = t.id('C') AND seq = 3));
SELECT t.ok('T17f seq contigu : 1..3 sans trou', (SELECT array_agg(seq ORDER BY seq) = ARRAY[1,2,3]::bigint[] FROM change_log WHERE account_id = t.id('C')));

SELECT t.raises('T17g écriture annulée : exception propagée',
  $q$ DO $x$ BEGIN INSERT INTO roles(account_id, name) VALUES (t.id('C'), 'annulé'); RAISE EXCEPTION 'annule'; END $x$ $q$);
SELECT t.eq('T17h écriture annulée : le compteur revient en arrière, aucun trou', t.head('C'), 3);
INSERT INTO roles(account_id, name) VALUES (t.id('C'), 'Lead');
SELECT t.eq('T17i écriture suivante : seq 4', (SELECT seq FROM change_log WHERE account_id = t.id('C') AND entity = 'roles'), 4);

INSERT INTO people(account_id, name) VALUES (t.id('D'), 'Zoé');
SELECT t.eq('T17j compteur indépendant par compte : D démarre à 1', t.head('D'), 1);
SELECT t.eq('T17k compteur de C inchangé par D', t.head('C'), 4);

-- Cascade (personne -> allocations) et ON DELETE SET NULL (département -> personnes) journalisés eux aussi.
INSERT INTO departments(account_id, name) VALUES (t.id('D'), 'Studio');
UPDATE people SET department_id = (SELECT id FROM departments WHERE account_id = t.id('D')) WHERE account_id = t.id('D');
INSERT INTO projects(account_id, name) VALUES (t.id('D'), 'P');
INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, hours_per_day)
  SELECT t.id('D'), (SELECT id FROM people WHERE account_id = t.id('D')), (SELECT id FROM projects WHERE account_id = t.id('D')), '2026-03-02', '2026-03-03', 4;
CREATE TEMP TABLE t17_before AS SELECT t.head('D') AS h;
DELETE FROM departments WHERE account_id = t.id('D');
SELECT t.ok('T17l ON DELETE SET NULL : la mise à jour de la personne est journalisée (version incrémentée)',
  (SELECT COUNT(*) FROM change_log WHERE account_id = t.id('D') AND seq > (SELECT h FROM t17_before) AND entity = 'people' AND op = 'update') = 1);
UPDATE t17_before SET h = t.head('D');
DELETE FROM people WHERE account_id = t.id('D');
SELECT t.ok('T17m cascade : la suppression de l allocation est journalisée avec celle de la personne',
  (SELECT COUNT(*) FILTER (WHERE entity = 'allocations' AND op = 'delete') = 1 AND COUNT(*) FILTER (WHERE entity = 'people' AND op = 'delete') = 1
     FROM change_log WHERE account_id = t.id('D') AND seq > (SELECT h FROM t17_before)));
CREATE TEMP TABLE t17_h AS SELECT t.head('D') AS h;
INSERT INTO phases(account_id, project_id, name) SELECT t.id('D'), id, 'ph' FROM projects WHERE account_id = t.id('D');
SELECT t.ok('T17n entités hors Schedule non journalisées (phases)',
  t.head('D') = (SELECT h FROM t17_h) AND NOT EXISTS (SELECT 1 FROM change_log WHERE entity = 'phases'));

SELECT t.ok('T17y les 8 entités du Schedule portent le trigger de journal',
  (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    WHERE tg.tgname = 'trg_92_change_log' AND NOT tg.tgisinternal)
  = ARRAY['allocations','departments','holidays','people','projects','roles','timeoff_types','timeoffs']);

-- RLS : le journal est cloisonné par compte et les triggers fonctionnent sous app_user.
SELECT set_config('app.user_id', '', true);
SET LOCAL ROLE app_user;
SELECT t.ctx('C');
SELECT t.eq('T17o app_user (contexte C) ne voit que le journal de C', (SELECT COUNT(DISTINCT account_id) FROM change_log), 1);
SELECT t.eq('T17p contexte C : voit les 4 entrées de C', (SELECT COUNT(*) FROM change_log), 4);
SELECT t.raises('T17q app_user ne peut pas écrire dans le journal d un autre compte',
  $q$ INSERT INTO change_log(account_id, seq, entity, entity_id, op, version) VALUES (t.id('D'), 999, 'people', 1, 'update', 2) $q$, '42501');
INSERT INTO departments(account_id, name) VALUES (t.id('C'), 'Sous RLS');
SELECT t.eq('T17r trigger sous app_user : écriture journalisée, seq 5', t.head('C'), 5);
SELECT t.ctx('D');
SELECT t.eq('T17s contexte D : journal de C invisible', (SELECT COUNT(*) FROM change_log WHERE account_id = t.id('C')), 0);
RESET ROLE;

-- Purge : rétention minimale de 72 h (BR-14), le curseur ne recule jamais, le seq continue.
SELECT t.raises('T17t rétention < 72 h refusée', $q$ SELECT purge_change_log(INTERVAL '71 hours') $q$, '22023');
UPDATE change_log SET changed_at = now() - INTERVAL '8 days' WHERE account_id = t.id('C') AND seq <= 3;
SELECT t.eq('T17u purge 7 jours : 3 lignes anciennes supprimées (C) ', (SELECT COUNT(*) FROM change_log WHERE account_id = t.id('C') AND changed_at < now() - INTERVAL '7 days'), 3);
SELECT t.eq('T17u2 purge : 3 lignes supprimées au total', purge_change_log(INTERVAL '7 days'), 3);
SELECT t.ok('T17v purge : lignes anciennes supprimées, récentes conservées',
  (SELECT COUNT(*) FILTER (WHERE seq <= 3) = 0 AND COUNT(*) FILTER (WHERE seq > 3) = 2 FROM change_log WHERE account_id = t.id('C')));
SELECT t.eq('T17w purged_through = plus grand seq purgé', (SELECT purged_through FROM account_change_seq WHERE account_id = t.id('C')), 3);
INSERT INTO roles(account_id, name) VALUES (t.id('C'), 'Après purge');
SELECT t.eq('T17x le seq continue après purge (6, pas de réutilisation)', t.head('C'), 6);

-- ============================================================
-- Bilan
-- ============================================================
SELECT COUNT(*) AS tests_passed FROM t.results;
ROLLBACK;
