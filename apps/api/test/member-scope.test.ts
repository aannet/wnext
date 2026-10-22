// RT-048 (US-6.1) : un member ne voit que ses assignations, API et temps réel compris. Base MIGRÉE (schema.sql puis migrations/,
// PGlite, rôle app_user donc RLS active). Matrice endpoint par endpoint : member lié (sa personne seule, autre personne = 404),
// member sans personne (listes vides), owner/admin/project_manager/guest inchangés (tout le compte) ; puis le flux temps réel
// filtré par abonné (rattrapage compris), avec la même règle.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { RealtimeServerMessage, ScheduleResponse } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRealtimeSession, devAuthenticate, dispatch, startServer, type Db, type HttpDeps, type RequestContext, type RunningServer } from "../src/index";

// Compte 1 : personnes 1 Mia (liée au member, utilisateur 4), 2 Bob, 3 Carl. Utilisateurs 1 owner, 2 admin, 3 pm, 4 member (personne 1),
// 5 guest, 6 member sans personne liée. Compte 2 : personne 4, utilisateur 7 admin.
const users: Record<string, RequestContext | null> = {
  owner: { accountId: "1", userId: "1", role: "owner" },
  admin: { accountId: "1", userId: "2", role: "admin" },
  pm: { accountId: "1", userId: "3", role: "project_manager" },
  member: { accountId: "1", userId: "4", role: "member" },
  guest: { accountId: "1", userId: "5", role: "guest" },
  lone: { accountId: "1", userId: "6", role: "member" },
  other: { accountId: "2", userId: "7", role: "admin" },
};
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const deps: HttpDeps = { db, authenticate: async (h) => users[String(h.authorization)] ?? null, newRequestId: () => "r" };
const send = (who: string, method: string, url: string, opts: { body?: unknown; ifMatch?: string } = {}) =>
  dispatch(deps, { method, url, headers: { authorization: who, ...(opts.ifMatch !== undefined && { "if-match": opts.ifMatch }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
const get = (who: string, url: string) => send(who, "GET", url);
const body = (r: { body: unknown }) => r.body as any;
const WINDOW = "from=2026-03-02&to=2026-03-08";
const ids = (items: Array<{ id: string }>) => items.map((x) => x.id).sort();

const seed: Record<string, string> = {};

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email, name) VALUES ('o@x.test','O'), ('a@x.test','A'), ('p@x.test','P'), ('m@x.test','Mia'), ('g@x.test','G'), ('l@x.test','L'), ('b@x.test','B');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Mia'), (1, 'Bob'), (1, 'Carl'), (2, 'Intrus');
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES
      (1,1,'owner',NULL), (1,2,'admin',NULL), (1,3,'project_manager',NULL), (1,4,'member',1), (1,5,'guest',NULL), (1,6,'member',NULL), (2,7,'admin',4);
    INSERT INTO projects (account_id, name) VALUES (1, 'P1'), (2, 'Q');
    INSERT INTO departments (account_id, name) VALUES (1, 'Design');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
    INSERT INTO holidays (account_id, name, hdate) VALUES (1, 'Férié', '2026-03-05');
    INSERT INTO project_team (account_id, project_id, person_id) VALUES (1, 1, 1), (1, 1, 2);
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES
      (1, 1, 1, '2026-03-02', '2026-03-03', 4), (1, 2, 1, '2026-03-02', '2026-03-04', 6), (1, 3, 1, '2026-03-05', '2026-03-05', 2);
    INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (1, 1, 1, '2026-03-06', '2026-03-06'), (1, 2, 1, '2026-03-06', '2026-03-06');
    INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1, 1, 1, '2026-03-02', 3), (1, 2, 1, '2026-03-02', 5);
  `);
  const q = async (sql: string) => (await pg.query<{ id: string }>(sql)).rows.map((r) => String(r.id));
  [seed.allocMia, seed.allocBob, seed.allocCarl] = await q("SELECT id FROM allocations WHERE account_id = 1 ORDER BY person_id");
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /schedule (RT-048)", () => {
  it("member : sa seule personne, ses allocations et ses congés ; référentiels inchangés", async () => {
    const r = await get("member", `/api/v1/schedule?${WINDOW}`);
    expect(r.status).toBe(200);
    const s = ScheduleResponse.parse(r.body);
    expect(s.people.map((p) => p.id)).toEqual(["1"]);
    expect(s.page.total).toBe(1);
    expect(s.allocations.map((a) => a.personId)).toEqual(["1"]);
    expect(s.timeoffs.map((t) => t.personId)).toEqual(["1"]);
    expect(s.holidays).toHaveLength(1);
    expect(s.departments).toHaveLength(1);
    expect(s.timeoffTypes).toHaveLength(1);
  });

  it("member sans personne liée : listes vides, pas d'erreur", async () => {
    const r = await get("lone", `/api/v1/schedule?${WINDOW}`);
    expect(r.status).toBe(200);
    const s = ScheduleResponse.parse(r.body);
    expect([s.people, s.allocations, s.timeoffs, s.projects]).toEqual([[], [], [], []]);
    expect(s.page).toEqual({ nextCursor: null, total: 0 });
  });

  it("filtres sur une autre personne : rien (le member ne contourne pas par projectId)", async () => {
    const s = ScheduleResponse.parse(body(await get("member", `/api/v1/schedule?${WINDOW}&projectId=1`)));
    expect(s.people.map((p) => p.id)).toEqual(["1"]);
  });

  it("owner, admin, project_manager et guest : tout le compte (inchangé)", async () => {
    for (const who of ["owner", "admin", "pm", "guest"]) {
      const s = ScheduleResponse.parse(body(await get(who, `/api/v1/schedule?${WINDOW}`)));
      expect(s.people.map((p) => p.id).sort(), who).toEqual(["1", "2", "3"]);
      expect(s.allocations, who).toHaveLength(3);
      expect(s.timeoffs, who).toHaveLength(2);
    }
  });
});

describe("matrice des lectures par personne (RT-048)", () => {
  // [route, vu par le member (sa personne), refusé au member (autre personne)]
  const own = (who: string) => ({
    person: get(who, "/api/v1/people/1"),
    allocations: get(who, `/api/v1/people/1/allocations?${WINDOW}`),
    projects: get(who, "/api/v1/people/1/projects"),
    history: get(who, "/api/v1/people/1/history"),
    allocation: get(who, `/api/v1/allocations/${seed.allocMia}`),
    logged: get(who, `/api/v1/logged-time?personId=1&${WINDOW}`),
  });
  const others = (who: string) => ({
    person: get(who, "/api/v1/people/2"),
    allocations: get(who, `/api/v1/people/2/allocations?${WINDOW}`),
    projects: get(who, "/api/v1/people/2/projects"),
    history: get(who, "/api/v1/people/2/history"),
    allocation: get(who, `/api/v1/allocations/${seed.allocBob}`),
    logged: get(who, `/api/v1/logged-time?personId=2&${WINDOW}`),
  });

  it("member : 200 sur sa personne, 404 NOT_FOUND sur une autre (sans révéler son existence)", async () => {
    for (const [route, p] of Object.entries(own("member"))) expect((await p).status, route).toBe(200);
    for (const [route, p] of Object.entries(others("member"))) {
      const r = await p;
      expect([r.status, body(r).code], route).toEqual([404, "NOT_FOUND"]);
    }
    // même réponse qu'une personne qui n'existe pas
    expect(body(await get("member", "/api/v1/people/2")).params).toEqual(body(await get("member", "/api/v1/people/999")).params);
    expect(body(await get("member", `/api/v1/allocations/${seed.allocBob}`)).params).toEqual(body(await get("member", "/api/v1/allocations/999999")).params);
  });

  it("member sans personne liée : 404 sur toute personne", async () => {
    for (const [route, p] of Object.entries(own("lone"))) expect((await p).status, route).toBe(404);
  });

  it("owner, admin, project_manager, guest : 200 partout (inchangé)", async () => {
    for (const who of ["owner", "admin", "pm", "guest"]) {
      for (const [route, p] of Object.entries({ ...own(who), ...others(who) })) expect((await p).status, `${who} ${route}`).toBe(200);
    }
  });

  it("listes : GET /people, /projects/{id}/allocations, /projects/{id}/team et /logged-time ne portent que sa personne", async () => {
    const people = body(await get("member", "/api/v1/people?includeInactive=true"));
    expect([ids(people.items), people.page.total]).toEqual([["1"], 1]);
    expect(body(await get("lone", "/api/v1/people")).items).toEqual([]);
    const allocs = body(await get("member", `/api/v1/projects/1/allocations?${WINDOW}`));
    expect([allocs.items.map((a: { personId: string }) => a.personId), allocs.page.total]).toEqual([["1"], 1]);
    expect(body(await get("member", `/api/v1/projects/1/allocations?${WINDOW}&personId=2`)).items).toEqual([]);
    const team = body(await get("member", "/api/v1/projects/1/team"));
    expect([team.items.map((t: { personId: string }) => t.personId), team.page.total]).toEqual([["1"], 1]);
    expect(body(await get("lone", "/api/v1/projects/1/team")).items).toEqual([]);
    expect(body(await get("member", `/api/v1/logged-time?personId=1&${WINDOW}`)).items.map((l: { personId: string }) => l.personId)).toEqual(["1"]);
    // les autres rôles : tout le compte
    expect(body(await get("guest", "/api/v1/people")).items).toHaveLength(3);
    expect(body(await get("admin", "/api/v1/projects/1/team")).items).toHaveLength(2);
    expect(body(await get("pm", `/api/v1/projects/1/allocations?${WINDOW}`)).items).toHaveLength(3);
  });

  it("référentiels lisibles par le member (projets, départements, types de congé, fériés, mes notifications, mes vues)", async () => {
    for (const url of ["/api/v1/projects", "/api/v1/projects/1", "/api/v1/departments", "/api/v1/roles", "/api/v1/timeoff-types", "/api/v1/holidays", "/api/v1/clients", "/api/v1/me", "/api/v1/account", "/api/v1/notifications", "/api/v1/saved-views"]) {
      expect((await get("member", url)).status, url).toBe(200);
    }
  });

  it("aucune écriture ni lecture réservée ouverte au member (inchangé)", async () => {
    expect((await get("member", "/api/v1/people/1/deactivation-summary")).status).toBe(403);
    expect((await get("member", "/api/v1/projects/1/team/2/removal-summary")).status).toBe(403);
    expect((await send("member", "POST", "/api/v1/allocations", { body: { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-02", load: { mode: "hours", hoursPerDay: 1 } } })).status).toBe(403);
  });

  it("isolation : la personne d'un autre compte reste un 404, pour tout rôle", async () => {
    for (const who of ["member", "admin"]) expect((await get(who, "/api/v1/people/4")).status).toBe(404);
  });
});

describe("temps réel filtré par abonné (RT-048)", () => {
  const head = async () => body(await get("admin", `/api/v1/schedule?${WINDOW}`)).changeCursor as string;
  const sub = (cursor: string) => JSON.stringify({ v: 1, type: "subscribe", cursor });
  function open(who: string) {
    const out: RealtimeServerMessage[] = [];
    const session = createRealtimeSession({ db, ctx: users[who]!, send: (m) => { out.push(RealtimeServerMessage.parse(m)); } });
    const changes = () => out.flatMap((m) => (m.type === "changes" ? m.changes.map((c) => `${c.entity}:${c.id}:${c.op}`) : []));
    return { out, session, changes };
  }
  const alloc = async (personId: string) => body(await send("admin", "POST", "/api/v1/allocations", {
    body: { personId, projectId: "1", startDate: "2026-03-02", endDate: "2026-03-02", load: { mode: "hours", hoursPerDay: 1 } } })) as { id: string; version: number };

  it("flux direct : le member reçoit le changement de sa personne, pas celui d'une autre ; l'admin reçoit les deux", async () => {
    const c = await head();
    const m = open("member"); const a = open("admin"); const g = open("guest");
    for (const s of [m, a, g]) await s.session.receive(sub(c));
    const bob = await alloc("2");
    const mia = await alloc("1");
    for (const s of [m, a, g]) await s.session.poll();
    expect(m.changes()).toEqual([`allocations:${mia.id}:insert`]);
    expect(a.changes()).toEqual([`allocations:${bob.id}:insert`, `allocations:${mia.id}:insert`]);
    expect(g.changes()).toEqual(a.changes());
  });

  it("rattrapage après reconnexion : même filtre ; ready porte la tête du journal", async () => {
    const c = await head();
    const bob = await alloc("2");
    const mia = await alloc("1");
    await send("admin", "DELETE", `/api/v1/allocations/${bob.id}`, { ifMatch: `"${bob.version}"` });
    await send("admin", "DELETE", `/api/v1/allocations/${mia.id}`, { ifMatch: `"${mia.version}"` });
    const m = open("member");
    await m.session.receive(sub(c));
    expect(m.changes()).toEqual([`allocations:${mia.id}:insert`, `allocations:${mia.id}:delete`]);
    expect(m.out.at(-1)).toEqual({ v: 1, type: "ready", cursor: await head() });
  });

  it("réaffectation : l'ancienne ET la nouvelle personne l'apprennent, pas un tiers", async () => {
    const mia = await alloc("1");
    const c = await head();
    const m = open("member"); const l = open("lone");
    for (const s of [m, l]) await s.session.receive(sub(c));
    const moved = await send("admin", "PATCH", `/api/v1/allocations/${mia.id}`, { body: { personId: "2" }, ifMatch: `"${mia.version}"` });
    expect(moved.status).toBe(200);
    const back = await send("admin", "PATCH", `/api/v1/allocations/${mia.id}`, { body: { personId: "3" }, ifMatch: `"${body(moved).version}"` });
    expect(back.status).toBe(200);
    for (const s of [m, l]) await s.session.poll();
    expect(m.changes()).toEqual([`allocations:${mia.id}:update`]); // Mia -> Bob seulement ; Bob -> Carl ne la concerne plus
    expect(l.changes()).toEqual([]);
  });

  it("personnes, congés, temps saisi et équipe : filtrés ; référentiels (projets, fériés) : diffusés", async () => {
    const c = await head();
    const m = open("member"); const l = open("lone");
    for (const s of [m, l]) await s.session.receive(sub(c));
    const person = async (id: string) => {
      const cur = body(await get("admin", `/api/v1/people/${id}`));
      expect((await send("admin", "PATCH", `/api/v1/people/${id}`, { body: { tags: ["x"] }, ifMatch: `"${cur.version}"` })).status).toBe(200);
    };
    await person("2");
    await person("1");
    expect((await send("admin", "POST", "/api/v1/timeoffs", { body: { personId: "2", typeId: "1", startDate: "2026-04-01", endDate: "2026-04-01" } })).status).toBe(201);
    expect((await send("admin", "POST", "/api/v1/logged-time", { body: { personId: "2", projectId: "1", workDate: "2026-03-03", hours: 1 } })).status).toBe(201);
    expect((await send("admin", "PUT", "/api/v1/projects/1/team/3")).status).toBe(200);
    expect((await send("admin", "POST", "/api/v1/holidays", { body: { name: "Pâques", date: "2026-04-06" } })).status).toBe(201);
    for (const s of [m, l]) await s.session.poll();
    expect(m.changes()).toEqual(["people:1:update", expect.stringMatching(/^holidays:\d+:insert$/)]);
    expect(l.changes()).toEqual([expect.stringMatching(/^holidays:\d+:insert$/)]);
  });

  it("WebSocket de bout en bout : le member ne reçoit pas l'allocation d'une autre personne, reçoit la sienne", async () => {
    const srv: RunningServer = await startServer({ db, authenticate: devAuthenticate, onError: () => {} });
    try {
      const h = (u: RequestContext) => ({ "x-dev-account-id": u.accountId, "x-dev-user-id": u.userId, "x-dev-role": u.role });
      const c = await head();
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/realtime`, { headers: h(users.member!) });
      const got: RealtimeServerMessage[] = [];
      ws.on("message", (d) => got.push(RealtimeServerMessage.parse(JSON.parse(d.toString()))));
      await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
      const bob = await alloc("2");
      const mia = await alloc("1");
      ws.send(sub(c));
      for (let i = 0; i < 200 && !got.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 25));
      ws.close();
      const seen = got.flatMap((m) => (m.type === "changes" ? m.changes.map((x) => x.id) : []));
      expect(seen).toContain(mia.id);
      expect(seen).not.toContain(bob.id);
    } finally { await srv.close(); }
  });
});
