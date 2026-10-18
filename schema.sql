-- ============================================================
-- Float Rebuild — Schéma PostgreSQL v1.1 (baseline 0001_init)
-- Cible : PostgreSQL >= 15 (NULLS NOT DISTINCT, ON DELETE SET NULL (col),
--         vues security_invoker)
-- Remplace schema.sql.txt (v1.0, archivé). Décisions : docs/decisions/ADR-001.
-- Revues sources : docs/review/archi-solution.md, archi-fonctionnel.md.
--
-- Conventions
--  * Dates métier = DATE calendaires du fuseau du compte (BR-18), jamais converties.
--  * people.work_days_hours : tableau de 7 éléments, STOCKAGE ISO, index 0 = lundi
--    (position 1 du tableau PG = lundi = ISODOW 1). L'affichage suit
--    accounts.week_start ; la conversion éventuelle (Float dimanche-first) se
--    fait UNIQUEMENT à la frontière API v3.
--  * Contexte de session posé par l'API au début de CHAQUE transaction
--    (SET LOCAL, jamais SET de session — compatible PgBouncer transaction) :
--      app.account_id  tenant courant (RLS)
--      app.user_id     utilisateur courant (audit created_by/modified_by/deleted_by)
--      app.role        owner|admin|project_manager|member|guest (verrou timesheet)
--  * Le rôle applicatif (app_user) n'est ni propriétaire ni BYPASSRLS.
--  * Sur-allocation : calculée et signalée, JAMAIS bloquée à l'insertion (BR-01).
--  * Aucun trigger/cascade ne supprime d'allocation sur congé (BR-04).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- ENUMS ----------
CREATE TYPE people_type        AS ENUM ('employee','contractor','placeholder');
CREATE TYPE allocation_mode    AS ENUM ('hours','percentage');
CREATE TYPE allocation_status  AS ENUM ('tentative','confirmed');
-- draft -> submitted (= verrouillé, BR-12) -> approved ; locked = clôture par échéance.
-- Déverrouillage : Owner/Admin uniquement, journalisé (unlocked_by/unlocked_at).
CREATE TYPE log_status         AS ENUM ('draft','submitted','approved','locked');
CREATE TYPE project_status     AS ENUM ('tentative','planned','in_progress','on_hold','completed','archived');
CREATE TYPE budget_type        AS ENUM ('hours_by_task','hours_by_person','money_by_task','money_by_person','fees');
CREATE TYPE timeoff_scope      AS ENUM ('full_day','partial');
-- Moitié de journée (ADR-004) : am < pm. Le début d'un congé est 'am' ou 'pm', la fin 'am' ou 'pm'.
CREATE TYPE day_half           AS ENUM ('am','pm');
CREATE TYPE approval_status    AS ENUM ('pending','approved','declined');
CREATE TYPE repeat_state_t     AS ENUM ('none','daily','weekly','monthly');
CREATE TYPE member_role        AS ENUM ('owner','admin','project_manager','member','guest');

-- ---------- CONTEXTE DE SESSION ----------
CREATE FUNCTION app_account_id() RETURNS BIGINT LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.account_id', true), '')::bigint $$;

CREATE FUNCTION app_user_id() RETURNS BIGINT LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::bigint $$;

-- Heures ouvrées d'un tableau work_days_hours pour une date (ISODOW 1..7 = lundi..dimanche).
CREATE FUNCTION wd_hours(p_wdh NUMERIC[], p_day DATE) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT p_wdh[EXTRACT(ISODOW FROM p_day)::int] $$;

-- ---------- IDENTITÉ (hors tenant) ----------
-- Une PERSONNE planifiée != un UTILISATEUR (compte de connexion).
-- users est global (pas d'account_id) : accès réservé au service d'authentification.
CREATE TABLE users (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        CITEXT NOT NULL UNIQUE,
  name         TEXT,
  locale       TEXT CHECK (locale IS NULL OR locale ~ '^[a-z]{2}(-[A-Z]{2})?$'), -- NULL = default_locale du compte (ADR-002)
  idp_subject  TEXT UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- ---------- TENANT ----------
CREATE TABLE accounts (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               TEXT    NOT NULL,
  timezone           TEXT    NOT NULL DEFAULT 'UTC',   -- validé contre pg_timezone_names côté app
  currency_code      CHAR(3) NOT NULL DEFAULT 'USD',
  default_locale     TEXT    NOT NULL DEFAULT 'fr' CHECK (default_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'), -- i18n (ADR-002) : BCP 47 court
  week_start         SMALLINT NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 1 AND 7), -- ISO : 1 = lundi .. 7 = dimanche ; affichage seulement
  default_work_hours NUMERIC(4,2) NOT NULL DEFAULT 8.00,
  -- Seuils de capacité du compte (Q5, 2026-10-18). under_percent : sous-allocation si charge < ce % de la capacité nette.
  -- Le seuil de sur-allocation est fixe à 100 % (BR-38) et n'est pas stocké ; les états restent hors des fonctions SQL.
  capacity_thresholds JSONB NOT NULL DEFAULT '{"under_percent": 80}'
    CONSTRAINT chk_capacity_thresholds CHECK (
      jsonb_typeof(capacity_thresholds) = 'object'
      AND capacity_thresholds ? 'under_percent'
      AND jsonb_typeof(capacity_thresholds -> 'under_percent') = 'number'
      AND (capacity_thresholds ->> 'under_percent')::numeric BETWEEN 1 AND 100),
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by        BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version        INT NOT NULL DEFAULT 1
);

-- Colonnes d'audit communes (copiées dans chaque table mutable) :
--   created_by, modified_by, created_at, modified_at, row_version

-- ---------- ORGANISATION ----------
CREATE TABLE departments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  UNIQUE (account_id, name),
  UNIQUE (id, account_id)
);

CREATE TABLE roles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,          -- ex. "Design Senior"
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  UNIQUE (account_id, name),
  UNIQUE (id, account_id)
);

