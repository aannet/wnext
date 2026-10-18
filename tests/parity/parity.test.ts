// Parité SQL <-> TS sur données aléatoires (graine fixe, déterministe) : schema.sql est chargé dans un vrai
// PostgreSQL (PGlite, WASM) et daily_capacity / daily_planned_load / utilization sont comparées à
// packages/engine sur les mêmes jeux. Élargir : PARITY_SCENARIOS=500 npm run test:parity.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dailyCapacity, dailyPlannedLoad, utilization,
  type AllocationInput, type HolidayInput, type PersonInput, type TimeoffInput,
} from "../../packages/engine/src/index";

// @BR-01 @BR-02 @BR-03 @BR-04 @BR-20 @BR-21 @BR-25 @BR-30 @BR-38
const FROM = "2026-03-01";
const TO = "2026-05-09"; // 70 jours
const SCENARIOS = Number(process.env.PARITY_SCENARIOS ?? 60);
const EPS = 1e-6;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayIndex = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse("2000-01-01T00:00:00Z")) / 86_400_000);

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist, citext } });
  await db.exec(readFileSync("schema.sql", "utf8"));
}, 120_000);
afterAll(async () => { await db?.close(); });

describe("suite SQL de non-régression (tests/sql/schema_tests.sql)", () => {
  it("passe en entier sur PostgreSQL 18 (PGlite)", async () => {
    await db.exec(readFileSync("tests/sql/schema_tests.sql", "utf8")); // lève 'FAIL: <libellé>' à la première assertion en échec
  }, 120_000);
});

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < EPS);

