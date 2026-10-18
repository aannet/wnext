// Concurrence réelle (deux connexions ou plus) sur PostgreSQL : verrous de ligne, verrou optimiste, exclusion des congés,
// journal de changements, retrait d'équipe BR-10. Ce que PGlite (une seule connexion) ne peut pas prouver.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createChangeHub, createRealtimeSession, dispatch, pgNotifier, readChanges, type HttpDeps, type RequestContext } from "../../apps/api/src/index";
import { startCluster, type Cluster } from "./pg-harness";

// @BR-01 @BR-10 @BR-14
let c: Cluster;
const ctx: RequestContext = { accountId: "1", userId: "1", role: "admin" };
let deps: HttpDeps;
const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  dispatch(deps, { method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const err = (r: { body: unknown }) => r.body as { code: string; params: Record<string, any> };
const n = async (sql: string) => Number((await c.admin.query(sql)).rows[0].n);
const pending = <T>(p: Promise<T>) => Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), 300))]);
let day = 0;
const nextDay = () => { const d = new Date(Date.UTC(2027, 0, 1 + day++)); return d.toISOString().slice(0, 10); };
const alloc = (personId: string, projectId = "1", d = nextDay()) =>
  ({ personId, projectId, startDate: d, endDate: d, load: { mode: "hours", hoursPerDay: 2 } });

beforeAll(async () => {
  c = await startCluster();
  deps = { db: c.db, authenticate: async () => ctx, newRequestId: () => "r" };
  await c.admin.query(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name) SELECT 1, 'p' || g FROM generate_series(1, 12) g;
    INSERT INTO projects (account_id, name) VALUES (1,'P'), (1,'Q');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
  `);
}, 180_000);
afterAll(async () => { await c?.stop(); }, 60_000);

describe("verrou optimiste (FOR UPDATE + row_version)", () => {
  it("deux PATCH simultanés avec la même version : un seul gagne, l'autre reçoit VERSION_CONFLICT", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await send("POST", "/api/v1/allocations", alloc("1"));
      const id = (a.body as { id: string }).id;
      const patch = (h: number) => send("PATCH", `/api/v1/allocations/${id}`, { load: { mode: "hours", hoursPerDay: h } }, { "if-match": '"1"' });
      const [x, y] = await Promise.all([patch(3), patch(4)]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const loser = x.status === 409 ? x : y;
      expect(err(loser)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
      expect(await n(`SELECT row_version AS n FROM allocations WHERE id = ${id}`)).toBe(2);
    }
  });

  it("un PATCH bloqué derrière une écriture concurrente attend, puis relit la version à jour (pas de mise à jour perdue)", async () => {
    const id = (await send("POST", "/api/v1/allocations", alloc("2"))).body as { id: string };
    const holder = await c.hold(ctx);
    await holder.query(`UPDATE allocations SET hours_per_day = 5 WHERE id = ${id.id}`); // version 2, non validée
    const p = send("PATCH", `/api/v1/allocations/${id.id}`, { load: { mode: "hours", hoursPerDay: 7 } }, { "if-match": '"1"' });
    await c.waitBlocked();
    expect(await pending(p)).toBe(true);
    await holder.commit();
    const r = await p;
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: 2 } });
    expect(await n(`SELECT hours_per_day AS n FROM allocations WHERE id = ${id.id}`)).toBe(5); // l'écriture concurrente n'est pas écrasée
  });

  it("DELETE avec une version périmée derrière une mise à jour concurrente : refus, la ligne survit", async () => {
    const id = ((await send("POST", "/api/v1/allocations", alloc("3"))).body as { id: string }).id;
    const holder = await c.hold(ctx);
    await holder.query(`UPDATE allocations SET hours_per_day = 6 WHERE id = ${id}`);
    const p = send("DELETE", `/api/v1/allocations/${id}`, undefined, { "if-match": '"1"' });
    await c.waitBlocked();
    await holder.commit();
    const r = await p;
    expect(err(r).code).toBe("VERSION_CONFLICT");
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE id = ${id}`)).toBe(1);
  });
});

