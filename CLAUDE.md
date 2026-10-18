# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## State of the repo

The product is named **WNEXT** ("What's Next"). Float.com is a reference, not a compatibility target: do not mirror Float's API or data conventions when something better exists.

Design-phase project entering **P0 Fondations** (`docs/factory/strategy.md` §1): a rebuild of Float.com (resource scheduling SaaS). The repo is a git repository (branch `main`). There is no application code yet (no `apps/`, `packages/`, root build system or linter). Two things are executable: the SQL regression tests and the observability sub-project. Documents are in French.

- `docs/dossier-fondamentaux-v1.1.md` — product fundamentals dossier v1.1 (CPTO / architect / UX / PM), the reference. Source of truth for intent, business rules (`BR-01`…), requirements and roadmap. **On conflict, the ADRs in `docs/decisions/` win.**
- `schema.sql` — PostgreSQL **v1.1** schema (baseline `0001_init`, PG >= 15, 908 lines). Not yet wired into a migration tool.
- `tests/sql/schema_tests.sql` — SQL non-regression tests for v1.1 (616 lines), run in a transaction that is rolled back (usage in the file header: load `schema.sql`, then the tests, with `psql -v ON_ERROR_STOP=1`).
- `factory/observability/` — Next.js observability dashboard for the dark factory (SQLite store, scribe, simulator, vitest tests; `reports/gate-P0.md`). Its own `README.md` has the commands.
- `docs/archive/` — v1.0 material, kept as-is and superseded: `schema.sql.txt` and the v1.0 dossier. Do not edit or rely on it. The `*:Zone.Identifier` files are WSL download artifacts; ignore them.

**Local only, by default.** Never publish anything online (no claude.ai Artifacts, no hosted pages or docs) unless the user explicitly asks for it. Deliverables (diagrams, dashboards, reports) are local files in this repo, e.g. `docs/*.html`.

**HTML docs convention.** Every HTML doc is light theme only (no dark mode, no `prefers-color-scheme`, `color-scheme: light`) and has a sticky left sidebar listing the page's anchors (one `id` per section, active link highlighted, collapses above the content below ~880px). Reference implementations: `docs/ecrans-et-parcours.html`, `docs/schema-v1.1-diagram.html`.

Write docs and comments in French to match the existing material; keep technical identifiers (tables, columns, `BR-xx`) in English/as-is.

## Architecture (intended)

Per dossier §3.3: React SPA with realtime (WebSocket/SSE; mutations must propagate to all clients in <1 s), REST JSON backend modeled on Float API v3 (page/cursor pagination, `-field` for descending sort), Postgres, per-tenant cache, virtualized rendering of the sparse people × days matrix (300+ people × 12 months). Every mutable entity carries `created_by/modified_by/created_at/modified_at`, and deletions go to `delete_log` (BR-14, ≥72 h retention for syncs).

## Data model essentials (`schema.sql` v1.1)

- Multi-tenant: every table hangs off `accounts` (`account_id`, `ON DELETE CASCADE`).
- `allocations` is the pivot entity of the Schedule (people × projects × dates, hours or percentage mode, tentative/confirmed). `logged_time` is the actual-vs-planned counterpart, pre-filled from confirmed allocations (BR-11) and locked after submission (BR-12).
- `people.work_days_hours` is a 7-element array, **index 0 = Monday** (ISO storage; display start day follows `accounts.week_start`, per ADR-001). Default `{8,8,8,8,8,0,0}`; any Sunday-first conversion (Float) happens only at the API v3 boundary. PG arrays are 1-based and `ISODOW` Monday = 1, so remember the 0-based offset in application code.
- Arbitration of the review lives in `docs/decisions/ADR-001-arbitrage-revue-v1.1.md`; per-role reviews in `docs/review/`. MVP is reduced to Schedule + capacity; `docs/decisions/ADR-002-*.md` adds: login users (`users`/`account_members`) are distinct from plannable `people`; day/week/month zoom, horizontal navigation + "Aujourd'hui" button; i18n (FR+EN) from day one as an NFR; fluid input; variable-height multi-day blocks (custom layout engine, DOM vs canvas to settle in a spike).
- `docs/decisions/ADR-003-*.md`: front and back are decoupled and contract-first. `packages/contracts` (Zod schemas, generated OpenAPI, realtime event schemas, stable error codes) is the single source of truth; `apps/web` and `apps/api` never import each other, only `contracts` and the shared `engine`. API responses carry error codes, never UI strings. Status: proposed.
- Capacity is computed, not stored: `daily_capacity(account_id, from, to)` (work hours − holidays − deducted time off; holidays resolved via `people.country` and department) and `daily_planned_load()` feed `utilization(account_id, from, to)`, which replaces the old `v_utilization` view. Ranges are bounded (> 400 days is rejected). Over-allocation is **reported, never blocked** at insert (BR-01).

## Business rules that constrain implementation

- BR-04: a full-day time-off over existing allocations must warn and offer assisted rescheduling, not silently delete (deliberate deviation from Float).
- BR-10: removing someone from a project deletes their allocations/logs for it — require explicit confirmation with a summary.
- BR-07: tentative-project hours are tracked separately from confirmed reports.
- Billing of the product itself (plans, seats, trial, Stripe; BR-15/16/17/34) is **excluded** (ADR-004). Do not model it. Project-level "billable" is kept for now (open).
- Time off supports half-days (`timeoffs.start_half`/`end_half`, am|pm; a half deducts 50% of the day's hours). No time-of-day on allocations (ADR-004).

## Phase P1 (current) — P0 clos, factory gelée

- P0 is closed as built: monorepo, `make check`/CI, guardrails, contract chain, kill-switch. Supervisor/introspection criteria are deferred. First P1 vertical: `packages/engine/src/capacity.ts` (TS mirror of `daily_capacity`, parity tests in `packages/engine/test/`). Phases in `docs/factory/strategy.md` §1.
- Contract-first (ADR-003, status proposed): any change touching the API edits `packages/contracts` first, in a separate reviewed commit. `packages/contracts` depends on nothing; `packages/engine` (capacity + layout, pure TS) on `contracts`; `apps/api` and `apps/web` on `contracts` and `engine` only. `apps/web` and `apps/api` never import each other (boundary lint in CI). `packages/contracts` is under CODEOWNERS (human review).
- Questions "before P1" decided 2026-10-18 (`docs/decisions/questions-ouvertes-avant-p1.md`): optimistic versioning, tentative in load, capacity thresholds, % base (gross); still open: the DOM vs canvas spike (dossier §3.3), a human review of the SQL tests, and checking the API v3 day convention (dossier §6 and §7, full list of open questions).
- **Factory gelée (2026-10-18).** `factory/orchestrator` et `factory/observability` ne reçoivent plus de commits (ADR-006/007 différés, `docs/factory/gel-factory.md`). On développe le produit à la main, un agent à la fois, tests d'abord. L'orchestrateur ne se reconstruit qu'après avoir ressenti la douleur de lancer 2-3 sessions manuellement.
- `schema.sql.txt` (v1.0) is archived in `docs/archive/`; do not use it.