-- Pas de recouvrement de validité pour un même nom de grille (cf. EXCLUDE).
CREATE TABLE rate_cards (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT   NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  valid_from    DATE   NOT NULL,
  valid_to      DATE   CHECK (valid_to IS NULL OR valid_to >= valid_from),
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by   BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version   INT NOT NULL DEFAULT 1,
  UNIQUE (id, account_id),
  CONSTRAINT ex_ratecard_validity EXCLUDE USING gist
    (account_id WITH =, name WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);

-- ---------- PERSONNES ----------
CREATE TABLE people (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  department_id   BIGINT,
  role_id         BIGINT,
  name            TEXT   NOT NULL,
  email           TEXT   CHECK (email IS NULL OR email ~* '^[^@]+@[^@]+\.[^@]+$'),
  people_type     people_type NOT NULL DEFAULT 'employee',
  country         CHAR(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),  -- ISO 3166-1 alpha-2 ; NULL = aucun férié pays
  -- ISO : index 0 = lundi ... index 6 = dimanche. Défaut lun-ven 8 h.
  work_days_hours NUMERIC(4,2)[] NOT NULL DEFAULT '{8,8,8,8,8,0,0}',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  avatar_url      TEXT,
  -- Précédence du coût (BR-09) : rates.person_id > rates.role_id (grille du projet) > people.cost_rate (dernier recours).
  cost_rate       NUMERIC(10,2) CHECK (cost_rate IS NULL OR cost_rate >= 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE = désactivée : retirée du Schedule et du calcul de capacité
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by     BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version     INT NOT NULL DEFAULT 1,
  UNIQUE (id, account_id),
  CONSTRAINT chk_people_wdh CHECK (
    array_length(work_days_hours, 1) = 7
    AND array_position(work_days_hours, NULL) IS NULL
    AND 0 <= ALL (work_days_hours) AND 24 >= ALL (work_days_hours)),
  FOREIGN KEY (department_id, account_id) REFERENCES departments(id, account_id) ON DELETE SET NULL (department_id),
  FOREIGN KEY (role_id,       account_id) REFERENCES roles(id, account_id)       ON DELETE SET NULL (role_id)
);
CREATE INDEX idx_people_account_active ON people (account_id) WHERE active;
CREATE INDEX idx_people_tags ON people USING GIN (tags);
CREATE INDEX idx_people_dept ON people (department_id);
CREATE INDEX idx_people_role ON people (role_id);
CREATE INDEX idx_people_sync ON people (account_id, modified_at);
CREATE UNIQUE INDEX uq_people_email ON people (account_id, lower(email)) WHERE email IS NOT NULL;

-- Taux : une ligne par rôle OU par personne (surcharge individuelle) dans une grille.
CREATE TABLE rates (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL,
  rate_card_id BIGINT NOT NULL,
  role_id      BIGINT,
  person_id    BIGINT,
  cost_rate    NUMERIC(10,2) NOT NULL CHECK (cost_rate >= 0),
  bill_rate    NUMERIC(10,2) NOT NULL CHECK (bill_rate >= 0),
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version  INT NOT NULL DEFAULT 1,
  CONSTRAINT chk_rates_target CHECK (role_id IS NOT NULL OR person_id IS NOT NULL),
  CONSTRAINT uq_rates UNIQUE NULLS NOT DISTINCT (rate_card_id, role_id, person_id),
  FOREIGN KEY (rate_card_id, account_id) REFERENCES rate_cards(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id,      account_id) REFERENCES roles(id, account_id)      ON DELETE CASCADE,
  FOREIGN KEY (person_id,    account_id) REFERENCES people(id, account_id)     ON DELETE CASCADE
);
CREATE INDEX idx_rates_role   ON rates (role_id)   WHERE role_id IS NOT NULL;
CREATE INDEX idx_rates_person ON rates (person_id) WHERE person_id IS NOT NULL;

-- ---------- ACCÈS & PERMISSIONS ----------
CREATE TABLE account_members (
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       member_role NOT NULL,
  person_id  BIGINT,                      -- NULL pour guests / admins non planifiés
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (person_id, account_id) REFERENCES people(id, account_id) ON DELETE SET NULL (person_id)
);
CREATE UNIQUE INDEX uq_members_person ON account_members (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_members_user ON account_members (user_id);

-- ---------- CLIENTS & PROJETS ----------
CREATE TABLE clients (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  short_name  TEXT,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  UNIQUE (id, account_id)
);

CREATE TABLE projects (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id          BIGINT,
  project_manager_id BIGINT,
  rate_card_id       BIGINT,
  name               TEXT   NOT NULL,
  project_code       TEXT,               -- référence externe, ex. 'job-12345/11'
  color              CHAR(7) NOT NULL DEFAULT '#3B82F6' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  start_date         DATE,
  end_date           DATE   CHECK (end_date IS NULL OR end_date >= start_date),
  -- BR-07/BR-20 : source unique du caractère tentatif = status ('tentative').
  -- Tentatif effectif d'une allocation = projet tentatif OU allocation tentative.
  status             project_status NOT NULL DEFAULT 'planned',
  currency_code      CHAR(3),            -- NULL = devise du compte
  -- Unité de budget_amount selon budget_type : hours_* = heures ; money_* et fees = devise du projet.
  budget_type        budget_type NOT NULL DEFAULT 'hours_by_task',
  budget_amount      NUMERIC(14,2) CHECK (budget_amount IS NULL OR budget_amount >= 0),
  non_billable       BOOLEAN NOT NULL DEFAULT FALSE,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  notes              TEXT,
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by        BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version        INT NOT NULL DEFAULT 1,
  UNIQUE (id, account_id),
  FOREIGN KEY (client_id,          account_id) REFERENCES clients(id, account_id)    ON DELETE SET NULL (client_id),
  FOREIGN KEY (project_manager_id, account_id) REFERENCES people(id, account_id)     ON DELETE SET NULL (project_manager_id),
  FOREIGN KEY (rate_card_id,       account_id) REFERENCES rate_cards(id, account_id) ON DELETE SET NULL (rate_card_id)
);
CREATE INDEX idx_projects_account ON projects (account_id, status);
CREATE INDEX idx_projects_client  ON projects (client_id);
CREATE INDEX idx_projects_pm      ON projects (project_manager_id);
CREATE INDEX idx_projects_sync    ON projects (account_id, modified_at);
CREATE UNIQUE INDEX uq_projects_code ON projects (account_id, project_code) WHERE project_code IS NOT NULL;

CREATE TABLE project_managers (
  project_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  user_id    BIGINT NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id)    REFERENCES account_members(account_id, user_id) ON DELETE CASCADE
);

CREATE TABLE phases (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL,
  project_id    BIGINT NOT NULL,
  name          TEXT   NOT NULL,
  start_date    DATE,
  end_date      DATE   CHECK (end_date IS NULL OR end_date >= start_date),
  status        project_status NOT NULL DEFAULT 'planned',
  color         CHAR(7),
  non_billable  BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  position      SMALLINT NOT NULL DEFAULT 0,
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by   BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version   INT NOT NULL DEFAULT 1,
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_phases_project ON phases (project_id);

CREATE TABLE project_tasks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL,
  project_id  BIGINT NOT NULL,
  phase_id    BIGINT,
  name        TEXT   NOT NULL,            -- ex. 'Design', 'Concepting'
  billable    BOOLEAN NOT NULL DEFAULT TRUE,
  position    SMALLINT NOT NULL DEFAULT 0,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id, project_id)   REFERENCES phases(id, project_id)   ON DELETE SET NULL (phase_id)
);
CREATE INDEX idx_ptasks_project ON project_tasks (project_id);
CREATE INDEX idx_ptasks_phase   ON project_tasks (phase_id) WHERE phase_id IS NOT NULL;

CREATE TABLE milestones (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL,
  project_id  BIGINT NOT NULL,
  phase_id    BIGINT,
  name        TEXT   NOT NULL,
  due_date    DATE   NOT NULL,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id, project_id)   REFERENCES phases(id, project_id)   ON DELETE CASCADE
);
CREATE INDEX idx_milestones_project ON milestones (project_id, due_date);