describe("congés : exclusion de chevauchement", () => {
  const to = (personId: string, startDate: string, endDate: string) => send("POST", "/api/v1/timeoffs", { personId, typeId: "1", startDate, endDate });
  it("deux créations simultanées qui se chevauchent : une seule réussit, l'autre TIMEOFF_OVERLAP (jamais un 500, même en cas d'interblocage)", async () => {
    // Les deux insertions peuvent se bloquer mutuellement sur la contrainte d'exclusion : Postgres annule l'une (40P01), withContext la rejoue.
    for (let round = 0; round < 15; round++) {
      const month = String(1 + (round % 12)).padStart(2, "0");
      const year = 2030 + Math.floor(round / 12);
      const [x, y] = await Promise.all([to("4", `${year}-${month}-01`, `${year}-${month}-05`), to("4", `${year}-${month}-03`, `${year}-${month}-08`)]);
      expect([x.status, y.status].sort(), `tour ${round}`).toEqual([201, 409]);
      expect(err(x.status === 409 ? x : y).code).toBe("TIMEOFF_OVERLAP");
    }
    expect(await n("SELECT count(*) AS n FROM timeoffs WHERE person_id = 4 AND start_date >= '2030-01-01'")).toBe(15);
  }, 60_000);
  it("interblocage provoqué (attentes croisées sur la contrainte d'exclusion) : l'API ne répond jamais 500", async () => {
    const ins = (a: string, b: string) => `INSERT INTO timeoffs (account_id, person_id, timeoff_type_id, start_date, end_date) VALUES (1, 5, 1, '${a}', '${b}')`;
    const holder = await c.hold(ctx);
    await holder.query(ins("2031-01-01", "2031-01-02")); // tenu, non validé
    const api = to("5", "2031-01-02", "2031-01-08"); // attend la ligne du holder (exclusion)
    await c.waitBlocked();
    const second = holder.query(ins("2031-01-07", "2031-01-09")).then(() => "ok", (e) => String(e.code)); // attend l'API : interblocage
    const outcome = await second; // ~1 s (deadlock_timeout), Postgres annule l'une des deux
    if (outcome === "ok") await holder.commit(); else await holder.rollback();
    const r = await api;
    expect(r.status).not.toBe(500);
    if (outcome === "ok") expect(err(r).code).toBe("TIMEOFF_OVERLAP"); // l'API a été annulée puis rejouée contre l'état validé
    else expect(r.status).toBe(201);
  }, 30_000);
  it("des congés qui ne se chevauchent pas passent tous en parallèle", async () => {
    const rs = await Promise.all([1, 2, 3, 4].map((i) => to("10", `2027-09-0${i}`, `2027-09-0${i}`)));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
  });
});

describe("journal de changements (change_log) sous écritures parallèles", () => {
  it("numérotation sans trou ni doublon ; un lecteur concurrent voit toujours tout ce qui précède son curseur", async () => {
    const first = await readChanges(c.db, ctx, 0, 1);
    const start = Number(first.head);
    let writing = true;
    let cursor = start;
    let polls = 0;
    const reader = (async () => {
      while (writing) {
        const r = await readChanges(c.db, ctx, cursor, 1000);
        if (r.status !== "ok") throw new Error("curseur périmé");
        const head = Number(r.head);
        // Invariant du schéma : un lecteur qui voit head = N a vu TOUS les seq <= N, donc exactement head - cursor changements.
        expect(r.changes.length, `sondage ${polls} (curseur ${cursor}, head ${head})`).toBe(head - cursor);
        expect(head).toBeGreaterThanOrEqual(cursor);
        cursor = head;
        polls++;
      }
    })();
    const writers = Array.from({ length: 6 }, (_, w) => (async () => {
      for (let i = 0; i < 8; i++) await send("POST", "/api/v1/allocations", alloc(String(1 + w), "2"));
    })());
    await Promise.all(writers);
    writing = false;
    await reader;
    expect(polls).toBeGreaterThan(1);
    const rows = (await c.admin.query("SELECT seq FROM change_log WHERE account_id = 1 AND seq > $1 ORDER BY seq", [start])).rows.map((r) => Number(r.seq));
    expect(rows).toEqual(Array.from({ length: 48 }, (_, i) => start + 1 + i)); // contigus, sans doublon
    const final = await readChanges(c.db, ctx, start, 1000);
    expect(final.status === "ok" && final.changes.length).toBe(48);
  }, 60_000);
});