async function scenario(seed: number) {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const date = (lo = -14, hi = 70) => addDays(FROM, int(lo, hi));
  const q = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;

  await db.exec("BEGIN");
  try {
    const acc = (await q("INSERT INTO accounts(name) VALUES ('P') RETURNING id"))[0].id as number;
    const depts: number[] = [];
    for (const n of ["d1", "d2"]) depts.push((await q("INSERT INTO departments(account_id, name) VALUES ($1,$2) RETURNING id", [acc, n]))[0].id);

    const people: PersonInput[] = [];
    for (let i = 0; i < int(1, 4); i++) {
      const wdh = pick([[8, 8, 8, 8, 8, 0, 0], [0, 4, 4, 4, 0, 0, 0], [8, 8, 8, 8, 8, 8, 8], [7.5, 7.5, 7.5, 7.5, 6, 0, 0],
        Array.from({ length: 7 }, () => pick([0, 2, 4, 6, 7.5, 8]))]);
      const country = pick([null, "FR", "DE"]);
      const dept = pick([null, ...depts]);
      const active = r() < 0.85;
      const id = (await q("INSERT INTO people(account_id, name, work_days_hours, country, department_id, active) VALUES ($1,'p',$2,$3,$4,$5) RETURNING id",
        [acc, wdh, country, dept, active]))[0].id as number;
      people.push({ id: String(id), active, workDaysHours: wdh, country, departmentId: dept === null ? null : String(dept) });
    }

    const holidays: HolidayInput[] = [];
    for (let i = 0; i < int(0, 4); i++) {
      const h = { hdate: r() < 0.6 ? date(0, 6) : date(0, 69), country: pick([null, null, "FR", "DE"]), departmentId: pick([null, null, ...depts]), hoursOff: pick([null, null, 1, 3, 4.5, 6, 12]) };
      await q("INSERT INTO holidays(account_id, name, hdate, country, department_id, hours_off) VALUES ($1,$2,$3,$4,$5,$6)",
        [acc, `h${i}`, h.hdate, h.country, h.departmentId, h.hoursOff]);
      holidays.push({ ...h, departmentId: h.departmentId === null ? null : String(h.departmentId) });
    }

    const types = [true, false];
    const typeIds: number[] = [];
    for (const [i, deducted] of types.entries()) typeIds.push((await q("INSERT INTO timeoff_types(account_id, name, deducted) VALUES ($1,$2,$3) RETURNING id", [acc, `t${i}`, deducted]))[0].id);

    const timeoffs: TimeoffInput[] = [];
    for (const p of people) {
      const taken: [number, number][] = [];
      for (let i = 0; i < int(0, 3); i++) {
        const partial = r() < 0.4;
        const sd = r() < 0.6 ? date(0, 8) : date(0, 69);
        const ed = addDays(sd, int(0, 4));
        const half = () => pick(["am", "pm"] as const);
        let sh: "am" | "pm" = "am", eh: "am" | "pm" = "pm";
        if (!partial) { sh = half(); eh = half(); if (sd === ed && sh === "pm" && eh === "am") eh = "pm"; }
        const s = dayIndex(sd) * 2 + (sh === "pm" ? 1 : 0);
        const e = dayIndex(ed) * 2 + (eh === "pm" ? 1 : 0);
        const status = pick(["pending", "approved", "declined"] as const);
        if (!partial && status !== "declined") {
          if (taken.some(([a, b]) => s <= b && a <= e)) continue;
          taken.push([s, e]);
        }
        const ti = int(0, 1);
        const hours = partial ? pick([1, 2, 3, 4.5, 6, 9]) : null;
        await q(`INSERT INTO timeoffs(account_id, person_id, timeoff_type_id, start_date, end_date, scope, start_half, end_half, hours_per_day, approval_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [acc, p.id, typeIds[ti], sd, ed, partial ? "partial" : "full_day", sh, eh, hours, status]);
        timeoffs.push({ personId: p.id, startDate: sd, endDate: ed, scope: partial ? "partial" : "full_day", startHalf: sh, endHalf: eh,
          hoursPerDay: hours, deducted: types[ti]!, approvalStatus: status });
      }
    }

    const projects: { id: number; tentative: boolean; nonBillable: boolean; phases: { id: number; nb: boolean }[]; tasks: { id: number; billable: boolean }[] }[] = [];
    for (let i = 0; i < int(1, 3); i++) {
      const tentative = r() < 0.3, nonBillable = r() < 0.2;
      const id = (await q("INSERT INTO projects(account_id, name, status, non_billable) VALUES ($1,$2,$3,$4) RETURNING id", [acc, `pr${i}`, tentative ? "tentative" : "in_progress", nonBillable]))[0].id as number;
      const phases: { id: number; nb: boolean }[] = [], tasks: { id: number; billable: boolean }[] = [];
      if (r() < 0.5) { const nb = r() < 0.5; phases.push({ id: (await q("INSERT INTO phases(account_id, project_id, name, non_billable) VALUES ($1,$2,'ph',$3) RETURNING id", [acc, id, nb]))[0].id, nb }); }
      if (r() < 0.5) { const billable = r() < 0.5; tasks.push({ id: (await q("INSERT INTO project_tasks(account_id, project_id, name, billable) VALUES ($1,$2,'tk',$3) RETURNING id", [acc, id, billable]))[0].id, billable }); }
      projects.push({ id, tentative, nonBillable, phases, tasks });
    }

    const allocations: AllocationInput[] = [];
    for (let i = 0; i < int(0, 8); i++) {
      const p = pick(people), pr = pick(projects);
      const sd = date(-14, 60), ed = addDays(sd, int(0, 9));
      const mode = pick(["hours", "percentage"] as const);
      const hours = mode === "hours" ? pick([0.5, 1, 2, 3.25, 4, 6, 8, 10]) : null;
      const percent = mode === "percentage" ? pick([10, 25, 33.33, 50, 100, 150]) : null;
      const rep = pick(["none", "none", "none", "daily", "weekly", "monthly"] as const);
      const rend = rep === "none" ? null : addDays(ed, int(0, 60));
      const status = pick(["confirmed", "confirmed", "tentative"] as const);
      const billable = r() < 0.8;
      const phase = pr.phases.length && r() < 0.6 ? pr.phases[0]! : null;
      const task = pr.tasks.length && r() < 0.6 ? pr.tasks[0]! : null;
      await q(`INSERT INTO allocations(account_id, person_id, project_id, phase_id, project_task_id, start_date, end_date, mode, hours_per_day, percent, status, billable, repeat_state, repeat_end_date)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [acc, p.id, pr.id, phase?.id ?? null, task?.id ?? null, sd, ed, mode, hours, percent, status, billable, rep, rend]);
      allocations.push({ personId: p.id, startDate: sd, endDate: ed, mode, hoursPerDay: hours, percent, status, billable,
        repeatState: rep, repeatEndDate: rend, projectTentative: pr.tentative, projectNonBillable: pr.nonBillable,
        phaseNonBillable: phase?.nb ?? false, taskBillable: task ? task.billable : null });
    }

    const args = [acc, FROM, TO];
    const sqlCap = await q("SELECT person_id::text AS p, day::text AS d, base_hours, holiday_hours, timeoff_hours, capacity_hours FROM daily_capacity($1,$2,$3)", args);
    const sqlLoad = await q("SELECT person_id::text AS p, day::text AS d, planned_hours, tentative_hours, billable_hours FROM daily_planned_load($1,$2,$3)", args);
    const sqlUtil = await q("SELECT person_id::text AS p, day::text AS d, capacity_hours, planned_hours, tentative_hours, billable_hours, overtime_hours, utilization, is_overbooked FROM utilization($1,$2,$3)", args);
    return { people, holidays, timeoffs, allocations, sqlCap, sqlLoad, sqlUtil };
  } finally {
    await db.exec("ROLLBACK");
  }
}

const key = (p: string, d: string) => `${p}|${d}`;
const index = <T extends { personId: string; day: string }>(rows: T[]) => new Map(rows.map((x) => [key(x.personId, x.day), x]));

describe(`parité SQL <-> TS (${SCENARIOS} scénarios aléatoires, ${FROM}..${TO})`, () => {
  it("daily_capacity, daily_planned_load et utilization donnent les mêmes nombres", async () => {
    let compared = 0;
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const s = await scenario(seed);
      const input = { people: s.people, holidays: s.holidays, timeoffs: s.timeoffs, allocations: s.allocations, from: FROM, to: TO };
      const where = `seed ${seed}`;

      const cap = index(dailyCapacity(input));
      expect(cap.size, `${where} : nombre de lignes de capacité`).toBe(s.sqlCap.length);
      for (const r of s.sqlCap) {
        const t = cap.get(key(r.p, r.d));
        expect(t, `${where} capacité ${r.p} ${r.d}`).toBeDefined();
        for (const [sql, ts] of [[r.base_hours, t!.baseHours], [r.holiday_hours, t!.holidayHours], [r.timeoff_hours, t!.timeoffHours], [r.capacity_hours, t!.capacityHours]] as const) {
          expect(close(num(sql), ts), `${where} capacité ${r.p} ${r.d} : SQL ${sql} vs TS ${ts}`).toBe(true);
        }
      }

      const load = index(dailyPlannedLoad(input));
      expect(load.size, `${where} : nombre de lignes de charge`).toBe(s.sqlLoad.length);
      for (const r of s.sqlLoad) {
        const t = load.get(key(r.p, r.d));
        expect(t, `${where} charge ${r.p} ${r.d}`).toBeDefined();
        for (const [sql, ts] of [[r.planned_hours, t!.plannedHours], [r.tentative_hours, t!.tentativeHours], [r.billable_hours, t!.billableHours]] as const) {
          expect(close(num(sql), ts), `${where} charge ${r.p} ${r.d} : SQL ${sql} vs TS ${ts}`).toBe(true);
        }
      }

      const util = index(utilization(input));
      expect(util.size, `${where} : nombre de lignes d'utilisation`).toBe(s.sqlUtil.length);
      for (const r of s.sqlUtil) {
        const t = util.get(key(r.p, r.d));
        expect(t, `${where} utilisation ${r.p} ${r.d}`).toBeDefined();
        const pairs: [unknown, number | null][] = [[r.capacity_hours, t!.capacityHours], [r.planned_hours, t!.plannedHours], [r.tentative_hours, t!.tentativeHours],
          [r.billable_hours, t!.billableHours], [r.overtime_hours, t!.overtimeHours], [r.utilization, t!.utilization]];
        for (const [sql, ts] of pairs) expect(close(num(sql), ts), `${where} utilisation ${r.p} ${r.d} : SQL ${sql} vs TS ${ts}`).toBe(true);
        expect(r.is_overbooked, `${where} is_overbooked ${r.p} ${r.d}`).toBe(t!.isOverbooked);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(SCENARIOS * 20); // garde-fou : le générateur produit bien des lignes
  }, 300_000);
});
