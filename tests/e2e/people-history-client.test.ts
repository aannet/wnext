// Bout en bout (@BR-19) : client GÉNÉRÉ <-> vrai serveur HTTP, sur une base MIGRÉE (schema.sql puis migrations/, PGlite).
// PATCH daté (effectiveFrom), lecture de l'historique, refus PERSON_HISTORY_LOCKED avec le code du contrat.
import { readdirSync, readFileSync } from "node:fs";
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

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync("schema.sql", "utf8"));
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(`migrations/${f}`, "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
    INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES (1, 1, 1, '2026-03-10', 4);
    UPDATE logged_time SET status = 'submitted';
  `);
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  server = createHttpServer({ db, authenticate: async (h) => (h.authorization === "Bearer ok" ? { accountId: "1", userId: "1", role: "admin" } : null) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await pg?.close(); }, 60_000);

const api = () => createClient({ baseUrl: base, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: "Bearer ok" } }) as never });

describe("historique daté : client généré <-> serveur (@BR-19)", () => {
  it("PATCH daté puis GET /history ; une date dans la période verrouillée est refusée (409 PERSON_HISTORY_LOCKED)", async () => {
    const client = api();
    const locked = await client.updatePerson({ path: { id: "1" }, headers: { "If-Match": '"1"' }, body: { workDaysHours: [4, 4, 4, 4, 4, 0, 0], effectiveFrom: "2026-03-01" } });
    expect(locked.status).toBe(409);
    if (!locked.ok) expect(locked.error).toMatchObject({ code: "PERSON_HISTORY_LOCKED", params: { lockedThrough: "2026-03-10" } });

    const ok = await client.updatePerson({ path: { id: "1" }, headers: { "If-Match": '"1"' }, body: { workDaysHours: [4, 4, 4, 4, 4, 0, 0], effectiveFrom: "2026-04-01" } });
    expect(ok.ok && ok.data).toMatchObject({ version: 2, workDaysHours: [4, 4, 4, 4, 4, 0, 0] });

    const h = await client.listPersonHistory({ path: { id: "1" }, query: { attribute: "workDaysHours" } });
    if (!h.ok) throw new Error("lecture refusée");
    expect(h.data.items.map((e) => [e.validFrom, e.validTo])).toEqual([[null, "2026-03-31"], ["2026-04-01", null]]);
    expect(h.data.page).toEqual({ nextCursor: null, total: 2 });
  });
});
