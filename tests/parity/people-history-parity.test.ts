// Parité SQL <-> TS de l'horaire daté (@BR-19) : base migrée (schema.sql puis migrations/) dans PGlite, changements
// d'horaire aléatoires saisis par UPDATE people à une date d'effet (app.effective_from), historique relu dans
// people_history et passé au moteur (PersonInput.workSchedule). daily_capacity, daily_planned_load et utilization
// doivent rendre les mêmes nombres. Graine fixe, déterministe. Élargir : PARITY_SCENARIOS=500 npm run test:parity.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dailyCapacity, dailyPlannedLoad, utilization,
  type AllocationInput, type HolidayInput, type PersonInput, type TimeoffInput, type WorkScheduleEntry,
} from "../../packages/engine/src/index";

const FROM = "2026-03-01";
const TO = "2026-05-09";
const SCENARIOS = Number(process.env.PARITY_SCENARIOS ?? 40);
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

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist, citext } });
  await db.exec(readFileSync("schema.sql", "utf8"));
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(`migrations/${f}`, "utf8"));
}, 120_000);
afterAll(async () => { await db?.close(); });

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : a === b || Math.abs(a - b) < EPS);
const WEEKS = [[8, 8, 8, 8, 8, 0, 0], [0, 4, 4, 4, 0, 0, 0], [8, 8, 8, 8, 8, 8, 8], [7.5, 7.5, 7.5, 7.5, 6, 0, 0], [4, 4, 4, 4, 4, 0, 0]];

