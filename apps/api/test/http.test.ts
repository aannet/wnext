// Route HTTP (dispatch pur, PGlite). Le bout en bout avec le client généré est dans tests/e2e (apps/api ne peut pas importer apps/web).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, HealthResponse, ScheduleResponse } from "@wnext/contracts";
import { dispatch, type Db, type HttpDeps, type RequestContext } from "../src/index";

const ctx: RequestContext = { accountId: "1", userId: "1", role: "guest" }; // lecteur de tout le compte (un member ne verrait que sa personne, RT-048)
let pg: PGlite;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const deps: HttpDeps = {
  db,
  authenticate: async (h) => (h.authorization === "Bearer ok" ? ctx : null),
  newRequestId: () => "req-1",
};
const auth = { authorization: "Bearer ok" };
const call = (url: string, headers: Record<string, string> = auth) => dispatch(deps, { method: "GET", url, headers });

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (1, 'Bob');
    INSERT INTO projects (account_id, name) VALUES (1, 'P');
    INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, hours_per_day) VALUES (1, 1, 1, '2026-03-02', '2026-03-03', 4);
  `);
}, 120_000);
afterAll(async () => { await pg?.close(); }, 60_000);

describe("GET /api/v1/schedule", () => {
  it("200 : la réponse valide le contrat", async () => {
    const r = await call("/api/v1/schedule?from=2026-03-02&to=2026-03-06");
    expect(r.status).toBe(200);
    const parsed = ScheduleResponse.safeParse(r.body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.people.map((p) => p.name)).toEqual(["Alice", "Bob"]);
  });

  it("coerce limit et includeInactive, pagine", async () => {
    const r = await call("/api/v1/schedule?from=2026-03-02&to=2026-03-06&limit=1&includeInactive=true");
    expect(r.status).toBe(200);
    expect((r.body as ScheduleResponse).people).toHaveLength(1);
    expect((r.body as ScheduleResponse).page.nextCursor).not.toBeNull();
  });

  it("401 sans authentification valide, y compris quand la requête est aussi invalide (pas d'oracle)", async () => {
    for (const headers of [{}, { authorization: "Bearer non" }]) {
      const r = await call("/api/v1/schedule?from=n-importe-quoi", headers);
      expect(r).toEqual({ status: 401, body: { code: "UNAUTHENTICATED", params: {}, requestId: "req-1" } });
    }
  });

  it.each([
    ["from absent", "to=2026-03-06", "from"],
    ["date invalide", "from=2026-13-40&to=2026-03-06", "from"],
    ["booléen invalide", "from=2026-03-02&to=2026-03-06&includeInactive=oui", "includeInactive"],
    ["limit hors bornes", "from=2026-03-02&to=2026-03-06&limit=501", "limit"],
    ["limit vide", "from=2026-03-02&to=2026-03-06&limit=", "limit"],
    ["limit non entier", "from=2026-03-02&to=2026-03-06&limit=1.5", "limit"],
    ["clé répétée", "from=2026-03-02&to=2026-03-06&tag=a&tag=b", "tag"],
    ["clé inconnue", "from=2026-03-02&to=2026-03-06&sort=name", "sort"],
  ])("400 VALIDATION_FAILED : %s", async (_n, qs, field) => {
    const r = await call(`/api/v1/schedule?${qs}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ code: "VALIDATION_FAILED", params: { field }, requestId: "req-1" });
    expect(ApiError.safeParse(r.body).success).toBe(true);
  });

  it("400 sur plage et curseur invalides, avec le code du contrat", async () => {
    expect((await call("/api/v1/schedule?from=2026-03-10&to=2026-03-01")).body).toMatchObject({ code: "SCHEDULE_RANGE_INVALID" });
    expect((await call("/api/v1/schedule?from=2026-03-02&to=2026-03-06&cursor=zzz")).body).toMatchObject({ code: "SCHEDULE_CURSOR_INVALID" });
  });

  it("500 sans fuite de détail interne, et l'erreur est remontée au journal", async () => {
    const seen: unknown[] = [];
    const boom: HttpDeps = { ...deps, db: { transaction: async () => { throw new Error("password=hunter2 relation secrète"); } }, onError: (e) => seen.push(e) };
    const r = await dispatch(boom, { method: "GET", url: "/api/v1/schedule?from=2026-03-02&to=2026-03-06", headers: auth });
    expect(r).toEqual({ status: 500, body: { code: "INTERNAL_ERROR", params: {}, requestId: "req-1" } });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(seen).toHaveLength(1);
  });
});

describe("autres routes", () => {
  it("health valide le contrat et ne demande pas d'authentification", async () => {
    const r = await call("/api/v1/health", {});
    expect(r.status).toBe(200);
    expect(HealthResponse.safeParse(r.body).success).toBe(true);
  });
  it("404 sur route inconnue ou méthode non prévue", async () => {
    expect((await call("/api/v1/nope")).status).toBe(404);
    expect((await dispatch(deps, { method: "POST", url: "/api/v1/schedule", headers: auth })).status).toBe(404);
  });
});

describe("caractère NUL (U+0000) : PostgreSQL ne le stocke pas dans un texte", () => {
  const admin: HttpDeps = { ...deps, authenticate: async (h) => (h.authorization === "Bearer ok" ? { ...ctx, role: "admin" } : null) };
  const send = (method: string, url: string, body?: unknown) =>
    dispatch(admin, { method, url, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("dans un corps JSON, même imbriqué : 400 VALIDATION_FAILED sur le champ de premier niveau, rien n'est écrit", async () => {
    const r = await send("POST", "/api/v1/departments", { name: "a\u0000b" });
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION_FAILED", params: { field: "name" } } });
    const t = await send("POST", "/api/v1/people", { name: "Zoé", tags: ["ok", "x\u0000"] });
    expect(t).toMatchObject({ status: 400, body: { code: "VALIDATION_FAILED", params: { field: "tags" } } });
    expect((await pg.query("SELECT count(*)::int AS n FROM departments")).rows).toEqual([{ n: 0 }]);
  });

  it("dans une chaîne de requête : 400 VALIDATION_FAILED sur le paramètre", async () => {
    const r = await call("/api/v1/schedule?from=2026-03-02&to=2026-03-06&tag=%00");
    expect(r).toMatchObject({ status: 400, body: { code: "VALIDATION_FAILED", params: { field: "tag" } } });
  });
});
