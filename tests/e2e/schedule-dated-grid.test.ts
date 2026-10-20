// Bout en bout (@BR-19 @BR-37) : client GÉNÉRÉ <-> vrai serveur HTTP sur base MIGRÉE (schema.sql puis migrations/, PGlite),
// puis le modèle de grille et les avertissements du web nourris de la seule réponse de GET /schedule.
// Changement d'horaire au milieu de la fenêtre -> capacité différente avant et après dans la bande ; allocation déplacée
// hors de sa phase -> avertissement de phase (non bloquant).
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../apps/web/src/api/client.gen";
import { editWarnings } from "../../apps/web/src/schedule/edit-warnings";
import { buildGrid } from "../../apps/web/src/schedule/grid-model";
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
    INSERT INTO phases (account_id, project_id, name, start_date, end_date) VALUES (1, 1, 'Conception', '2026-03-02', '2026-03-06');
    INSERT INTO allocations (account_id, person_id, project_id, phase_id, start_date, end_date, mode, hours_per_day, status)
      VALUES (1, 1, 1, 1, '2026-03-02', '2026-03-06', 'hours', 6, 'confirmed');
  `);
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  server = createHttpServer({ db, authenticate: async (h) => (h.authorization === "Bearer ok" ? { accountId: "1", userId: "1", role: "admin" } : null) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await pg?.close(); }, 60_000);

const api = () => createClient({ baseUrl: base, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: "Bearer ok" } }) as never });

describe("Schedule daté : API -> grille et avertissements (@BR-19 @BR-37)", () => {
  it("passage à mi-temps au 9 mars : la bande de capacité change ce jour-là ; 6 h deviennent une surcharge après", async () => {
    const client = api();
    const ok = await client.updatePerson({ path: { id: "1" }, headers: { "If-Match": '"1"' }, body: { workDaysHours: [4, 4, 4, 4, 4, 0, 0], effectiveFrom: "2026-03-09" } });
    expect(ok.ok).toBe(true);

    const r = await client.getSchedule({ from: "2026-03-02", to: "2026-03-15" });
    if (!r.ok) throw new Error("lecture refusée");
    const s = r.data;
    expect(s.people[0]!.workSchedule).toHaveLength(2);

    const g = buildGrid(s, { from: "2026-03-02", to: "2026-03-15" }, 10, "day");
    const cap = (d: string) => g.rows[0]!.cells.find((c) => c.from === d)!.capacityHours;
    expect([cap("2026-03-06"), cap("2026-03-09")]).toEqual([8, 4]);

    const a = s.allocations[0]!;
    expect(editWarnings(s, a)).toEqual([]);
    // Déplacée d'une semaine : hors de la phase (fin le 6 mars) et au-delà du nouvel horaire (6 h > 4 h).
    expect(editWarnings(s, { ...a, startDate: "2026-03-09", endDate: "2026-03-13" })).toEqual(["OVERLOAD", "ALLOCATION_ENDS_AFTER_PHASE"]);
  });
});