async function scenario(seed: number) {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const date = (lo = -14, hi = 70) => addDays(FROM, int(lo, hi));
  const q = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;

  await db.exec("BEGIN");
  try {
    const acc = (await q("INSERT INTO accounts(name) VALUES ('P') RETURNING id"))[0].id as number;
    const ids: number[] = [];
    for (let i = 0; i < int(1, 4); i++) {
      const id = (await q("INSERT INTO people(account_id, name, work_days_hours, active) VALUES ($1,'p',$2,$3) RETURNING id", [acc, pick(WEEKS), r() < 0.9]))[0].id as number;
      ids.push(id);
      // 0 à 3 changements d'horaire datés, dans un ordre quelconque (une date antérieure remplace les périodes suivantes).
      for (let k = 0; k < int(0, 3); k++) {
        await q("SELECT set_config('app.effective_from', $1, true)", [date(-20, 80)]);
        await q("UPDATE people SET work_days_hours = $2 WHERE id = $1", [id, pick(WEEKS.concat([Array.from({ length: 7 }, () => pick([0, 2, 6, 8]))]))]);
      }
    }
    const people: PersonInput[] = [];
    for (const id of ids) {
      const pe = (await q("SELECT active, work_days_hours FROM people WHERE id = $1", [id]))[0];
      const hist = await q(`SELECT valid_from::text AS f, valid_to::text AS t, work_days_hours AS w FROM people_history
                             WHERE person_id = $1 AND attribute = 'work_days_hours' ORDER BY valid_from NULLS FIRST`, [id]);
      const workSchedule: WorkScheduleEntry[] = hist.map((h) => ({ validFrom: h.f, validTo: h.t, workDaysHours: (h.w as unknown[]).map(Number) }));
      people.push({ id: String(id), active: pe.active, workDaysHours: (pe.work_days_hours as unknown[]).map(Number), country: null, departmentId: null, workSchedule });
    }

    const holidays: HolidayInput[] = [];
    for (let i = 0; i < int(0, 3); i++) {
      const h = { hdate: date(0, 69), country: null, departmentId: null, hoursOff: pick([null, 1, 4.5, 12]) };
      await q("INSERT INTO holidays(account_id, name, hdate, hours_off) VALUES ($1,$2,$3,$4)", [acc, `h${i}`, h.hdate, h.hoursOff]);
      holidays.push(h);
    }
    const type = (await q("INSERT INTO timeoff_types(account_id, name, deducted) VALUES ($1,'t',true) RETURNING id", [acc]))[0].id;
    const timeoffs: TimeoffInput[] = [];
    for (const p of people) {
      if (r() < 0.5) continue;
      const sd = date(0, 65), ed = addDays(sd, int(0, 4));
      const partial = r() < 0.4;
      const hours = partial ? pick([1, 3, 6]) : null;
      await q(`INSERT INTO timeoffs(account_id, person_id, timeoff_type_id, start_date, end_date, scope, start_half, end_half, hours_per_day, approval_status)
               VALUES ($1,$2,$3,$4,$5,$6,'am','pm',$7,'approved')`, [acc, p.id, type, sd, ed, partial ? "partial" : "full_day", hours]);
      timeoffs.push({ personId: p.id, startDate: sd, endDate: ed, scope: partial ? "partial" : "full_day", startHalf: "am", endHalf: "pm", hoursPerDay: hours, deducted: true, approvalStatus: "approved" });
    }
    const project = (await q("INSERT INTO projects(account_id, name) VALUES ($1,'pr') RETURNING id", [acc]))[0].id;
    const allocations: AllocationInput[] = [];
    for (let i = 0; i < int(1, 6); i++) {
      const p = pick(people);
      const sd = date(-14, 60), ed = addDays(sd, int(0, 12));
      const mode = pick(["hours", "percentage", "percentage"] as const);
      const hours = mode === "hours" ? pick([1, 2, 4, 8]) : null;
      const percent = mode === "percentage" ? pick([25, 50, 100, 150]) : null;
      const rep = pick(["none", "none", "weekly"] as const);
      const rend = rep === "none" ? null : addDays(ed, int(0, 40));
      await q(`INSERT INTO allocations(account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, percent, repeat_state, repeat_end_date)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [acc, p.id, project, sd, ed, mode, hours, percent, rep, rend]);
      allocations.push({ personId: p.id, startDate: sd, endDate: ed, mode, hoursPerDay: hours, percent, status: "confirmed", billable: true,
        repeatState: rep, repeatEndDate: rend, projectTentative: false, projectNonBillable: false, phaseNonBillable: false, taskBillable: null });
    }

    const args = [acc, FROM, TO];
    const sqlCap = await q("SELECT person_id::text AS p, day::text AS d, base_hours, capacity_hours FROM daily_capacity($1,$2,$3)", args);
    const sqlLoad = await q("SELECT person_id::text AS p, day::text AS d, planned_hours FROM daily_planned_load($1,$2,$3)", args);
    const sqlUtil = await q("SELECT person_id::text AS p, day::text AS d, capacity_hours, planned_hours, utilization FROM utilization($1,$2,$3)", args);
    return { input: { people, holidays, timeoffs, allocations, from: FROM, to: TO }, sqlCap, sqlLoad, sqlUtil };
  } finally {
    await db.exec("ROLLBACK");
  }
}

const key = (p: string, d: string) => `${p}|${d}`;
const index = <T extends { personId: string; day: string }>(rows: T[]) => new Map(rows.map((x) => [key(x.personId, x.day), x]));

describe(`parité SQL <-> TS de l'horaire daté (@BR-19, ${SCENARIOS} scénarios)`, () => {
  it("capacité, charge et utilisation identiques avec un historique d'horaires", async () => {
    let changed = 0;
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const s = await scenario(seed);
      const where = `seed ${seed}`;
      changed += s.input.people.filter((p) => (p.workSchedule?.length ?? 0) > 1).length;

      const cap = index(dailyCapacity(s.input));
      expect(cap.size, `${where} : lignes de capacité`).toBe(s.sqlCap.length);
      for (const r of s.sqlCap) {
        const t = cap.get(key(r.p, r.d))!;
        expect(close(num(r.base_hours), t.baseHours) && close(num(r.capacity_hours), t.capacityHours), `${where} capacité ${r.p} ${r.d}`).toBe(true);
      }
      const load = index(dailyPlannedLoad(s.input));
      expect(load.size, `${where} : lignes de charge`).toBe(s.sqlLoad.length);
      for (const r of s.sqlLoad) expect(close(num(r.planned_hours), load.get(key(r.p, r.d))?.plannedHours ?? null), `${where} charge ${r.p} ${r.d}`).toBe(true);
      const util = index(utilization(s.input));
      expect(util.size, `${where} : lignes d'utilisation`).toBe(s.sqlUtil.length);
      for (const r of s.sqlUtil) {
        const t = util.get(key(r.p, r.d))!;
        expect(close(num(r.capacity_hours), t.capacityHours) && close(num(r.planned_hours), t.plannedHours) && close(num(r.utilization), t.utilization),
          `${where} utilisation ${r.p} ${r.d}`).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(SCENARIOS / 2); // garde-fou : le générateur produit bien des historiques
  }, 300_000);
});