describe("retrait d'équipe BR-10 : verrou sur la personne", () => {
  it("une allocation insérée en parallèle (non validée) fait attendre le retrait, qui voit alors la confirmation périmée", async () => {
    const person = "11";
    await send("PUT", `/api/v1/projects/1/team/${person}`);
    await send("POST", "/api/v1/allocations", alloc(person));
    const holder = await c.hold(ctx);
    const d = nextDay();
    await holder.query(`INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, ${person}, 1, '${d}', '${d}', 'hours', 2)`);
    const p = send("POST", `/api/v1/projects/1/team/${person}/removal`, { confirmation: { allocationCount: 1, logCount: 0, logHours: 0 } });
    await c.waitBlocked();
    expect(await pending(p)).toBe(true);
    await holder.commit();
    const r = await p;
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: "TEAM_REMOVAL_STALE_CONFIRMATION", params: { allocationCount: 2 } });
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE person_id = ${person} AND project_id = 1`)).toBe(2); // rien de supprimé
  });

  it("un temps saisi inséré en parallèle puis validé est vu par le retrait, jamais laissé orphelin", async () => {
    const person = "12";
    await send("POST", "/api/v1/allocations", alloc(person));
    const holder = await c.hold(ctx);
    await holder.query(`INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1, ${person}, 1, '2027-02-01', 3)`);
    const p = send("POST", `/api/v1/projects/1/team/${person}/removal`, { confirmation: { allocationCount: 1, logCount: 0, logHours: 0 } });
    await c.waitBlocked();
    await holder.commit();
    expect(err(await p).code).toBe("TEAM_REMOVAL_STALE_CONFIRMATION");
    expect(await n(`SELECT count(*) AS n FROM logged_time WHERE person_id = ${person}`)).toBe(1);
  });

  it("à l'inverse : une allocation créée pendant que le retrait tient le verrou attend la fin du retrait", async () => {
    const person = "9";
    await send("POST", "/api/v1/allocations", alloc(person));
    const holder = await c.hold(ctx); // joue le retrait en cours : même verrou que removeFromTeam
    await holder.query(`SELECT 1 FROM people WHERE id = ${person} FOR UPDATE`);
    const p = send("POST", "/api/v1/allocations", alloc(person));
    await c.waitBlocked();
    expect(await pending(p)).toBe(true);
    await holder.query(`DELETE FROM allocations WHERE person_id = ${person}`);
    await holder.commit();
    expect((await p).status).toBe(201);
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE person_id = ${person}`)).toBe(1); // créée APRÈS le retrait
  });

  it("deux retraits simultanés confirmés : un seul supprime, l'autre ne trouve plus rien (200 à zéro)", async () => {
    const person = "8";
    for (let i = 0; i < 2; i++) await send("POST", "/api/v1/allocations", alloc(person));
    const body = { confirmation: { allocationCount: 2, logCount: 0, logHours: 0 } };
    const rs = await Promise.all([1, 2, 3].map(() => send("POST", `/api/v1/projects/1/team/${person}/removal`, body)));
    const removed = rs.map((r) => (r.status === 200 ? (r.body as { removedAllocations: number }).removedAllocations : -r.status));
    expect(removed.filter((x) => x === 2)).toHaveLength(1);
    for (const r of rs) if (r.status !== 200) expect(err(r).code).toBe("TEAM_REMOVAL_STALE_CONFIRMATION"); // la confirmation des suivants n'est plus vraie
    expect(await n(`SELECT count(*) AS n FROM allocations WHERE person_id = ${person} AND project_id = 1`)).toBe(0);
  });
});

describe("entités de référence", () => {
  it("deux créations simultanées du même nom : une seule réussit, l'autre ALREADY_EXISTS (jamais un 500)", async () => {
    for (let round = 0; round < 5; round++) {
      const rs = await Promise.all([1, 2, 3].map(() => send("POST", "/api/v1/departments", { name: `Concurrent ${round}` })));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      for (const r of rs) if (r.status === 409) expect(err(r).code).toBe("ALREADY_EXISTS");
    }
  });

  it("suppression d'un département pendant qu'une personne s'y rattache (non validée) : attend, puis REFERENCE_IN_USE, personne détachée", async () => {
    const d = (await send("POST", "/api/v1/departments", { name: "Éphémère" })).body as { id: string };
    const holder = await c.hold(ctx);
    await holder.query(`INSERT INTO people (account_id, name, department_id) VALUES (1, 'rattaché', ${d.id})`);
    const p = send("DELETE", `/api/v1/departments/${d.id}`, undefined, { "if-match": '"1"' });
    await c.waitBlocked();
    expect(await pending(p)).toBe(true);
    await holder.commit();
    const r = await p;
    expect(err(r)).toMatchObject({ code: "REFERENCE_IN_USE", params: { entity: "department", people: 1 } });
    expect(await n(`SELECT count(*) AS n FROM people WHERE department_id = ${d.id}`)).toBe(1); // non détachée en silence
  });
});

