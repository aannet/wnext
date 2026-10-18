// Bout en bout : le client GÉNÉRÉ depuis le contrat (apps/web) parle à un vrai serveur HTTP (apps/api) sur PGlite.
// Prouve la chaîne contrat -> OpenAPI -> client -> serveur. Vit hors des apps : elles ne s'importent pas entre elles.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../apps/web/src/api/client.gen";
import { createHttpServer, type Db } from "../../apps/api/src/index";

let pg: PGlite;
let server: Server;
let base: string;
const auth = { authorization: "Bearer ok" };

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync("schema.sql", "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name, tags) VALUES (1, 'Alice', '{é &=?}'), (1, 'Bob', '{}');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
  `);
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  server = createHttpServer({ db, authenticate: async (h) => (h.authorization === "Bearer ok" ? { accountId: "1", userId: "1", role: "admin" } : null) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await pg?.close(); }, 60_000);

const client = (headers: Record<string, string> = auth) =>
  createClient({ baseUrl: base, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...headers } }) as never });

describe("client généré <-> serveur", () => {
  it("getSchedule renvoie les données ; un tag à caractères spéciaux traverse l'encodage URL", async () => {
    const res = await client().getSchedule({ from: "2026-03-02", to: "2026-03-06", tag: "é &=?" });
    expect(res.ok).toBe(true);
    if (res.ok && "people" in res.data) expect(res.data.people.map((p) => p.name)).toEqual(["Alice"]);
    else throw new Error("réponse inattendue");
  });

  it("une plage invalide arrive en 400 avec le code du contrat", async () => {
    const res = await client().getSchedule({ from: "2026-03-10", to: "2026-03-01" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error).toMatchObject({ code: "SCHEDULE_RANGE_INVALID" });
    }
  });

  it("sans jeton : 401", async () => {
    expect((await client({}).getSchedule({ from: "2026-03-02", to: "2026-03-06" })).status).toBe(401);
  });
});

describe("écritures : client généré <-> serveur", () => {
  it("créer, modifier avec If-Match, subir un conflit, recharger, rejouer, supprimer (204)", async () => {
    const api = client();
    const created = await api.createAllocation({ body: { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-06", load: { mode: "percentage", percent: 150 } } });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("création refusée");
    const a = created.data;
    const ifMatch = (v: number) => ({ "If-Match": `"${v}"` });

    const moved = await api.updateAllocation({ path: { id: a.id }, headers: ifMatch(a.version), body: { personId: "2", name: "déplacée / test" } });
    expect(moved.ok && moved.data).toMatchObject({ personId: "2", name: "déplacée / test", version: a.version + 1 });

    const stale = await api.updateAllocation({ path: { id: a.id }, headers: ifMatch(a.version), body: { name: "périmée" } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: a.version + 1 } });

    const noHeader = await createClient({ baseUrl: base, fetch: (u, i) => fetch(u, { ...i, headers: { ...i.headers, ...auth } }) as never })
      .updateAllocation({ path: { id: a.id }, headers: {} as never, body: { name: "x" } });
    expect(noHeader.status).toBe(428);

    const del = await api.deleteAllocation({ path: { id: a.id }, headers: ifMatch(a.version + 1) });
    expect(del).toEqual({ ok: true, status: 204, data: undefined });
    const gone = await api.deleteAllocation({ path: { id: a.id }, headers: ifMatch(a.version + 1) });
    expect(gone.status).toBe(404);
  });
});

describe("congés : client généré <-> serveur", () => {
  it("créer, chevaucher (TIMEOFF_OVERLAP), modifier avec If-Match, supprimer (204)", async () => {
    const api = client();
    const body = { personId: "1", typeId: "1", startDate: "2026-07-06", endDate: "2026-07-10" };
    const created = await api.createTimeoff({ body });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("création refusée");
    const t = created.data;

    const overlap = await api.createTimeoff({ body: { ...body, startDate: "2026-07-08", endDate: "2026-07-08" } });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect([overlap.status, overlap.error]).toEqual([409, expect.objectContaining({ code: "TIMEOFF_OVERLAP" })]);

    const ifMatch = (v: number) => ({ "If-Match": `"${v}"` });
    const approved = await api.updateTimeoff({ path: { id: t.id }, headers: ifMatch(t.version), body: { approvalStatus: "approved" } });
    expect(approved.ok && approved.data).toMatchObject({ approvalStatus: "approved", version: t.version + 1 });

    const stale = await api.updateTimeoff({ path: { id: t.id }, headers: ifMatch(t.version), body: { notes: "périmée" } });
    if (stale.ok) throw new Error("conflit attendu");
    expect(stale.error).toMatchObject({ code: "VERSION_CONFLICT" });

    expect(await api.deleteTimeoff({ path: { id: t.id }, headers: ifMatch(t.version + 1) })).toEqual({ ok: true, status: 204, data: undefined });
  });
});
