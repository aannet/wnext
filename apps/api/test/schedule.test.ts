// GET /schedule contre schema.sql réel (PGlite) : la réponse respecte le contrat, le moteur en tire les MÊMES nombres que
// les fonctions SQL, la pagination est complète et sans doublon, l'isolation entre comptes tient, aucun champ sensible ne sort.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScheduleResponse } from "@wnext/contracts";
import { scheduleUtilization } from "@wnext/engine";
import { ApiFailure, getSchedule, type Db, type RequestContext } from "../src/index";

// @BR-01 @BR-24 @BR-38
const FROM = "2026-03-02";
const TO = "2026-03-20";
const ctxA: RequestContext = { accountId: "1", userId: "1", role: "admin" };
const ctxB: RequestContext = { accountId: "2", userId: "1", role: "admin" };

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction((tx) => fn(tx as never)) };
const get = (q: Partial<Parameters<typeof getSchedule>[2]> = {}, ctx = ctxA) => getSchedule(db, ctx, { from: FROM, to: TO, ...q });
const failure = async (p: Promise<unknown>) => p.then(() => null, (e) => e as ApiFailure);

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email, name) VALUES ('admin@x.test', 'Admin');
    INSERT INTO accounts (name, week_start, capacity_thresholds) VALUES ('A', 1, '{"under_percent": 90}'), ('B', 7, DEFAULT);
    INSERT INTO departments (account_id, name) VALUES (1, 'Design'), (1, 'Dev'), (2, 'Autre');
    INSERT INTO roles (account_id, name) VALUES (1, 'Senior'), (2, 'Autre');
    -- compte A : 7 personnes (dont 1 inactive), noms triés avec un doublon de nom pour exercer le départage par id
    INSERT INTO people (account_id, department_id, role_id, name, email, country, cost_rate, tags, active, work_days_hours) VALUES
      (1, 1, 1, 'Alice', 'alice@x.test', 'FR', 99.5, '{front,lead}', true,  '{8,8,8,8,8,0,0}'),
      (1, 2, 1, 'Bob',   'bob@x.test',   'DE', 77,   '{back}',       true,  '{0,4,4,4,0,0,0}'),
      (1, 2, NULL, 'Chloé', NULL,        NULL, NULL, '{back,lead}',  true,  '{7.5,7.5,7.5,7.5,7.5,0,0}'),
      (1, NULL, NULL, 'Dan', NULL,       'FR', NULL, '{}',           true,  '{8,8,8,8,8,0,0}'),
      (1, NULL, NULL, 'Dan', NULL,       'FR', NULL, '{}',           true,  '{8,8,8,8,8,0,0}'),
      (1, NULL, NULL, 'Eve', NULL,       NULL, NULL, '{}',           true,  '{8,8,8,8,8,0,0}'),
      (1, NULL, NULL, 'Zed', NULL,       NULL, NULL, '{}',           false, '{8,8,8,8,8,0,0}'),
      (2, 3, 2, 'Intrus', 'intrus@y.test', 'US', 1, '{}',            true,  '{8,8,8,8,8,0,0}');
    INSERT INTO projects (account_id, name, project_code, color, status, budget_amount) VALUES
      (1, 'Refonte', 'R-1', '#3B82F6', 'in_progress', 1000), (1, 'Pitch', NULL, '#FF0000', 'tentative', NULL), (1, 'Vide', NULL, '#00FF00', 'planned', NULL),
      (2, 'Secret', NULL, '#123456', 'planned', 5);
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, percent, status) VALUES
      (1, 1, 1, '2026-03-02', '2026-03-06', 'hours', 6, NULL, 'confirmed'),
      (1, 1, 2, '2026-03-03', '2026-03-03', 'hours', 4, NULL, 'tentative'),
      (1, 2, 1, '2026-03-03', '2026-03-03', 'percentage', NULL, 150, 'confirmed'),
      (1, 3, 2, '2026-03-16', '2026-03-17', 'hours', 9, NULL, 'confirmed'),
      (1, 4, 1, '2026-02-01', '2026-02-02', 'hours', 8, NULL, 'confirmed'),    -- hors fenêtre
      (2, 8, 4, '2026-03-02', '2026-03-06', 'hours', 8, NULL, 'confirmed');
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, status, repeat_state, repeat_end_date)
      VALUES (1, 6, 1, '2026-02-23', '2026-02-23', 'hours', 2, 'confirmed', 'weekly', '2026-03-30'); -- série qui recoupe la fenêtre
    INSERT INTO timeoff_types (account_id, name, deducted) VALUES (1, 'Vacances', true), (1, 'Formation', false), (2, 'X', true);
    INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date, approval_status) VALUES
      (1, 1, 1, '2026-03-04', '2026-03-04', 'approved'),
      (1, 3, 2, '2026-03-09', '2026-03-10', 'pending'),
      (1, 4, 1, '2026-01-05', '2026-01-06', 'approved');                       -- hors fenêtre
    INSERT INTO holidays (account_id, name, hdate, country) VALUES (1, 'Jour férié FR', '2026-03-12', 'FR'), (1, 'Hors fenêtre', '2026-04-01', NULL), (2, 'Autre compte', '2026-03-12', NULL);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("contrat", () => {
  it("la réponse valide ScheduleResponse et contient les bons ensembles", async () => {
    const r = await get();
    expect(ScheduleResponse.safeParse(r).success).toBe(true);
    expect(r.people.map((p) => p.name)).toEqual(["Alice", "Bob", "Chloé", "Dan", "Dan", "Eve"]); // Zed inactive exclue
    expect(r.page).toEqual({ nextCursor: null, total: 6 });
    expect(r.account).toEqual({ weekStart: 1, capacityThresholds: { underPercent: 90 } });
    expect(r.allocations.map((a) => a.id)).toEqual(["1", "2", "3", "4", "7"]); // l'allocation de février et celle de B sont absentes ; la série weekly recoupe
    expect(r.timeoffs.map((t) => t.id)).toEqual(["1", "2"]);
    expect(r.holidays.map((h) => h.name)).toEqual(["Jour férié FR"]);
    expect(r.projects.map((p) => p.name)).toEqual(["Refonte", "Pitch"]); // 'Vide' n'est référencé par aucune allocation
    expect(r.timeoffTypes.map((t) => t.name)).toEqual(["Vacances", "Formation"]);
    expect(r.departments.map((d) => d.name)).toEqual(["Design", "Dev"]);
    expect(r.roles.map((d) => d.name)).toEqual(["Senior"]);
    const pct = r.allocations.find((a) => a.id === "3")!;
    expect(pct).toMatchObject({ mode: "percentage", percent: 150, hoursPerDay: null });
    expect(r.people[0]).toMatchObject({ id: "1", version: 1, country: "FR", workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: ["front", "lead"] });
  });

  it("ne renvoie aucun coût, e-mail ni budget (zéro fuite)", async () => {
    const text = JSON.stringify(await get({ includeInactive: true }));
    for (const secret of ["99.5", "alice@x.test", "bob@x.test", "1000", "costRate", "email", "budget"]) expect(text).not.toContain(secret);
  });

  it("isole les comptes : B ne voit rien de A et inversement", async () => {
    const b = await get({}, ctxB);
    expect(b.people.map((p) => p.name)).toEqual(["Intrus"]);
    expect(b.projects.map((p) => p.name)).toEqual(["Secret"]);
    expect(b.holidays.map((h) => h.name)).toEqual(["Autre compte"]);
    expect(b.account.weekStart).toBe(7);
    expect(b.account.capacityThresholds.underPercent).toBe(80);
    const a = JSON.stringify(await get());
    expect(a).not.toContain("Intrus");
    expect(a).not.toContain("Secret");
  });
});