describe("ajout à l'équipe", () => {
  it("cinq PUT simultanés : un seul added=true, une seule ligne", async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => send("PUT", "/api/v1/projects/2/team/7")));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(rs.filter((r) => (r.body as { added: boolean }).added)).toHaveLength(1);
    expect(await n("SELECT count(*) AS n FROM project_team WHERE project_id = 2 AND person_id = 7")).toBe(1);
  });
});

describe("adaptateur pg sur un vrai pool", () => {
  it("une transaction en échec est annulée et rend sa connexion : le pool reste utilisable", async () => {
    const before = await n("SELECT count(*) AS n FROM allocations");
    for (let i = 0; i < 15; i++) {
      await expect(c.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.account_id', '1', true), set_config('app.user_id', '1', true), set_config('app.role', 'admin', true)");
        await tx.query("INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 1, 1, '2028-01-01', '2028-01-01', 'hours', 1)");
        throw new Error("échec simulé");
      })).rejects.toThrow("échec simulé");
    }
    expect(await n("SELECT count(*) AS n FROM allocations")).toBe(before);
    expect(c.pool.waitingCount).toBe(0);
    expect(c.pool.totalCount - c.pool.idleCount).toBe(0); // aucune connexion restée prise
  });
  it("la RLS s'applique réellement : app_user ne voit pas les lignes d'un autre compte", async () => {
    await c.admin.query("INSERT INTO accounts (name) VALUES ('B'); INSERT INTO people (account_id, name) VALUES (2, 'intrus')");
    const h = await c.hold(ctx);
    const rows = (await h.query("SELECT count(*)::int AS n FROM people WHERE account_id = 2")).rows;
    await h.rollback();
    expect(rows[0].n).toBe(0);
  });
});

describe("LISTEN/NOTIFY (réveil temps réel)", () => {
  const listener = async () => {
    const l = new pg.Client({ connectionString: c.url });
    await l.connect();
    const got: string[] = [];
    l.on("notification", (m) => { if (m.channel === "wnext_changes") got.push(m.payload ?? ""); });
    await l.query("LISTEN wnext_changes");
    return { l, got };
  };
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("la notification n'est livrée qu'au COMMIT, une seule fois par transaction, et pas du tout après un ROLLBACK", async () => {
    const { l, got } = await listener();
    const h = await c.hold(ctx);
    for (let i = 0; i < 3; i++) await h.query("INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 3, 1, $1, $1, 'hours', 1)", [nextDay()]);
    await settle();
    expect(got).toEqual([]); // rien tant que la transaction est ouverte
    await h.commit();
    await settle();
    expect(got).toEqual(["1"]); // trois changements, un réveil, le seul identifiant du compte
    const r = await c.hold(ctx);
    await r.query("INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 3, 1, $1, $1, 'hours', 1)", [nextDay()]);
    await r.rollback();
    await settle();
    expect(got).toEqual(["1"]);
    await l.end();
  });

  it("de bout en bout : une écriture de l'API réveille la session en bien moins qu'une période de sondage", async () => {
    const hub = createChangeHub({ db: c.db, intervalMs: 60_000, notifier: pgNotifier({ createClient: () => new pg.Client({ connectionString: c.url }) }) });
    const out: Array<{ type: string }> = [];
    const head = (await readChanges(c.db, ctx, "0")).head;
    const session = createRealtimeSession({ db: c.db, ctx, hub, send: (m) => out.push(m) });
    await session.receive(JSON.stringify({ v: 1, type: "subscribe", cursor: head }));
    await settle(300); // l'écoute s'établit
    out.length = 0;
    const t0 = Date.now();
    await send("POST", "/api/v1/allocations", alloc("4"));
    while (!out.some((m) => m.type === "changes") && Date.now() - t0 < 5000) await settle(10);
    const elapsed = Date.now() - t0;
    session.close(); hub.close();
    expect(out.some((m) => m.type === "changes")).toBe(true);
    expect(elapsed).toBeLessThan(2000); // la période de sondage est de 60 s, le filet de 30 s
  });
});
