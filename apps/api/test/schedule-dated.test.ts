// GET /schedule sur base MIGRÉE (schema.sql puis migrations/, PGlite) : horaire daté des personnes (@BR-19) et phases des
// projets renvoyés (@BR-37). Le moteur, nourri de la seule réponse, donne la même capacité que daily_capacity (datée).
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScheduleResponse } from "@wnext/contracts";
import { scheduleUtilization } from "@wnext/engine";
import { getSchedule, type Db, type RequestContext } from "../src/index";

const FROM = "2026-03-02";
const TO = "2026-03-20";
const ctxA: RequestContext = { accountId: "1", userId: "1", role: "member" };
const ctxB: RequestContext = { accountId: "2", userId: "1", role: "admin" };

let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const get = (ctx = ctxA) => getSchedule(db, ctx, { from: FROM, to: TO });

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (1, 'Bob'), (2, 'Intrus');
    INSERT INTO projects (account_id, name, start_date, end_date) VALUES (1, 'Refonte', '2026-03-01', '2026-03-31'), (1, 'Sans phase', NULL, NULL), (2, 'Secret', NULL, NULL);
    INSERT INTO phases (account_id, project_id, name, start_date, end_date, color, position) VALUES
      (1, 1, 'Conception', '2026-03-02', '2026-03-10', '#112233', 1), (1, 1, 'Recette', NULL, NULL, NULL, 2), (2, 3, 'Phase B', NULL, NULL, NULL, 0);
    INSERT INTO allocations (account_id, person_id, project_id, phase_id, start_date, end_date, mode, hours_per_day, percent, status) VALUES
      (1, 1, 1, 1, '2026-03-02', '2026-03-20', 'percentage', NULL, 100, 'confirmed'),
      (1, 2, 2, NULL, '2026-03-02', '2026-03-03', 'hours', 4, NULL, 'confirmed'),
      (2, 3, 3, 3, '2026-03-02', '2026-03-03', 'hours', 4, NULL, 'confirmed');
    -- Alice passe à mi-temps le lundi 9 mars (date d'effet posée comme le fait l'API).
    BEGIN;
    SET LOCAL app.effective_from = '2026-03-09';
    UPDATE people SET work_days_hours = '{4,4,4,4,4,0,0}' WHERE name = 'Alice';
    COMMIT;
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /schedule : horaire daté (@BR-19)", () => {
  it("la personne porte son historique d'horaire complet ; une personne sans changement n'en porte pas", async () => {
    const r = await get();
    expect(ScheduleResponse.safeParse(r).success).toBe(true);
    const alice = r.people.find((p) => p.name === "Alice")!;
    expect(alice.workDaysHours).toEqual([4, 4, 4, 4, 4, 0, 0]);
    expect(alice.workSchedule).toEqual([
      { validFrom: null, validTo: "2026-03-08", workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
      { validFrom: "2026-03-09", validTo: null, workDaysHours: [4, 4, 4, 4, 4, 0, 0] },
    ]);
    expect(r.people.find((p) => p.name === "Bob")!.workSchedule).toBeUndefined();
  });

  it("le moteur, nourri de la réponse, suit l'horaire en vigueur : mêmes nombres que daily_capacity et daily_planned_load", async () => {
    const r = await get();
    const rows = scheduleUtilization(r);
    const alice = r.people.find((p) => p.name === "Alice")!.id;
    const at = (d: string) => rows.find((x) => x.personId === alice && x.day === d)!;
    expect(at("2026-03-06")).toMatchObject({ capacityHours: 8, plannedHours: 8 });
    expect(at("2026-03-09")).toMatchObject({ capacityHours: 4, plannedHours: 4 }); // 100 % de l'horaire du jour
    const sql = (await pg.query<{ person_id: string; day: string; capacity_hours: string }>(
      "SELECT person_id::text, to_char(day, 'YYYY-MM-DD') AS day, capacity_hours FROM daily_capacity(1, $1, $2)", [FROM, TO])).rows;
    for (const s of sql) expect(rows.find((x) => x.personId === s.person_id && x.day === s.day)!.capacityHours).toBe(Number(s.capacity_hours));
  });
});

describe("GET /schedule : phases des projets renvoyés (@BR-37)", () => {
  it("phases des projets de la page, triées par projet puis position ; aucune d'un autre compte", async () => {
    const r = await get();
    expect(r.phases).toEqual([
      { id: "1", version: 1, projectId: "1", name: "Conception", startDate: "2026-03-02", endDate: "2026-03-10", color: "#112233" },
      { id: "2", version: 1, projectId: "1", name: "Recette", startDate: null, endDate: null, color: null },
    ]);
    const b = await get(ctxB);
    expect(b.phases!.map((p) => p.name)).toEqual(["Phase B"]);
  });
});