describe("parité avec SQL", () => {
  it("le moteur, alimenté par la seule réponse, redonne utilization() de SQL pour toutes les personnes et tous les jours", async () => {
    const r = await get({ includeInactive: true });
    const eng = scheduleUtilization(r);
    const sql = (await pg.query<{ person_id: string; day: Date; capacity_hours: string; planned_hours: string; overtime_hours: string; is_overbooked: boolean }>(
      "SELECT person_id::text, day, capacity_hours, planned_hours, overtime_hours, is_overbooked FROM utilization(1, $1::date, $2::date)", [FROM, TO])).rows;
    expect(sql.length).toBeGreaterThan(50);
    const key = (p: string, d: string) => `${p}|${d}`;
    const e = new Map(eng.map((x) => [key(x.personId, x.day), x]));
    for (const s of sql) {
      const x = e.get(key(s.person_id, s.day.toISOString().slice(0, 10)))!;
      expect(x, `${s.person_id} ${s.day}`).toBeDefined();
      expect(x.capacityHours).toBeCloseTo(Number(s.capacity_hours), 6);
      expect(x.plannedHours).toBeCloseTo(Number(s.planned_hours), 6);
      expect(x.overtimeHours).toBeCloseTo(Number(s.overtime_hours), 6);
      expect(x.isOverbooked).toBe(s.is_overbooked);
    }
    expect(eng.length).toBe(sql.length);
  });
});

