// Les DATE de Postgres ne portent pas de fuseau : l'API doit les rendre telles quelles (YYYY-MM-DD), quel que soit TZ du processus.
// Régression : `pg` livre une DATE en Date à minuit LOCAL, et `toISOString().slice(0, 10)` reculait d'un jour à l'est de UTC.
// Vrai PostgreSQL (le chemin du driver `pg`) : PGlite parse les DATE en UTC et ne peut pas reproduire le défaut.
// Node relit process.env.TZ à chaque affectation : on bascule de fuseau dans le même processus, UTC en dernier.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type HttpDeps, type RequestContext } from "../../apps/api/src/index";
import { startCluster, type Cluster } from "./pg-harness";

// @BR-01
const ZONES = ["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata", "UTC"];
const ORIGINAL_TZ = process.env.TZ;
const ctx: RequestContext = { accountId: "1", userId: "1", role: "admin" };
let c: Cluster;
let deps: HttpDeps;
const send = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await dispatch(deps, { method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body as any;
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

beforeAll(async () => {
  c = await startCluster({ typed: true });
  deps = { db: c.db, authenticate: async () => ctx, newRequestId: () => "r" };
  await c.admin.query(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name) SELECT 1, 'p' || g FROM generate_series(1, 4) g;
    INSERT INTO projects (account_id, name, start_date, end_date) VALUES (1, 'P', '2027-03-01', '2027-12-31');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
  `);
}, 180_000);
afterEach(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });
afterAll(async () => { await c?.stop(); }, 60_000);

describe.each(ZONES.map((tz, i) => ({ tz, i })))("dates calendaires sous TZ=$tz", ({ tz, i }) => {
  const monday = addDays("2027-03-01", 7 * i); // un lundi distinct par fuseau (exclusion des congés)
  const friday = addDays(monday, 4);
  const person = String(i + 1);

  it("lecture et écriture rendent et stockent exactement les mêmes jours", async () => {
    process.env.TZ = tz;
    expect(weekday(monday)).toBe(1);

    const a = await send("POST", "/api/v1/allocations", { personId: person, projectId: "1", startDate: monday, endDate: friday, load: { mode: "hours", hoursPerDay: 2 } });
    expect([a.startDate, a.endDate]).toEqual([monday, friday]);
    // un PATCH ne doit réécrire en base ni la date décalée ni rien d'autre
    const p = await send("PATCH", `/api/v1/allocations/${a.id}`, { load: { mode: "hours", hoursPerDay: 3 } }, { "if-match": `"${a.version}"` });
    expect([p.startDate, p.endDate]).toEqual([monday, friday]);
    const stored = (await c.admin.query("SELECT start_date::text AS s, end_date::text AS e FROM allocations WHERE id = $1", [a.id])).rows[0];
    expect([stored.s, stored.e]).toEqual([monday, friday]);

    const t = await send("POST", "/api/v1/timeoffs", { personId: person, typeId: "1", startDate: monday, endDate: friday });
    expect([t.startDate, t.endDate]).toEqual([monday, friday]);
    await send("POST", "/api/v1/holidays", { name: `Férié ${tz}`, date: friday });
    const ph = await send("POST", "/api/v1/phases", { projectId: "1", name: "Ph", startDate: monday, endDate: friday });
    expect([ph.startDate, ph.endDate]).toEqual([monday, friday]);
    const ms = await send("POST", "/api/v1/milestones", { projectId: "1", name: "Jalon", dueDate: friday });
    expect(ms.dueDate).toBe(friday);
    const lt = await send("POST", "/api/v1/logged-time", { personId: person, projectId: "1", workDate: monday, hours: 2 });
    expect(lt.workDate).toBe(monday);
    const pr = await send("GET", "/api/v1/projects/1");
    expect([pr.startDate, pr.endDate]).toEqual(["2027-03-01", "2027-12-31"]);

    const s = await send("GET", `/api/v1/schedule?from=${monday}&to=${friday}`);
    const mine = s.allocations.find((x: any) => x.id === a.id);
    expect([mine.startDate, mine.endDate]).toEqual([monday, friday]);
    expect(s.timeoffs.find((x: any) => x.id === t.id)).toMatchObject({ startDate: monday, endDate: friday });
    expect(s.holidays.some((h: any) => h.date === friday)).toBe(true);
    expect(s.projects[0]).toMatchObject({ startDate: "2027-03-01", endDate: "2027-12-31" });
    const l = await send("GET", `/api/v1/logged-time?personId=${person}&from=${monday}&to=${friday}`);
    expect(l.items.map((x: any) => x.workDate)).toEqual([monday]);
    const phl = await send("GET", "/api/v1/phases?projectId=1");
    expect(phl.items.some((x: any) => x.startDate === monday && x.endDate === friday)).toBe(true);
  });
});