CREATE TABLE project_expenses (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL,
  project_id  BIGINT NOT NULL,
  name        TEXT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency    CHAR(3) NOT NULL DEFAULT 'USD',
  spent_on    DATE,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_expenses_project ON project_expenses (project_id);

-- Équipe projet. Le retrait (BR-10) supprime allocations/logs de la personne sur le projet :
-- opération applicative atomique résumé -> confirmation -> suppression (cf. team_removal_summary).
-- L'appartenance n'est PAS exigée pour allouer (question Q-07 ouverte).
CREATE TABLE project_team (
  project_id BIGINT NOT NULL,
  person_id  BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  PRIMARY KEY (project_id, person_id),
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (person_id,  account_id) REFERENCES people(id, account_id)   ON DELETE CASCADE
);
CREATE INDEX idx_pteam_person ON project_team (person_id);

-- Budgets multi-types (modélisés ; livrés en T3) : une ligne par tâche OU par personne.
CREATE TABLE project_budget_lines (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  project_id      BIGINT NOT NULL,
  project_task_id BIGINT,
  person_id       BIGINT,
  hours           NUMERIC(10,2) CHECK (hours IS NULL OR hours >= 0),
  amount          NUMERIC(14,2) CHECK (amount IS NULL OR amount >= 0),
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by     BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version     INT NOT NULL DEFAULT 1,
  CONSTRAINT chk_budget_line_target CHECK ((project_task_id IS NOT NULL)::int + (person_id IS NOT NULL)::int = 1),
  CONSTRAINT chk_budget_line_value  CHECK (hours IS NOT NULL OR amount IS NOT NULL),
  CONSTRAINT uq_budget_line UNIQUE NULLS NOT DISTINCT (project_id, project_task_id, person_id),
  FOREIGN KEY (project_id, account_id)      REFERENCES projects(id, account_id)      ON DELETE CASCADE,
  FOREIGN KEY (project_task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (person_id, account_id)       REFERENCES people(id, account_id)        ON DELETE CASCADE
);

-- Baselines versionnées (figées : jamais mises à jour).
CREATE TABLE project_baselines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL,
  project_id    BIGINT NOT NULL,
  version       INT    NOT NULL CHECK (version > 0),
  budget_type   budget_type NOT NULL,
  budget_amount NUMERIC(14,2),
  snapshot      JSONB  NOT NULL DEFAULT '{}',
  taken_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE
);

-- ---------- ALLOCATIONS (entité pivot du Schedule) ----------
-- Sémantique des répétitions (BR-25) : le bloc [start_date, end_date] est l'OCCURRENCE ;
-- il est répété par pas daily (+1 j) / weekly (+7 j) / monthly (+1 mois, clamp au dernier
-- jour du mois, calculé depuis la date d'origine) jusqu'à repeat_end_date INCLUSE
-- (les jours au-delà sont tronqués). Série non bornée interdite.
-- Aucune exclusion de chevauchement : plusieurs projets/jour et sur-allocation légitimes (BR-01).
CREATE TABLE allocations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  person_id       BIGINT NOT NULL,
  project_id      BIGINT NOT NULL,
  phase_id        BIGINT,
  project_task_id BIGINT,
  group_id        UUID,                    -- multi-personnes (people_ids API v3), BR-05/BR-26
  name            TEXT,                    -- label libre, ex. 'Concepting'
  notes           TEXT,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL CHECK (end_date >= start_date),
  mode            allocation_mode NOT NULL DEFAULT 'hours',
  hours_per_day   NUMERIC(4,2),            -- requis (et seul) si mode = 'hours'
  percent         NUMERIC(5,2),            -- requis (et seul) si mode = 'percentage' ; base = capacité BRUTE du jour (Q-04, décidé 2026-10-18)
  status          allocation_status NOT NULL DEFAULT 'confirmed',
  billable        BOOLEAN NOT NULL DEFAULT TRUE,
  priority        SMALLINT NOT NULL DEFAULT 0,
  repeat_state    repeat_state_t NOT NULL DEFAULT 'none',
  repeat_end_date DATE,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by     BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version     INT NOT NULL DEFAULT 1,
  UNIQUE (id, account_id),
  CONSTRAINT chk_alloc_mode CHECK (
    (mode = 'hours'      AND hours_per_day IS NOT NULL AND hours_per_day > 0 AND hours_per_day <= 24 AND percent IS NULL)
 OR (mode = 'percentage' AND percent IS NOT NULL AND percent > 0 AND percent <= 500 AND hours_per_day IS NULL)),
  CONSTRAINT chk_alloc_repeat CHECK (
    (repeat_state = 'none' AND repeat_end_date IS NULL)
 OR (repeat_state <> 'none' AND repeat_end_date IS NOT NULL AND repeat_end_date >= end_date)),
  FOREIGN KEY (person_id,  account_id) REFERENCES people(id, account_id)   ON DELETE CASCADE,
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id,        project_id) REFERENCES phases(id, project_id)        ON DELETE SET NULL (phase_id),
  FOREIGN KEY (project_task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE SET NULL (project_task_id)
);
CREATE INDEX idx_alloc_person_gist ON allocations USING gist
  (person_id, daterange(start_date, COALESCE(repeat_end_date, end_date), '[]'));
CREATE INDEX idx_alloc_project ON allocations (project_id, start_date);
CREATE INDEX idx_alloc_range   ON allocations (account_id, start_date);
CREATE INDEX idx_alloc_sync    ON allocations (account_id, modified_at);
CREATE INDEX idx_alloc_phase   ON allocations (phase_id)        WHERE phase_id IS NOT NULL;
CREATE INDEX idx_alloc_task    ON allocations (project_task_id) WHERE project_task_id IS NOT NULL;
CREATE INDEX idx_alloc_group   ON allocations (group_id)        WHERE group_id IS NOT NULL;

-- ---------- TEMPS RÉEL (timesheets) ----------
-- Suppression de personne/projet : RESTRICT (donnée de facturation). Désactiver / archiver à la place.
CREATE TABLE logged_time (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  person_id       BIGINT NOT NULL,
  project_id      BIGINT NOT NULL,
  phase_id        BIGINT,
  project_task_id BIGINT,
  allocation_id   BIGINT,                  -- origine du pré-remplissage (BR-11)
  work_date       DATE NOT NULL,
  hours           NUMERIC(4,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  billable        BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  status          log_status NOT NULL DEFAULT 'draft',
  submitted_at    TIMESTAMPTZ,
  approved_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  locked_at       TIMESTAMPTZ,
  unlocked_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  unlocked_at     TIMESTAMPTZ,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by     BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version     INT NOT NULL DEFAULT 1,
  FOREIGN KEY (person_id,  account_id) REFERENCES people(id, account_id)   ON DELETE RESTRICT,
  FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_id,        project_id) REFERENCES phases(id, project_id)        ON DELETE SET NULL (phase_id),
  FOREIGN KEY (project_task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE SET NULL (project_task_id),
  FOREIGN KEY (allocation_id,   account_id) REFERENCES allocations(id, account_id)   ON DELETE SET NULL (allocation_id)
);
CREATE INDEX idx_log_person_date ON logged_time (person_id, work_date);
CREATE INDEX idx_log_project     ON logged_time (project_id, work_date);
CREATE INDEX idx_log_range       ON logged_time (account_id, work_date);
CREATE INDEX idx_log_sync        ON logged_time (account_id, modified_at);
CREATE INDEX idx_log_status      ON logged_time (account_id, status) WHERE status <> 'draft';
CREATE UNIQUE INDEX uq_log_prefill ON logged_time (allocation_id, work_date) WHERE allocation_id IS NOT NULL;

-- ---------- CONGÉS & JOURS FÉRIÉS ----------
CREATE TABLE timeoff_types (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,            -- 'Vacances', 'Maladie', 'Formation'...
  deducted    BOOLEAN NOT NULL DEFAULT TRUE,  -- déduit de la capacité ?
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INT NOT NULL DEFAULT 1,
  UNIQUE (account_id, name),
  UNIQUE (id, account_id)
);

-- Congés `pending` comptés dans la capacité (BR-02/BR-29) ; `declined` ignorés.
CREATE TABLE timeoffs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  person_id       BIGINT NOT NULL,
  timeoff_type_id BIGINT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL CHECK (end_date >= start_date),
  scope           timeoff_scope NOT NULL DEFAULT 'full_day',
  -- scope = full_day : le congé couvre de la moitié start_half du premier jour à la moitié end_half
  -- du dernier. Défaut am..pm = journées entières ; (am, am) = matin ; (pm, pm) = après-midi ;
  -- (pm, am) sur plusieurs jours = « lundi après-midi à mercredi matin ». Une moitié déduit 50 %
  -- des heures ouvrées du jour. Pas d'heure de début/fin dans la journée (ADR-004).
  start_half      day_half NOT NULL DEFAULT 'am',
  end_half        day_half NOT NULL DEFAULT 'pm',
  hours_per_day   NUMERIC(4,2) CHECK (hours_per_day IS NULL OR (hours_per_day > 0 AND hours_per_day <= 24)),
  approval_status approval_status NOT NULL DEFAULT 'pending',
  notes           TEXT,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by     BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version     INT NOT NULL DEFAULT 1,
  CONSTRAINT chk_timeoff_hours CHECK (
    (scope = 'full_day' AND hours_per_day IS NULL) OR (scope = 'partial' AND hours_per_day IS NOT NULL)),
  CONSTRAINT chk_timeoff_halves CHECK (
    (end_date > start_date OR start_half <= end_half)
    AND (scope = 'full_day' OR (start_half = 'am' AND end_half = 'pm'))),
  -- Chevauchement interdit à la demi-journée : créneaux numérotés 2*jour (am) et 2*jour+1 (pm).
  CONSTRAINT ex_timeoff_no_overlap EXCLUDE USING gist
    (person_id WITH =,
     int4range((start_date - DATE '2000-01-01') * 2 + (start_half = 'pm')::int,
               (end_date   - DATE '2000-01-01') * 2 + (end_half   = 'pm')::int + 1) WITH &&)
    WHERE (scope = 'full_day' AND approval_status <> 'declined'),
  FOREIGN KEY (person_id,       account_id) REFERENCES people(id, account_id)        ON DELETE CASCADE,
  FOREIGN KEY (timeoff_type_id, account_id) REFERENCES timeoff_types(id, account_id) ON DELETE RESTRICT
);
CREATE INDEX idx_timeoff_person ON timeoffs (person_id, start_date, end_date);
CREATE INDEX idx_timeoff_range  ON timeoffs (account_id, start_date, end_date);
CREATE INDEX idx_timeoff_type   ON timeoffs (timeoff_type_id);

-- Férié : portée compte (country et department_id NULL), pays, ou département/équipe (BR-30).
-- hours_off NULL = journée entière ; sinon demi-journée / heures chômées.
CREATE TABLE holidays (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL,
  name          TEXT   NOT NULL,
  hdate         DATE   NOT NULL,
  country       CHAR(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  department_id BIGINT,
  hours_off     NUMERIC(4,2) CHECK (hours_off IS NULL OR (hours_off > 0 AND hours_off <= 24)),
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by   BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version   INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_holidays UNIQUE NULLS NOT DISTINCT (account_id, hdate, country, department_id, name),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id, account_id) REFERENCES departments(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_holidays_date ON holidays (account_id, hdate);

-- ---------- VUES SAUVEGARDÉES (FR-10) ----------
CREATE TABLE saved_views (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT NOT NULL,
  owner_user_id BIGINT NOT NULL,
  kind          TEXT   NOT NULL DEFAULT 'schedule' CHECK (kind IN ('schedule','projects','people','reports')),
  name          TEXT   NOT NULL,
  filters       JSONB  NOT NULL DEFAULT '{}',   -- départements, rôles, tags, projets, groupements, plage…
  shared        BOOLEAN NOT NULL DEFAULT FALSE, -- visible par tout le compte
  position      SMALLINT NOT NULL DEFAULT 0,
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  modified_by   BIGINT REFERENCES users(id) ON DELETE SET NULL DEFAULT app_user_id(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version   INT NOT NULL DEFAULT 1,
  UNIQUE (account_id, owner_user_id, kind, name),
  FOREIGN KEY (account_id, owner_user_id) REFERENCES account_members(account_id, user_id) ON DELETE CASCADE
);

-- ---------- AUDIT & SYNC ----------
-- Alimenté par trigger (cascades incluses), jamais par l'application (BR-14).
-- Pas de FK volontaire. Rétention >= 72 h ; purge conseillée à 7 jours (job).
CREATE TABLE delete_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL,
  entity       TEXT   NOT NULL,          -- nom de table : 'allocations','logged_time','timeoffs',...
  entity_id    BIGINT NOT NULL,
  deleted_by   BIGINT,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_delete_log_cursor ON delete_log (account_id, id);              -- curseur monotone de sync
CREATE INDEX idx_delete_log        ON delete_log (account_id, entity, deleted_at);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Audit : modified_at (horloge réelle, réduit le risque de lignes manquées par
-- modified_since), modified_by (contexte app.user_id), row_version (verrou optimiste).
CREATE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.modified_at  := clock_timestamp();
  NEW.modified_by  := COALESCE(app_user_id(), NEW.modified_by);
  NEW.row_version  := OLD.row_version + 1;
  RETURN NEW;
END $$;

-- BR-14 : journalise toute suppression (y compris cascades) dans delete_log.
CREATE FUNCTION log_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO delete_log (account_id, entity, entity_id, deleted_by)
  VALUES (OLD.account_id, TG_TABLE_NAME, OLD.id, app_user_id());
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','departments','roles','rate_cards','rates','people','clients','projects',
      'phases','project_tasks','milestones','project_expenses','project_budget_lines','allocations',
      'logged_time','timeoff_types','timeoffs','holidays','saved_views'] LOOP
    EXECUTE format('CREATE TRIGGER trg_90_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['departments','roles','people','clients','projects','phases','project_tasks',
      'milestones','project_expenses','allocations','logged_time','timeoff_types','timeoffs','holidays'] LOOP
    EXECUTE format('CREATE TRIGGER trg_91_delete_log AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION log_delete()', t);
  END LOOP;
END $$;

-- BR-12 / BR-28 / BR-27 portés par la base.
--  * Une ligne non-draft est immuable (UPDATE/DELETE) sauf rôle app.role = owner|admin.
--    Fermé par défaut : app.role absent => non admin.
--  * Seules transitions non-admin : draft -> draft | submitted. Un INSERT non-admin est draft.
--  * Déverrouillage admin (non-draft -> draft) : unlocked_by / unlocked_at renseignés.
--  * Exception : les remises à NULL de références (suppression d'une phase, tâche, allocation,
--    utilisateur : ON DELETE SET NULL) restent possibles sur une ligne verrouillée.
--  * Total par personne et par jour <= 24 h. Un placeholder ne logue pas de temps.
--  * Non couvert (granularité de période ouverte, Q-06) : ajout dans une période verrouillée.
CREATE FUNCTION guard_logged_time() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_admin boolean := COALESCE(current_setting('app.role', true), '') IN ('owner','admin');
  v_refs  text[]  := ARRAY['allocation_id','phase_id','project_task_id','created_by','modified_by','approved_by','unlocked_by'];
  v_ign   text[]  := ARRAY['modified_at','row_version'] || ARRAY['allocation_id','phase_id','project_task_id','created_by','modified_by','approved_by','unlocked_by'];
  c       text;
  v_only_nulling boolean := TRUE;
  v_day_total numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT v_admin THEN
      RAISE EXCEPTION 'logged_time % verrouillé (BR-12) : suppression refusée', OLD.id USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NOT v_admin THEN
      RAISE EXCEPTION 'logged_time : création directe en statut % refusée (BR-12)', NEW.status USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND people_type = 'placeholder') THEN
      RAISE EXCEPTION 'logged_time : un placeholder ne peut pas loguer de temps (BR-27)' USING ERRCODE = '23514';
    END IF;
  ELSE -- UPDATE
    IF OLD.status <> 'draft' AND NOT v_admin THEN
      FOREACH c IN ARRAY v_refs LOOP
        IF (to_jsonb(NEW) -> c) IS DISTINCT FROM 'null'::jsonb
           AND (to_jsonb(NEW) -> c) IS DISTINCT FROM (to_jsonb(OLD) -> c) THEN
          v_only_nulling := FALSE;
        END IF;
      END LOOP;
      IF NOT v_only_nulling OR (to_jsonb(NEW) - v_ign) IS DISTINCT FROM (to_jsonb(OLD) - v_ign) THEN
        RAISE EXCEPTION 'logged_time % verrouillé (BR-12) : modification refusée', OLD.id USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT v_admin AND NEW.status NOT IN ('draft','submitted') THEN
      RAISE EXCEPTION 'logged_time : transition vers % réservée à Owner/Admin', NEW.status USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN   -- déverrouillage admin, audité
      NEW.unlocked_by := app_user_id();
      NEW.unlocked_at := now();
      NEW.submitted_at := NULL;
      NEW.locked_at := NULL;
    END IF;
  END IF;

  IF NEW.status IN ('submitted','approved','locked') AND NEW.submitted_at IS NULL THEN
    NEW.submitted_at := now();
  END IF;
  IF NEW.status = 'locked' AND NEW.locked_at IS NULL THEN
    NEW.locked_at := now();
  END IF;

  SELECT COALESCE(SUM(hours), 0) INTO v_day_total
  FROM logged_time
  WHERE person_id = NEW.person_id AND work_date = NEW.work_date AND id IS DISTINCT FROM NEW.id;
  IF v_day_total + NEW.hours > 24 THEN
    RAISE EXCEPTION 'logged_time : total > 24 h pour la personne % le % (BR-28)', NEW.person_id, NEW.work_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_01_guard BEFORE INSERT OR UPDATE OR DELETE ON logged_time
  FOR EACH ROW EXECUTE FUNCTION guard_logged_time();

-- ============================================================
-- CALCULS CŒUR (BR-01..BR-03, BR-07, BR-13, BR-38) — réécriture v1.1
-- Signatures homogènes (account_id, from, to), plage bornée à 400 jours.
-- Référence de parité avec le moteur TS @app/rules (ADR-005).
-- ============================================================

-- L'allocation (occurrence de base [a_start,a_end], répétition) couvre-t-elle le jour d ?
-- Suppose d >= a_start et d <= fin de série (borne appliquée par l'appelant).
CREATE FUNCTION allocation_covers_day(a_start DATE, a_end DATE, a_repeat repeat_state_t, d DATE)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE a_repeat
    WHEN 'none'    THEN d BETWEEN a_start AND a_end
    WHEN 'daily'   THEN d >= a_start
    WHEN 'weekly'  THEN d >= a_start AND (d - a_start) % 7 <= (a_end - a_start)
    WHEN 'monthly' THEN d >= a_start AND EXISTS (
      SELECT 1
      FROM generate_series(0, ((EXTRACT(YEAR FROM d) - EXTRACT(YEAR FROM a_start)) * 12
                               + EXTRACT(MONTH FROM d) - EXTRACT(MONTH FROM a_start))::int) k
      WHERE d BETWEEN (a_start + make_interval(months => k))::date
                  AND (a_end   + make_interval(months => k))::date)
  END
$$;

-- Charge planifiée par personne et par jour OUVRÉ (work_days_hours > 0, BR-01).
-- Les jours non ouvrés sont ignorés ; fériés et congés NE retirent PAS la charge
-- (elle apparaît en sur-allocation). Tentatif effectif = allocation OU projet tentatif (BR-20).
-- Facturable = allocation ET projet/phase/tâche facturables ET confirmé (BR-21, BR-13).
-- mode percentage : % x heures ouvrées BRUTES du jour (base brute décidée, Q-04 ; l'alerte compare à la capacité nette, BR-38).
CREATE FUNCTION daily_planned_load(p_account_id BIGINT, p_from DATE, p_to DATE)
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
    SELECT wd_hours(pe.work_days_hours, g.day) AS wd
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

-- Capacité nette : UNE ligne par personne ACTIVE et par jour (même fériés/week-ends, capacité 0).
--   férié (compte / pays de la personne / département) : prioritaire, hours_off NULL = journée entière
--   congés : types `deducted`, statut <> declined, cumulés, plafonnés au reste du jour (pas de double déduction)
CREATE FUNCTION daily_capacity(p_account_id BIGINT, p_from DATE, p_to DATE)
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
  CROSS JOIN LATERAL (SELECT wd_hours(pe.work_days_hours, d.day) AS h) wd
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

-- Utilisation (remplace la vue v_utilization, qui ne pouvait pas être paramétrée).
--  * overtime_hours = max(planifié - capacité nette, 0) (BR-03/BR-38) : > 0 même à capacité 0.
--  * utilization NULL si capacité 0 ; is_overbooked reste TRUE si planifié > capacité (jamais masqué).
--  * Inclut les heures tentatives dans planned_hours (décomposées dans tentative_hours) ; Q-01 décidé 2026-10-18.
--  * Personnes inactives exclues (capacité calculée pour les actives seulement).
CREATE FUNCTION utilization(p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (person_id BIGINT, day DATE, capacity_hours NUMERIC, planned_hours NUMERIC,
               tentative_hours NUMERIC, billable_hours NUMERIC, overtime_hours NUMERIC,
               utilization NUMERIC, is_overbooked BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT c.person_id, c.day, c.capacity_hours,
         COALESCE(l.planned_hours, 0), COALESCE(l.tentative_hours, 0), COALESCE(l.billable_hours, 0),
         GREATEST(COALESCE(l.planned_hours, 0) - c.capacity_hours, 0),
         CASE WHEN c.capacity_hours = 0 THEN NULL
              ELSE COALESCE(l.planned_hours, 0) / c.capacity_hours END,
         COALESCE(l.planned_hours, 0) > c.capacity_hours
  FROM daily_capacity(p_account_id, p_from, p_to) c
  LEFT JOIN daily_planned_load(p_account_id, p_from, p_to) l
         ON l.person_id = c.person_id AND l.day = c.day
$$;

-- BR-10 : récapitulatif à présenter avant le retrait d'une personne de l'équipe projet.
-- can_remove = FALSE si des logs verrouillés/approuvés/soumis existent (conflit BR-10/BR-12, L-06).
CREATE FUNCTION team_removal_summary(p_project_id BIGINT, p_person_id BIGINT)
RETURNS TABLE (allocation_count BIGINT, first_allocation DATE, last_allocation DATE,
               log_count BIGINT, log_hours NUMERIC, locked_log_count BIGINT, can_remove BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT a.n, a.first_day, a.last_day, l.n, l.h, l.locked, l.locked = 0
  FROM (SELECT COUNT(*) AS n, MIN(start_date) AS first_day,
               MAX(COALESCE(repeat_end_date, end_date)) AS last_day
        FROM allocations WHERE project_id = p_project_id AND person_id = p_person_id) a,
       (SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h,
               COUNT(*) FILTER (WHERE status <> 'draft') AS locked
        FROM logged_time WHERE project_id = p_project_id AND person_id = p_person_id) l
$$;

-- ============================================================
-- RLS : isolation tenant (fermée par défaut : variable absente => aucune ligne).
-- Toute table portant account_id. Le rôle applicatif n'est pas propriétaire et sans BYPASSRLS.
-- Les autorisations par rôle (RBAC) restent dans l'API (authorize() unique), pas dans la RLS.
-- ============================================================
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name
           FROM information_schema.columns c
           JOIN information_schema.tables tb
             ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
           WHERE c.table_schema = 'public' AND c.column_name = 'account_id' AND c.table_name <> 'accounts'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id())$p$, t);
  END LOOP;
END $$;

-- accounts : ENABLE sans FORCE, afin que le rôle propriétaire (provisionnement de compte) puisse insérer.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts USING (id = app_account_id()) WITH CHECK (id = app_account_id());

-- Résolution des comptes d'un utilisateur à la connexion (avant de connaître app.account_id).
CREATE POLICY own_memberships ON account_members FOR SELECT USING (user_id = app_user_id());

-- ============================================================
-- RÔLE APPLICATIF (sans LOGIN ici : le déploiement ajoute LOGIN + mot de passe)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app_user;

-- ============================================================
-- NOTES D'ARBITRAGE (ADR-001)
-- 1. BR-01 : sur-allocation calculée (utilization()), jamais bloquée à l'insertion.
-- 2. BR-04 : aucun trigger/cascade ne touche aux allocations sur congé (avertir + replanifier côté app).
-- 3. Facturation du produit : hors périmètre (ADR-004) ; aucune notion de plan ni de siège.
-- 4. Heures stockées en décimal ; arrondi d'affichage côté client.
-- 5. Ouvert (hors baseline) : heures tentatives dans la charge (Q-01) et base du % (Q-04) sont décidées (2026-10-18) ;
--    reste ouverte : granularité/verrou des périodes de timesheet (Q-05), 
--    change_log (outbox temps réel), api_tokens et historisation à effet daté (BR-19).
-- ============================================================