describe("pagination et filtres", () => {
  it("parcourt toutes les personnes sans doublon ni trou, y compris deux noms identiques à cheval sur deux pages", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await get({ limit: 4, cursor });
      seen.push(...r.people.map((p) => p.id));
      expect(r.page.total).toBe(6);
      cursor = r.page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toEqual(["1", "2", "3", "4", "5", "6"]);
    const mid = await get({ limit: 4 });
    expect(mid.people).toHaveLength(4);
    expect(mid.allocations.every((a) => mid.people.some((p) => p.id === a.personId))).toBe(true); // allocations de la page seulement
  });

  it("filtre par département, rôle, tag, projet et inclut les inactifs à la demande", async () => {
    expect((await get({ departmentId: "2" })).people.map((p) => p.name)).toEqual(["Bob", "Chloé"]);
    expect((await get({ roleId: "1" })).people.map((p) => p.name)).toEqual(["Alice", "Bob"]);
    expect((await get({ tag: "lead" })).people.map((p) => p.name)).toEqual(["Alice", "Chloé"]);
    expect((await get({ includeInactive: true })).people.map((p) => p.name)).toContain("Zed");
    const byProject = await get({ projectId: "2" });
    expect(byProject.people.map((p) => p.name)).toEqual(["Alice", "Chloé"]);
    expect(byProject.allocations.some((a) => a.projectId === "1")).toBe(true); // leurs autres allocations restent (capacité exacte)
    expect(byProject.page.total).toBe(2);
  });
});

describe("erreurs", () => {
  it("rejette une plage inversée ou > 400 jours (SCHEDULE_RANGE_INVALID)", async () => {
    expect((await failure(get({ from: "2026-03-10", to: "2026-03-01" })))?.code).toBe("SCHEDULE_RANGE_INVALID");
    expect((await failure(get({ from: "2026-01-01", to: "2027-02-06" })))?.code).toBe("SCHEDULE_RANGE_INVALID");
    expect(await failure(get({ from: "2026-01-01", to: "2027-02-05" }))).toBeNull(); // 400 jours d'écart : accepté, comme SQL
  });

  it("rejette un curseur illisible (SCHEDULE_CURSOR_INVALID)", async () => {
    for (const cursor of ["n'importe quoi", Buffer.from('{"name":1}').toString("base64url"), Buffer.from('{"name":"A","id":"x; DROP"}').toString("base64url")]) {
      expect((await failure(get({ cursor })))?.code).toBe("SCHEDULE_CURSOR_INVALID");
    }
  });
});

describe("curseur de changement", () => {
  it("avance quand une allocation est modifiée ou supprimée", async () => {
    const c0 = (await get()).changeCursor;
    await pg.exec("UPDATE allocations SET hours_per_day = 7 WHERE id = 1");
    const c1 = (await get()).changeCursor;
    expect(c1).not.toBe(c0);
    await pg.exec("DELETE FROM allocations WHERE id = 5");
    expect((await get()).changeCursor).not.toBe(c1);
  });
});
