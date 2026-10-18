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
  `);
  const db: Db = { transaction: (fn) => pg.transaction((tx) => fn(tx as never)) };
  server = createHttpServer({ db, authenticate: async (h) => (h.authorization === "Bearer ok" ? { accountId: "1", userId: "1", role: "member" } : null) });
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
