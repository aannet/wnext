// Import CSV de personnes (US-1.2) contre une soumission de temps concurrente (BR-12, BR-19), sur PostgreSQL migré (0002 :
// people_history et son trigger WN019). Course visée : la soumission valide entre la lecture de l'état (période verrouillée) et
// l'UPDATE de people ; le trigger levait alors WN019, non traduit : 500 pour tout l'import. Protocole retenu : l'import (hors
// dryRun) verrouille les personnes du compte (FOR NO KEY UPDATE) AVANT de lire l'état ; la soumission prend la personne en
// FOR SHARE. L'une attend l'autre : l'état lu par l'import est celui de la soumission validée (erreur de ligne history_locked).
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type HttpDeps, type RequestContext } from "../../apps/api/src/index";
import { startCluster, type Cluster } from "./pg-harness";

// @BR-12 @BR-19
const ctx: RequestContext = { accountId: "1", userId: "1", role: "admin" };
let c: Cluster;
let deps: HttpDeps;
const send = (method: string, url: string, body?: unknown) => dispatch(deps, { method, url, headers: {}, body: body === undefined ? undefined : JSON.stringify(body) });
const importPeople = (csv: string) => send("POST", "/api/v1/imports/people", { csv, skipInvalid: true });
const pending = <T>(p: Promise<T>) => Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), 300))]);
const today = async () => String((await c.admin.query("SELECT current_date::text AS d")).rows[0].d);

beforeAll(async () => {
  c = await startCluster({ typed: true });
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await c.admin.query(readFileSync(new URL(f, dir), "utf8"));
  deps = { db: c.db, authenticate: async () => ctx, newRequestId: () => "r" };
  await c.admin.query(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name, email) VALUES (1, 'Carl', 'carl@x.fr'), (1, 'Dina', 'dina@x.fr');
    INSERT INTO projects (account_id, name) VALUES (1, 'P');
    INSERT INTO logged_time (account_id, person_id, project_id, work_date, hours) VALUES
      (1, 1, 1, current_date + 2, 4), (1, 2, 1, current_date + 2, 4);
  `);
}, 180_000);
afterAll(async () => { await c?.stop(); }, 60_000);

describe("import de personnes contre une soumission concurrente", () => {
  it("soumission en cours (personne tenue) : l'import attend, puis voit la période verrouillée (history_locked, pas de 500)", async () => {
    const d = await today();
    const holder = await c.hold(ctx);
    // Ce que fait POST /logged-time/submit : la personne en FOR SHARE, puis les brouillons passent à submitted (non validé).
    await holder.query("SELECT 1 FROM people WHERE id = 1 FOR SHARE");
    await holder.query("UPDATE logged_time SET status = 'submitted' WHERE person_id = 1");
    const p = importPeople("name,email,department\nCarl,carl@x.fr,Design\n");
    await c.waitBlocked();
    expect(await pending(p)).toBe(true);
    await holder.commit();
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as any).errors).toEqual([expect.objectContaining({ line: 2, column: "department", code: "history_locked" })]);
    expect(Number((await c.admin.query("SELECT count(*) AS n FROM people_history WHERE person_id = 1 AND valid_from >= $1::date", [d])).rows[0].n)).toBe(0);
  });

  it("import en cours (personnes tenues) : la soumission de l'API attend la fin de l'import", async () => {
    const holder = await c.hold(ctx);
    await holder.query("SELECT 1 FROM people WHERE account_id = 1 ORDER BY id FOR NO KEY UPDATE"); // ce que fait l'import
    const d = await today();
    const p = send("POST", "/api/v1/logged-time/submit", { personId: "2", from: d, to: d.replace(/^\d{4}/, (y) => String(Number(y) + 1)) });
    await c.waitBlocked();
    expect(await pending(p)).toBe(true);
    await holder.commit();
    const r = await p;
    expect([r.status, (r.body as any).submittedCount]).toEqual([200, 1]);
  });
});
