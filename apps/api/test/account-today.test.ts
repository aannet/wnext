// « Aujourd'hui » par défaut de la désactivation (BR-31) = jour calendaire dans le fuseau du COMPTE (accounts.timezone), ni la date
// UTC ni celle du processus. Deux comptes aux antipodes (UTC+14 et UTC-11) : à toute heure, au moins l'un des deux n'est pas au même
// jour que UTC, donc un calcul en UTC échoue quelle que soit l'heure du test. Comme le test des DATE sous 4 fuseaux
// (tests/concurrency/timezone.test.ts), on rejoue sous plusieurs TZ de processus, UTC en dernier.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

// @BR-31
const ZONES = ["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata", "UTC"];
const ACCOUNTS = [
  { accountId: "1", timezone: "Pacific/Kiritimati" },
  { accountId: "2", timezone: "Pacific/Pago_Pago" },
];
const ORIGINAL_TZ = process.env.TZ;
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
let who: RequestContext;
const deps: HttpDeps = { db, authenticate: async () => who, newRequestId: () => "r" };
const send = (method: string, url: string, body?: unknown) => dispatch(deps, { method, url, headers: {}, body: body === undefined ? undefined : JSON.stringify(body) });
/** Aujourd'hui dans un fuseau, calculé par la base (même horloge que l'API). */
const todayIn = async (tz: string) => (await pg.query<{ d: string }>("SELECT (now() AT TIME ZONE $1)::date::text AS d", [tz])).rows[0]!.d;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name, timezone) VALUES ('Kiritimati', 'Pacific/Kiritimati'), ('Pago Pago', 'Pacific/Pago_Pago');
    INSERT INTO projects (account_id, name) VALUES (1, 'P'), (2, 'P');
  `);
}, 120_000);
afterEach(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });
afterAll(async () => { await pg?.close(); }, 60_000);

describe.each(ZONES)("TZ du processus = %s", (tz) => {
  it.each(ACCOUNTS)("compte en $timezone : asOf par défaut = aujourd'hui dans le fuseau du compte", async ({ accountId, timezone }) => {
    process.env.TZ = tz;
    who = { accountId, userId: "1", role: "admin" };
    const today = await todayIn(timezone);
    const person = (await pg.query<{ id: string }>("INSERT INTO people (account_id, name) VALUES ($1, 'p') RETURNING id::text AS id", [accountId])).rows[0]!.id;
    // Une allocation finie hier (dans le fuseau du compte) et une qui finit aujourd'hui : seule la seconde est « future ».
    await pg.query(
      `INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day)
       VALUES ($1, $2, $1, $3::date, $3::date, 'hours', 2), ($1, $2, $1, $4::date, $4::date, 'hours', 2)`,
      [accountId, person, addDays(today, -1), today],
    );

    const s = await send("GET", `/api/v1/people/${person}/deactivation-summary`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ asOf: today, allocationCount: 1, lastAllocation: today });

    // La désactivation sans asOf prend le même jour : la confirmation du récapitulatif vu est exacte.
    const d = await send("POST", `/api/v1/people/${person}/deactivation`, { disposition: "delete", confirmation: { allocationCount: 1 } });
    expect([d.status, (d.body as { deletedAllocations: number }).deletedAllocations]).toEqual([200, 1]);
    const left = (await pg.query<{ d: string }>("SELECT end_date::text AS d FROM allocations WHERE person_id = $1", [person])).rows.map((r) => r.d);
    expect(left).toEqual([addDays(today, -1)]);
  });
});
