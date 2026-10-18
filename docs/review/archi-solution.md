# Revue Architecte Solution Senior — Rebuild Float.com

Périmètre : dossier de fondamentaux (v1.0) + `schema.sql.txt` (v1.0) + défauts connus de `CLAUDE.md`. Aucun fichier existant modifié.
Légende : **[BLOQUANT]** empêche de démarrer/livrer correctement · **[IMPORTANT]** à traiter avant le MVP (T1) · **[CONFORT]** amélioration.

---

## 1. Stack et architecture cible

### 1.1 Vue d'ensemble (recommandation)

| Couche | Choix | Justification |
|---|---|---|
| Langage | **TypeScript partout** (monorepo pnpm + Turborepo) | Types partagés client/serveur, très bon support des agents de code, moteur de règles partageable |
| Front | React + Vite, store normalisé (Zustand ou TanStack Query + store d'entités), **Schedule en canvas 2D + overlay DOM** (popovers, a11y) | Voir §1.3 |
| API | Fastify + Zod → **OpenAPI généré** (source de vérité du contrat) | Contrat testable, DTO v3 isolés du domaine |
| Accès DB | SQL-first : **Kysely** (+ kysely-codegen) ; migrations SQL pures | Le schéma est déjà écrit en SQL ; pas d'ORM qui cache RLS/contraintes |
| DB | **PostgreSQL ≥ 16** (≥ 15 requis : `NULLS NOT DISTINCT`, `ON DELETE SET NULL (col)`), extensions `btree_gist`, `citext` | |
| Temps réel | **WebSocket** (même service API) + fan-out **Redis pub/sub**, source d'événements = table `change_log` (outbox) | Voir §1.2 |
| Cache | Redis, clés préfixées `t:{account_id}:`; invalidation pilotée par les événements outbox | « Cache par tenant » du dossier |
| Jobs | pg-boss (ou BullMQ) : purge delete_log, rappels timesheet, e-mails, webhooks | Pas de broker de plus au début |
| Auth | OIDC/OAuth2, sessions cookie httpOnly (SPA) + tokens Bearer (API v3) ; SSO SAML/OIDC via WorkOS/Keycloak (Pro, BR-17) | Ne pas écrire de crypto/SSO maison |

### 1.2 Temps réel (< 1 s) — **[IMPORTANT]**

- Flux : `mutation REST` → transaction unique {écriture métier + insertion `change_log(account_id, seq, entity, entity_id, op, version)`} → commit → publication Redis → WS vers les clients de l'account → patch du store client.
- Budgets : ack mutation p95 < 150 ms ; commit→réception client p95 < 500 ms (marge de 500 ms pour réseau/rendu) ; UI optimiste < 100 ms.
- **Rattrapage** : le client mémorise `last_seq` ; à la reconnexion il rejoue `GET /changes?since=seq` (sinon événements perdus = planning périmé, l'anti-thèse du produit). Même mécanisme que `delete_log` (§1.5).
- Concurrence : colonne `row_version` (optimistic locking, `If-Match`/409) ; id de mutation client pour dédoublonner l'écho de ses propres écritures. LWW seulement sur champs disjoints.
- **Filtrage d'autorisation à la diffusion** : un Member ne voit que ses assignations (FR-09) — le fan-out doit appliquer le même `authorize()` que le REST, sinon fuite par WS **[BLOQUANT]** à concevoir dès le départ (canaux par account + filtre par abonné).
- SSE suffirait pour le push seul, mais WS retenu (présence, curseurs/édition concurrente à venir en V1.x).

### 1.3 Virtualisation 300+ personnes × 12 mois — **[IMPORTANT]**

Ordre de grandeur : 300 × 365 = 110 k cellules, ~5–20 k allocations/an/tenant : trivial pour PG, le goulot est le **rendu** et le **recalcul de capacité**.
- Virtualisation 2 axes (lignes visibles + fenêtre de dates ± tampon) ; rendu canvas des blocs et barres de capacité, DOM uniquement pour la sélection/popover/poignées ; hit-testing par index spatial par ligne (tableaux triés par `start_date`).
- Chargement par fenêtre : `GET /schedule?from&to&people=…` (endpoint agrégé, payload colonnaire compact, ETag, brotli) ; pas de pagination 100 par 100 sur ce chemin.
- Moteur de capacité **pur et partagé** (package `@app/rules`, TS) exécuté en Web Worker pour les indicateurs live (< 100 ms) ; les fonctions SQL servent aux rapports/exports. **Tests de parité** TS↔SQL obligatoires (ADR-005).
- Budgets perf en CI : 300 personnes × 52 sem. — premier rendu < 1,5 s, scroll 60 fps, drag sans frame > 16 ms (prototype chantier (c) du dossier).

### 1.4 Multi-tenant avec RLS — **[BLOQUANT]**

- Schéma partagé, `account_id` sur **toutes** les tables (aujourd'hui absent de `phases`, `project_tasks`, `milestones`, `project_expenses`, `project_team`, `rates`), RLS `ENABLE` + `FORCE`, rôle applicatif sans `BYPASSRLS` ni propriétaire des tables.
- Contexte tenant : `SET LOCAL app.account_id = …` en début de chaque transaction (compatible PgBouncer mode transaction). Jamais de `SET` de session.
- Défense en profondeur : FK composites `(id, account_id)` pour interdire les références inter-tenants (§2.3), tests automatisés « tenant A ne lit/écrit/référence pas tenant B » sur chaque table (généré depuis `information_schema`).
- Évolution Enterprise : schéma/DB dédié possible plus tard sans changer le code (même `account_id`).

### 1.5 AuthN / AuthZ / permissions — **[BLOQUANT]** (aucune table utilisateur dans le schéma)

- Manque : `users`, `account_members(role)`, lien `people.user_id`/`account_members.person_id`, PM par projet, tokens API. Une *personne planifiée* (siège, BR-15) ≠ un *utilisateur* (compte de connexion) ; les Guests sont des users sans person.
- Rôles : Owner, Admin, Project Manager (par projet), Member (lecture limitée à ses assignations, saisie de son temps), Guest (lecture seule). RBAC avec une **seule** fonction `authorize(actor, action, resource)` côté API (et réutilisée pour WS), matrice de test exhaustive rôle × action. RLS ne porte que l'isolation tenant (une RLS par rôle serait ingérable avec le pooling).
- Actions sensibles : déverrouillage timesheet (Admin/Owner, BR-12), suppression/rétrogradation, gestion des sièges, tokens API : journalisées (audit).

### 1.6 API v3 compatible — **[IMPORTANT]**

- Couche **adaptateur** distincte du domaine : noms v3 (`people_id`, allocation = `task`, `people_ids` multi-personnes, statuts entiers, `repeat_state` numérique, `modified_since`, tri `-champ`, pagination page + en-têtes, `/delete-log`). **À valider champ par champ contre developer.float.com** (aucune vérification faite ici) ; contract tests sur fixtures.
- `people_ids` multiples : éclater en N lignes `allocations` liées par `group_id` (§2.3), renvoyer l'agrégat côté API ; BR-05 (congé n'impacte que sa ligne) en découle.
- **Convention `work_days_hours`** : voir §2.1 bug B2. À trancher avant d'écrire l'adaptateur.
- Versionnage `/v3` figé ; l'API interne du SPA peut évoluer librement. Rate limiting par token (en-têtes standard), idempotency-key sur POST.

### 1.7 Sync et `delete_log` (BR-14) — **[IMPORTANT]**

- `delete_log` doit être alimenté par **trigger** (suppressions en cascade incluses) et pas « par l'application » (§2.5). Rétention ≥ 72 h : purge pg-boss à 7 jours conseillé.
- Curseur de sync : `modified_at = now()` est l'heure de **début de transaction** → des lignes committées tardivement peuvent être manquées par `modified_since`. Utiliser un curseur monotone (`change_log.seq`, ou `delete_log.id`) pour le flux interne ; garder `modified_since` pour la compat v3 avec marge de recul (ex. −5 s côté serveur).

### 1.8 Performance backend — **[CONFORT]**

Requêtes de plage via index GiST sur `daterange` (§2.4) ; `pg_stat_statements` ; pas de N+1 (DataLoader) ; fonctions de capacité bornées à ≤ 400 jours ; matérialiser (`capacity_cache` par personne/jour) seulement si les rapports 12 mois dépassent le budget (mesurer d'abord).

### 1.9 Observabilité — **[IMPORTANT]**

OpenTelemetry (HTTP, SQL, WS) → Grafana/Tempo/Loki ou équivalent managé ; Sentry front+back ; logs structurés avec `account_id`, `user_id`, `request_id`. SLI clés : latence commit→réception (RUM : horodatage serveur dans l'événement), clients WS connectés, p95 `/schedule`, taux 409, erreurs RLS, lag purge delete_log. Alertes sur SLO (99,9 % dispo API, push p95 < 1 s).

### 1.10 Déploiement — **[CONFORT]**

Conteneurs ; démarrage simple (Fly.io/Render/ECS, 2+ instances stateless derrière LB, WS sans sticky grâce à Redis) ; PG managé avec PITR, **région UE** (RGPD/SOC2 cités au dossier) ; SPA sur CDN ; IaC OpenTofu/Terraform ; environnements : preview par PR (DB éphémère) → staging → prod ; Kubernetes seulement si le besoin apparaît. Migrations expand/contract avec `lock_timeout` et `CREATE INDEX CONCURRENTLY`.

---

## 2. Revue détaillée du schéma SQL (`schema.sql.txt`)

### 2.1 Bugs

**B1 [BLOQUANT] `COLESCE`** (`daily_capacity`, l.339) → `COALESCE`. Le schéma ne se charge pas.

**B2 [BLOQUANT] Convention des jours de semaine — le point du CLAUDE.md est à nuancer.**
- En SQL, `work_days_hours[EXTRACT(ISODOW …)]` est **correct** pour « index 0 = lundi » : les tableaux PG sont indexés à partir de 1 et ISODOW lundi = 1, donc `[1]` = premier élément = lundi. Le décalage n'existe que **côté application** (tableaux JS 0-based ; `Date.getDay()` donne dimanche = 0 → piège).
- **Vrai problème** : le dossier donne `[0,4,4,4,0,0,0]` = « 4 h du lundi au mercredi ». C'est vrai seulement si l'index 0 = **dimanche**. Avec « index 0 = lundi » (commentaire du schéma), le même tableau signifie mardi–jeudi. Le défaut `{0,8,8,8,8,8,0}` est symétrique, donc le bug resterait invisible dans les tests par défaut. Float semble utiliser dimanche en premier (à vérifier dans la doc v3) → risque de capacité fausse silencieuse et de non-compatibilité API.
- Décision recommandée (ADR-006) : stockage interne **lundi-premier / ISO** (cohérent avec `ISODOW`, `week_start`), **conversion unique à la frontière API v3** (adaptateur), tests avec un tableau asymétrique (`{0,4,4,4,0,0,0}` ≠ `{4,4,4,0,0,0,0}`). Corriger l'exemple du dossier et le commentaire du schéma. Ajouter `CHECK` de taille (le `[7]` de PG n'est **pas** appliqué) :

```sql
ALTER TABLE people ADD CONSTRAINT chk_people_wdh CHECK (
  array_length(work_days_hours,1) = 7
  AND array_position(work_days_hours, NULL) IS NULL
  AND 0 <= ALL (work_days_hours) AND 24 >= ALL (work_days_hours));
```

**B3 [BLOQUANT] `people.country` manquante** (référencée par `daily_capacity`, jours fériés pays). Aucune colonne `country` ; en plus BR-02 demande « pays + équipe » : il manque aussi les *team holidays*.
```sql
ALTER TABLE people   ADD COLUMN country CHAR(2);           -- ISO 3166-1 alpha-2, NULL = pas de férié pays
ALTER TABLE holidays ADD COLUMN department_id BIGINT REFERENCES departments(id) ON DELETE CASCADE; -- NULL = tout le compte
```

**B4 [BLOQUANT] `v_utilization` inutilisable** : appelle `daily_capacity(0,NULL,NULL)` alors que `daily_capacity` prend un `person_id` (et non un `account_id`) et que `daily_planned_load` prend un `account_id` ; signatures incohérentes, `generate_series(NULL…)` → vide, une vue ne peut pas être paramétrée. **Correctif** : signatures homogènes `(account_id, from, to)` et une **fonction** `utilization()` à la place de la vue (voir 2.2).

**B5 [BLOQUANT] `daily_planned_load` produit des résultats faux** :
1. `ELSE (end_date - start_date + 1)::text::interval` : `'5'::interval` = 5 **secondes** ; le pas « none » est faux.
2. Pour une allocation répétée, la borne haute est `LEAST(a.end_date, repeat_end_date, p_to)` : `end_date` plafonne la répétition, donc elle ne se répète jamais au-delà de la 1ʳᵉ occurrence ; et seules les dates de *début* d'occurrence sont émises (les jours suivants du bloc sont perdus).
3. `generate_series(date, date, interval)` retourne du `timestamptz` (dépend du fuseau de session) → utiliser `timestamp`/entiers.
4. Pas de filtre jour ouvré (BR-01 : on ne pose que sur jour ouvré) → heures planifiées le week-end.
5. Pas de ventilation tentatif/confirmé (BR-07) ni facturable (BR-13) ; tentatif = `allocations.status` **ou** `projects.tentative`/`status='tentative'` (redondance, voir 2.3).

**B6 [IMPORTANT] `daily_capacity`** : (a) les jours fériés sont **exclus** (`NOT EXISTS`) au lieu de renvoyer capacité 0 → avec un `LEFT JOIN` depuis la capacité, les allocations posées un férié disparaissent des rapports au lieu d'apparaître en surtemps ; (b) `LIMIT 1` sans `ORDER BY` : plusieurs congés partiels le même jour ne sont pas cumulés ; (c) fonction par personne : inutilisable pour 300 personnes sans N appels ; (d) congé `pending` déduit (cohérent BR-02 « posés », à documenter).

**B7 [IMPORTANT] Note d'arbitrage n°3** (« siège = work_days_hours > 0 ») contredit BR-15 (toute personne sur le Schedule, active) → utiliser `active` (+ vue `v_billable_seats`).

**B8 [IMPORTANT] `chk_alloc_hours`** : n'interdit pas `percent` renseigné en mode `hours` (donnée incohérente, `COALESCE(hours_per_day, …)` choisirait silencieusement) ; `chk_alloc_repeat` laisse passer `repeat_end_date NULL` avec répétition (borne infinie non gérée).

**B9 [IMPORTANT] `rates` / `holidays` : `UNIQUE` avec NULL** : `NULL` distincts → doublons possibles `(rate_card, role, NULL)` et férié global `(account, date, NULL, name)`. `rates.person_id` n'a pas de FK ; `role_id` et `person_id` peuvent être tous deux NULL.

### 2.2 Correctifs SQL — fonctions de calcul (remplacent l. 303-367)

```sql
-- Helper : heures ouvrées d'une personne pour une date (convention lundi-premier, ISODOW 1..7)
CREATE OR REPLACE FUNCTION wd_hours(p_wdh NUMERIC[], p_day DATE)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT p_wdh[EXTRACT(ISODOW FROM p_day)::int]
$$;

CREATE OR REPLACE FUNCTION daily_planned_load(p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (person_id BIGINT, day DATE,
               planned_hours NUMERIC, tentative_hours NUMERIC, billable_hours NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT a.person_id, g.day,
         SUM(h.v),
         SUM(h.v) FILTER (WHERE a.status = 'tentative' OR pr.tentative OR pr.status = 'tentative'),
         SUM(h.v) FILTER (WHERE a.billable AND NOT pr.non_billable
                            AND a.status = 'confirmed' AND NOT pr.tentative)
  FROM allocations a
  JOIN people   pe ON pe.id = a.person_id
  JOIN projects pr ON pr.id = a.project_id
  CROSS JOIN LATERAL (
    SELECT d::date AS day
    FROM generate_series(
           GREATEST(a.start_date, p_from)::timestamp,
           LEAST(CASE WHEN a.repeat_state = 'none' THEN a.end_date
                      ELSE a.repeat_end_date END, p_to)::timestamp,
           interval '1 day') d
  ) g
  CROSS JOIN LATERAL (
    SELECT CASE a.mode WHEN 'hours' THEN a.hours_per_day
                       ELSE wd_hours(pe.work_days_hours, g.day) * a.percent / 100 END AS v
  ) h
  WHERE a.account_id = p_account_id
    AND a.start_date <= p_to
    AND (CASE WHEN a.repeat_state = 'none' THEN a.end_date ELSE a.repeat_end_date END) >= p_from
    AND wd_hours(pe.work_days_hours, g.day) > 0                      -- BR-01 : jour ouvré seulement
    AND CASE a.repeat_state                                            -- l'occurrence couvre-t-elle le jour ?
          WHEN 'none'    THEN TRUE
          WHEN 'daily'   THEN TRUE
          WHEN 'weekly'  THEN (g.day - a.start_date) % 7 <= (a.end_date - a.start_date)
          WHEN 'monthly' THEN EXISTS (
            SELECT 1 FROM generate_series(0,
                   ((EXTRACT(YEAR FROM g.day) - EXTRACT(YEAR FROM a.start_date)) * 12
                    + EXTRACT(MONTH FROM g.day) - EXTRACT(MONTH FROM a.start_date))::int) k
            WHERE g.day BETWEEN (a.start_date + k * interval '1 month')::date
                            AND (a.end_date   + k * interval '1 month')::date)
        END
  GROUP BY a.person_id, g.day
$$;

CREATE OR REPLACE FUNCTION daily_capacity(p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (person_id BIGINT, day DATE, base_hours NUMERIC, capacity_hours NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT pe.id, d.day, wd.h,
         CASE WHEN hol.is_holiday THEN 0
              ELSE GREATEST(wd.h - COALESCE(t.hours, 0), 0) END
  FROM people pe
  CROSS JOIN LATERAL (SELECT g::date AS day
                      FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
  CROSS JOIN LATERAL (SELECT wd_hours(pe.work_days_hours, d.day) AS h) wd
  LEFT JOIN LATERAL (
    SELECT SUM(CASE WHEN t.scope = 'full_day' THEN wd.h ELSE t.hours_per_day END) AS hours
    FROM timeoffs t
    JOIN timeoff_types tt ON tt.id = t.timeoff_type_id AND tt.deducted
    WHERE t.person_id = pe.id
      AND d.day BETWEEN t.start_date AND t.end_date
      AND t.approval_status <> 'declined'
  ) t ON TRUE
  CROSS JOIN LATERAL (
    SELECT EXISTS (SELECT 1 FROM holidays h
                   WHERE h.account_id = pe.account_id AND h.hdate = d.day
                     AND (h.country       IS NULL OR h.country       = pe.country)
                     AND (h.department_id IS NULL OR h.department_id = pe.department_id)) AS is_holiday
  ) hol
  WHERE pe.account_id = p_account_id AND pe.active
$$;

DROP VIEW IF EXISTS v_utilization;
CREATE OR REPLACE FUNCTION utilization(p_account_id BIGINT, p_from DATE, p_to DATE)
RETURNS TABLE (person_id BIGINT, day DATE, capacity_hours NUMERIC, planned_hours NUMERIC,
               tentative_hours NUMERIC, billable_hours NUMERIC, overtime_hours NUMERIC, utilization NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT c.person_id, c.day, c.capacity_hours,
         COALESCE(l.planned_hours, 0), COALESCE(l.tentative_hours, 0), COALESCE(l.billable_hours, 0),
         GREATEST(COALESCE(l.planned_hours, 0) - c.capacity_hours, 0),            -- BR-03
         CASE WHEN c.capacity_hours = 0 THEN NULL
              ELSE COALESCE(l.planned_hours, 0) / c.capacity_hours END
  FROM daily_capacity(p_account_id, p_from, p_to) c
  LEFT JOIN daily_planned_load(p_account_id, p_from, p_to) l
         ON l.person_id = c.person_id AND l.day = c.day
$$;
```
Notes : capacité 0 + charge > 0 ⇒ `utilization` NULL mais `overtime_hours` > 0 (le front affiche « surbooké »). Le calcul `monthly` écrase au dernier jour du mois (31 → 30/28) : à figer par test. Les congés partiels cumulés > heures ouvrées sont plafonnés par `GREATEST(…,0)`.

### 2.3 Contraintes et intégrité — correctifs

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- B8/B9 : contraintes allocations, rates, holidays
ALTER TABLE allocations DROP CONSTRAINT chk_alloc_hours, DROP CONSTRAINT chk_alloc_repeat;
ALTER TABLE allocations
  ADD CONSTRAINT chk_alloc_mode CHECK (
    (mode = 'hours'      AND hours_per_day IS NOT NULL AND hours_per_day > 0 AND hours_per_day <= 24 AND percent IS NULL)
 OR (mode = 'percentage' AND percent IS NOT NULL AND percent > 0 AND percent <= 100 AND hours_per_day IS NULL)),
  ADD CONSTRAINT chk_alloc_repeat CHECK (
    repeat_state = 'none' OR (repeat_end_date IS NOT NULL AND repeat_end_date >= end_date)),
  ADD COLUMN group_id    UUID,                      -- multi-personnes (people_ids API v3)
  ADD COLUMN row_version INT NOT NULL DEFAULT 1;    -- optimistic locking / ETag

ALTER TABLE rates DROP CONSTRAINT rates_rate_card_id_role_id_person_id_key;
ALTER TABLE rates
  ADD CONSTRAINT fk_rates_person   FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  ADD CONSTRAINT chk_rates_target  CHECK (role_id IS NOT NULL OR person_id IS NOT NULL),
  ADD CONSTRAINT uq_rates          UNIQUE NULLS NOT DISTINCT (rate_card_id, role_id, person_id);

ALTER TABLE holidays DROP CONSTRAINT holidays_account_id_hdate_country_name_key;
ALTER TABLE holidays ADD CONSTRAINT uq_holidays
  UNIQUE NULLS NOT DISTINCT (account_id, hdate, country, department_id, name);

CREATE UNIQUE INDEX uq_people_email ON people (account_id, lower(email)) WHERE email IS NOT NULL;
```

**[BLOQUANT] Intégrité inter-tenant (FK composites)** — aujourd'hui `allocations.person_id` peut pointer vers une personne d'un autre account ; RLS seule ne l'empêche pas (la FK est vérifiée hors RLS). Pattern à appliquer à toutes les tables enfants :
```sql
ALTER TABLE people        ADD UNIQUE (id, account_id);
ALTER TABLE projects      ADD UNIQUE (id, account_id);
ALTER TABLE phases        ADD UNIQUE (id, project_id);
ALTER TABLE project_tasks ADD UNIQUE (id, project_id);
ALTER TABLE allocations
  DROP CONSTRAINT allocations_person_id_fkey,  DROP CONSTRAINT allocations_project_id_fkey,
  DROP CONSTRAINT allocations_phase_id_fkey,   DROP CONSTRAINT allocations_project_task_id_fkey,
  ADD FOREIGN KEY (person_id,  account_id) REFERENCES people(id, account_id)   ON DELETE CASCADE,
  ADD FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
  ADD FOREIGN KEY (phase_id,        project_id) REFERENCES phases(id, project_id)        ON DELETE SET NULL (phase_id),
  ADD FOREIGN KEY (project_task_id, project_id) REFERENCES project_tasks(id, project_id) ON DELETE SET NULL (project_task_id);
-- idem logged_time, timeoffs, people (department/role), projects (client, project_manager)
```
La seconde paire garantit aussi qu'une phase/tâche appartient bien au projet de l'allocation (sinon incohérence silencieuse).

**[IMPORTANT] Suppressions destructrices** : `logged_time.person_id/project_id ... ON DELETE CASCADE` — supprimer un projet ou une personne efface l'historique de temps (donnée de facturation/marge). → `ON DELETE RESTRICT` sur `logged_time` ; désactivation (`active=false`, `status='archived'`) plutôt que DELETE ; la suppression d'allocations par BR-10 passe par une transaction applicative avec récapitulatif. BR-04 : aucun trigger/cascade ne doit supprimer les allocations sur congé.

**[IMPORTANT] Redondances/incohérences de domaine** :
- `projects.tentative` (bool) **et** `status='tentative'` : deux sources de vérité pour BR-07. Garder `status` et dériver (ou `CHECK (tentative = (status='tentative'))`) ; l'effet sur les allocations est « tentatif si l'allocation OU le projet l'est ».
- `projects.budget_amount` sans devise → ajouter `currency_code`. `people.cost_rate` vs `rates.cost_rate` : trancher la précédence (surcharge personne > rate card rôle > `people.cost_rate`) et la documenter (BR-09).
- `logged_time.status` : `submitted` et `locked` coexistent alors que BR-12 verrouille dès la soumission. Définir la machine à états (`draft → submitted(=verrouillé) → approved`; `locked` = échéance ; déverrouillage Admin/Owner uniquement) et **l'imposer en base** :
```sql
CREATE OR REPLACE FUNCTION guard_locked_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft'
     AND COALESCE(current_setting('app.role', true), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'logged_time % verrouillé (BR-12)', OLD.id USING ERRCODE = '42501';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_log_guard BEFORE UPDATE OR DELETE ON logged_time
  FOR EACH ROW EXECUTE FUNCTION guard_locked_log();
```
(`app.role` positionné par l'API après authentification ; le déverrouillage passe par une opération explicite auditée.)
- `logged_time` : ajouter `allocation_id` (nullable, origine du pré-remplissage BR-11, évite doublons au re-remplissage) et `modified_by`.
- `accounts.plan` TEXT libre → enum/CHECK ; `week_start` 0..6 : documenter (0 = dimanche ?) ; `timezone` : valider contre `pg_timezone_names` côté app.

**[IMPORTANT] Exclusion de chevauchements** : appliquer **uniquement** où le métier l'interdit.
- `allocations` : **pas** d'exclusion — chevauchements légitimes (plusieurs projets/jour, sur-allocation jamais bloquée, BR-01).
- `timeoffs` pleine journée d'une même personne : exclusion ; `rate_cards` : pas de validité qui se recouvre pour un même nom.
```sql
ALTER TABLE timeoffs ADD CONSTRAINT ex_timeoff_no_overlap EXCLUDE USING gist
  (person_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
  WHERE (scope = 'full_day' AND approval_status <> 'declined');
ALTER TABLE rate_cards ADD CONSTRAINT ex_ratecard_validity EXCLUDE USING gist
  (account_id WITH =, name WITH =, daterange(valid_from, valid_to, '[]') WITH &&);
```

**[BLOQUANT] Tables d'authentification/autorisation manquantes** (cf. §1.5) :
```sql
CREATE TYPE member_role AS ENUM ('owner','admin','project_manager','member','guest');
CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE, name TEXT, idp_subject TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE account_members (
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       member_role NOT NULL,
  person_id  BIGINT,                     -- NULL pour guests/admins non planifiés
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (person_id, account_id) REFERENCES people(id, account_id));
CREATE TABLE project_managers (
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id));
CREATE TABLE api_tokens (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE, scopes TEXT[] NOT NULL DEFAULT '{}', expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ);
```
Les colonnes `created_by/modified_by` pointent vers `users(id)` (FK à ajouter, `ON DELETE SET NULL`).

### 2.4 Index manquants / à revoir

```sql
-- Requêtes de plage (Schedule, chevauchement de période) : B-tree (start_date,end_date) ne borne pas end_date
CREATE INDEX idx_alloc_person_gist ON allocations USING gist (person_id, daterange(start_date, end_date, '[]'));
-- Sync modified_since (API v3) et flux de changements
CREATE INDEX idx_alloc_sync    ON allocations (account_id, modified_at);
CREATE INDEX idx_people_sync   ON people      (account_id, modified_at);
CREATE INDEX idx_projects_sync ON projects    (account_id, modified_at);
CREATE INDEX idx_log_sync      ON logged_time (account_id, modified_at);
-- FK non indexées (cascades et jointures lentes sinon)
CREATE INDEX idx_alloc_phase   ON allocations (phase_id)        WHERE phase_id IS NOT NULL;
CREATE INDEX idx_alloc_task    ON allocations (project_task_id) WHERE project_task_id IS NOT NULL;
CREATE INDEX idx_alloc_group   ON allocations (group_id)        WHERE group_id IS NOT NULL;
CREATE INDEX idx_people_dept   ON people (department_id);
CREATE INDEX idx_people_role   ON people (role_id);
CREATE INDEX idx_projects_pm   ON projects (project_manager_id);
CREATE INDEX idx_log_range     ON logged_time (account_id, work_date);
CREATE INDEX idx_timeoff_type  ON timeoffs (timeoff_type_id);
CREATE INDEX idx_pteam_person  ON project_team (person_id);
-- Curseur delete_log (le cursor naturel est l'id)
CREATE INDEX idx_delete_log_cursor ON delete_log (account_id, id);
```
Remarques : `idx_alloc_range (account_id, start_date)` est conservé pour les balayages par compte, mais préférer le GiST ci-dessus pour le chevauchement ; `idx_log_status` partiel `status <> 'locked'` ne sert pas les requêtes d'approbation (`status='submitted'`) → à re-concevoir selon l'usage. Ne pas ajouter d'index spéculatifs : valider avec `EXPLAIN` sur jeu de 300 personnes × 12 mois (seed de perf).

### 2.5 Audit, triggers, delete_log, RLS

```sql
-- Audit complet : modified_at + modified_by + row_version sur TOUTES les entités mutables
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.modified_at = now();
  NEW.modified_by = NULLIF(current_setting('app.user_id', true), '')::bigint;
  NEW.row_version = OLD.row_version + 1;      -- exiger la colonne sur chaque table concernée
  RETURN NEW;
END $$;

-- delete_log alimenté en base (cascades incluses), jamais « oublié » par l'application (BR-14)
CREATE OR REPLACE FUNCTION log_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO delete_log (account_id, entity, entity_id, deleted_by)
  VALUES (OLD.account_id, TG_ARGV[0], OLD.id, NULLIF(current_setting('app.user_id', true), '')::bigint);
  RETURN OLD;
END $$;
CREATE TRIGGER trg_alloc_del   AFTER DELETE ON allocations   FOR EACH ROW EXECUTE FUNCTION log_delete('allocations');
CREATE TRIGGER trg_log_del     AFTER DELETE ON logged_time   FOR EACH ROW EXECUTE FUNCTION log_delete('logged_time');
CREATE TRIGGER trg_timeoff_del AFTER DELETE ON timeoffs      FOR EACH ROW EXECUTE FUNCTION log_delete('timeoffs');
-- (+ people, projects, clients, phases, milestones… selon l'API v3 /delete-log)
```
Aujourd'hui seuls 4 triggers `touch` existent (people, projects, allocations, logged_time) ; `timeoffs`, `clients`, `phases`, `project_tasks`, `milestones`, `rate_cards` n'ont ni `modified_*` ni trigger, contrairement à la règle « toutes les entités mutables » du dossier (§3.3) **[IMPORTANT]**. `delete_log` : volumétrie → purge par job (> 7 j) ou partitionnement par mois ; pas de FK volontaire (conserver).

```sql
-- RLS : isolation tenant (appliquer à toutes les tables portant account_id)
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='account_id' AND table_name <> 'accounts' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (account_id = NULLIF(current_setting('app.account_id', true), '')::bigint)
      WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::bigint)$p$, t);
  END LOOP;
END $$;
```
`accounts` : policy sur `id`. Variable absente ⇒ NULL ⇒ aucune ligne (échec fermé : bon comportement).

### 2.6 Stratégie de migration — **[IMPORTANT]**

1. Aucune donnée en prod : **ne pas** empiler des `ALTER` ; réécrire une baseline `0001_init.sql` v1.1 intégrant tout ce qui précède (le `.txt` est archivé, la baseline devient la référence). Renommer en `.sql` ou migrations versionnées.
2. Outil : dbmate / Atlas / node-pg-migrate (SQL pur, versionné, forward-only). CI : appliquer depuis zéro + vérifier la dérive (`atlas schema diff`) + lint (Squawk) + régénérer les types Kysely et échouer si diff.
3. Règles : expand/contract (ajout nullable → backfill → contrainte `NOT VALID` puis `VALIDATE`), `CREATE INDEX CONCURRENTLY`, `lock_timeout`, jamais de `DROP` dans la même release que l'usage supprimé.
4. Jeux de données : seed déterministe (petit) + seed de perf (300 personnes × 12 mois) versionnés, mêmes pour dev/CI/perf.
5. PG ≥ 15 verrouillé dans l'image (dev, CI, prod identiques).

---

## 3. Risques techniques et ADRs proposés

### 3.1 Risques (probabilité × impact)

| # | Risque | Prio | Mitigation |
|---|---|---|---|
| R1 | Capacité/charge calculées différemment (SQL vs TS vs API) → chiffres divergents | [BLOQUANT] | Moteur TS pur = référence pour le Schedule ; tests de parité SQL↔TS (property-based) ; matrice BR |
| R2 | Convention `work_days_hours` ambiguë (lundi vs dimanche) | [BLOQUANT] | ADR-006, test asymétrique, conversion à la frontière API |
| R3 | Fuite inter-tenant (RLS oubliée, FK inter-tenants, canal WS) | [BLOQUANT] | RLS FORCE + FK composites + tests auto cross-tenant + filtre WS |
| R4 | Perte d'événements temps réel / planning périmé | [IMPORTANT] | `change_log` séquencé + rattrapage `since`; test de coupure réseau |
| R5 | Perf rendu 300×12 mois (le vrai risque du dossier §6.4) | [IMPORTANT] | Prototype canvas dès le sprint 1, budgets en CI |
| R6 | Cinq types de budget (hours/money × task/person, fees) : combinatoire | [IMPORTANT] | Commencer par `hours_by_task` ; strategy pattern ; table de vérité de tests |
| R7 | Compat API v3 supposée sans vérification | [IMPORTANT] | Extraire un contrat (OpenAPI) de la doc, fixtures, adaptateur isolé |
| R8 | Répétitions (weekly/monthly) : sémantique floue, fins de mois | [IMPORTANT] | Spécifier avec exemples, tests de table ; éventuellement matérialiser les occurrences |
| R9 | Suppressions en cascade détruisant données de temps/finance | [IMPORTANT] | RESTRICT + archivage + BR-10 transactionnel |
| R10 | Dérive du code généré par agents (incohérences de style, tests faibles) | [IMPORTANT] | §4 |
| R11 | Mobile parité (popups) | [CONFORT] | PWA d'abord, hors MVP |
| R12 | RGPD/SOC2 (données personnelles, rétention 6 mois BR-16) | [CONFORT] | Région UE, chiffrement, jobs de rétention, journal d'audit |

### 3.2 ADRs (format court)

**ADR-001 — Monorepo TypeScript, SQL-first**
Contexte : agents + équipe réduite, contrat client/serveur critique. Décision : pnpm/Turborepo, Fastify+Zod→OpenAPI, Kysely, migrations SQL. Conséquences : types de bout en bout, pas d'ORM magique ; discipline de génération de types en CI.

**ADR-002 — Multi-tenant : schéma partagé + RLS FORCE + FK composites**
Contexte : isolation requise, coût faible. Décision : `account_id` partout, `SET LOCAL app.account_id`, rôle sans BYPASSRLS, FK `(id, account_id)`. Conséquences : tests cross-tenant obligatoires, pooler en mode transaction, migration vers DB dédiée possible pour Enterprise.

**ADR-003 — Temps réel : WebSocket + outbox `change_log` + Redis**
Contexte : propagation < 1 s, fiabilité au rejeu. Décision : événements écrits dans la transaction métier, publiés après commit, rattrapage par `seq`. Conséquences : une table et un publisher à opérer ; garanties « au moins une fois » → patchs idempotents côté client.

**ADR-004 — Rendu Schedule : canvas virtualisé + overlay DOM**
Contexte : 110 k cellules, drag fluide. Décision : canvas 2D, worker pour la capacité, DOM pour a11y/édition. Conséquences : a11y et tests visuels à outiller (arbre DOM parallèle, Playwright + captures) ; prototype à valider avant d'investir.

**ADR-005 — Capacité : source de vérité en TS pur, SQL pour rapports, parité testée**
Contexte : l'optimiste UI exige un calcul client < 100 ms ; les rapports exigent du set-based. Décision : package `@app/rules` partagé + fonctions SQL §2.2 ; tests property-based de parité. Conséquences : double implémentation coûteuse mais encadrée ; toute règle BR modifiée touche les deux.

**ADR-006 — Convention des jours : stockage lundi-premier (ISO), conversion à l'API**
Contexte : schéma « index 0 = lundi », exemple du dossier et (probablement) Float en « index 0 = dimanche ». Décision : ISO en interne, adaptateur v3 convertit, tests asymétriques. Conséquences : une seule frontière de conversion ; exemples du dossier à corriger.

**ADR-007 — API v3 via adaptateur, domaine interne propre**
Contexte : compat souhaitée, mais noms/statuts Float (ints, `task`) polluent le domaine. Décision : DTO v3 dans un module dédié, contract tests. Conséquences : mapping à maintenir ; liberté d'évolution du modèle interne.

**ADR-008 — Sync : `delete_log` par trigger + curseur monotone**
Contexte : BR-14 (72 h) et pertes possibles avec `modified_at` transactionnel. Décision : triggers `AFTER DELETE`, curseur `seq`/`id`, `modified_since` avec marge pour la compat. Conséquences : volumétrie à purger/partitionner.

**ADR-009 — Autorisation : RBAC applicatif unique, RLS = tenant seulement**
Contexte : 5 rôles + PM par projet + Member limité. Décision : `authorize()` unique (REST + WS), table `account_members`/`project_managers`. Conséquences : un point critique à couvrir à 100 % par matrice de tests ; revue humaine obligatoire.

**ADR-010 — Verrouillage timesheet appliqué en base (BR-12) et BR-04 non destructif**
Contexte : règles de traçabilité facturation ; déviation voulue de Float sur BR-04. Décision : trigger `guard_locked_log` ; congé sur allocations ⇒ avertissement + replanification assistée, aucune cascade. Conséquences : exceptions admin explicites et auditées.

---

## 4. Stratégie de tests et CI/CD pour un développement agentique

### 4.1 Principes

1. **Spécification exécutable d'abord** : OpenAPI, migrations SQL et la **matrice BR-01…BR-17** sont le contrat ; chaque BR a ≥ 1 test tagué (`@BR-07`) ; un script CI échoue si une BR n'a aucun test (traçabilité). Chantier (d) du dossier.
2. **Les agents ne valident pas leur propre travail** : les tests de règles critiques (capacité, répétitions, RLS, authz, verrouillage) sont écrits/relus par un humain ; garde-fou CI : un PR qui supprime ou affaiblit des assertions (`git diff` sur `tests/`) est bloqué sans label « test-change-approved ».
3. **Petits incréments** : un PR = une tâche, < 400 lignes, branche/worktree isolé par agent, ADR requis pour tout changement d'architecture, `CODEOWNERS` imposant une revue humaine sur `db/migrations/`, `auth/`, `rls`, `rules/`.

### 4.2 Pyramide

| Niveau | Outils | Contenu | Prio |
|---|---|---|---|
| Unitaires purs | Vitest + fast-check | Moteur `@app/rules` (capacité, surtemps, répétitions, budgets) ; horloge injectée, jamais `Date.now()` | [BLOQUANT] |
| Mutation | Stryker sur `@app/rules` (nightly + PR touchant rules) | Détecte les tests agentiques « verts mais vides » | [IMPORTANT] |
| Base de données | Testcontainers (PG identique prod) ou pgTAP | Contraintes, exclusions, triggers (locked, delete_log), RLS cross-tenant généré sur toutes les tables, parité SQL↔TS | [BLOQUANT] |
| Contrat API | Schemathesis/Dredd sur OpenAPI + fixtures v3 | Conformité, pagination, tri `-champ`, 409/ETag, authz par rôle × action | [IMPORTANT] |
| Temps réel | Test d'intégration WS multi-clients | Propagation < 1 s, rattrapage après coupure, absence de fuite Member | [IMPORTANT] |
| E2E | Playwright | Parcours §4.2 du dossier (créer projet → allouer → conflit → timesheet → rapport), régression visuelle du canvas | [IMPORTANT] |
| Performance | k6 (REST + WS), benchmark rendu en navigateur headless | 300 personnes × 12 mois, 500 clients WS, budgets §1.3 | [IMPORTANT] (nightly) |
| Sécurité | Semgrep, gitleaks, `npm audit`/OSV, Trivy, SBOM | Secrets, injections, dépendances | [IMPORTANT] |
| Accessibilité | axe-core dans Playwright | AA, navigation clavier | [CONFORT] |

### 4.3 Pipeline CI (par PR, requis pour merger)

1. **Rapide (< 3 min)** : format, lint, typecheck, build, unitaires, génération de types (diff = échec), lint SQL (Squawk), secret scan.
2. **DB (< 5 min)** : migrations depuis zéro + dérive + tests DB/RLS/parité.
3. **Contrat + intégration (< 8 min)** : API, WS, authz.
4. **E2E** sur environnement preview (DB éphémère issue du seed) — sélectif au PR, complet en nightly.
5. **Garde-fous agent** : taille du PR, tests non affaiblis, traçabilité BR, ADR présent si `docs/adr` référencé, couverture sur `rules/` ≥ 95 % (branches), score de mutation ≥ seuil.

### 4.4 CD

Trunk-based + feature flags ; merge ⇒ staging automatique (migrations expand puis code) ; prod par promotion manuelle avec canary et rollback code (les migrations restent compatibles N-1) ; smoke test post-déploiement (création d'allocation + réception WS) ; Renovate pour les dépendances (versions épinglées, lockfile) ; backups PITR testés par restauration trimestrielle.

### 4.5 Garde-fous pour agents (à inscrire dans CLAUDE.md quand le code démarre)

Commandes `make check` unique (lint+types+tests rapides) exécutée avant tout commit ; hooks pre-commit identiques à la CI ; interdiction de modifier migrations déjà mergées (nouvelle migration seulement) ; toute requête SQL passe par la couche typée avec contexte tenant ; pas de `SET` de session ; données de test sans PII réelle.

---

## 5. Ordre d'attaque recommandé

1. Baseline SQL v1.1 (B1–B9 + tenant/authN + index) avec tests DB et RLS ; trancher ADR-006.
2. Package `@app/rules` + matrice BR (capacité, surtemps, répétitions) avec parité SQL.
3. Prototype Schedule canvas + endpoint `/schedule` + WS/outbox (valide R4, R5 avant tout le reste).
4. Authz + API v3 (adaptateur) + CI complète avec garde-fous agent.
