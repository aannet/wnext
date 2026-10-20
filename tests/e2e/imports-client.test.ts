// Bout en bout (US-1.2) : client GÉNÉRÉ <-> vrai serveur HTTP, base MIGRÉE (schema.sql puis migrations/, PGlite).
// Critères d'acceptation : 300 lignes importées en moins de 30 s (mesuré, dryRun puis application), ré-import idempotent
// (0 création, 0 mise à jour), rapport d'erreurs ligne par ligne avec les codes du contrat.
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
  await pg.exec("INSERT INTO users (email) VALUES ('u@x.test'); INSERT INTO accounts (name) VALUES ('A');");
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  server = createHttpServer({ db, authenticate: async (h) => (h.authorization === "Bearer ok" ? { accountId: "1", userId: "1", role: "admin" } : null) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await pg?.close(); }, 60_000);

const api = () => createClient({ baseUrl: base, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: "Bearer ok" } }) as never });
const N = 300;
const peopleCsv = "﻿Nom;E-mail;Département;Rôle;Type;Pays;Heures/jour;Étiquettes\r\n" +
  Array.from({ length: N }, (_, i) => `Personne ${i};p${i}@exemple.fr;Dép ${i % 12};Rôle ${i % 7};${i % 10 === 0 ? "prestataire" : "salarié"};FR;${i % 3 === 0 ? "7,5" : "8"};équipe ${i % 4}|site`).join("\r\n");
const projectsCsv = "project_code,name,client,project_manager,start_date,end_date,status,billable\n" +
  Array.from({ length: N }, (_, i) => `J-${i},Projet ${i},Client ${i % 25},p${i % 50}@exemple.fr,2026-01-01,2026-12-31,${i % 5 === 0 ? "tentative" : "planned"},oui`).join("\n");

describe("import CSV : client généré <-> serveur (US-1.2)", () => {
  it(`${N} personnes puis ${N} projets : dryRun + application en moins de 30 s chacun ; ré-import : 0 création, 0 mise à jour`, async () => {
    const client = api();
    for (const [kind, csv] of [["people", peopleCsv], ["projects", projectsCsv]] as const) {
      const t0 = performance.now();
      const dry = await client.runImport({ path: { kind }, query: { dryRun: true }, body: { csv } });
      const applied = await client.runImport({ path: { kind }, body: { csv } });
      const elapsed = performance.now() - t0;
      process.stdout.write(`[mesure] import ${kind} ${N} lignes (dryRun + application) : ${Math.round(elapsed)} ms\n`);
      expect(elapsed).toBeLessThan(30_000);
      if (!dry.ok || !applied.ok) throw new Error(`import ${kind} refusé`);
      expect(dry.data).toMatchObject({ dryRun: true, applied: false, rows: N, created: N, invalid: 0 });
      expect(applied.data).toMatchObject({ applied: true, rows: N, created: N, updated: 0, invalid: 0, errors: [] });

      const again = await client.runImport({ path: { kind }, body: { csv } });
      if (!again.ok) throw new Error("ré-import refusé");
      expect(again.data).toMatchObject({ created: 0, updated: 0, unchanged: N, references: { departments: [], roles: [], clients: [] } });
    }
    expect(Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM people WHERE email LIKE '%@exemple.fr'")).rows[0]!.n)).toBe(N);
    expect(Number((await pg.query<{ n: string }>("SELECT count(*) AS n FROM departments")).rows[0]!.n)).toBe(12);
  }, 120_000);

  it("rapport d'erreurs ligne par ligne ; sans skipInvalid : 422 IMPORT_HAS_ERRORS", async () => {
    const csv = "name,email,hours_per_day\nOk,ok@exemple.fr,8\n,vide@exemple.fr,8\nTrop,trop@exemple.fr,25\n";
    const dry = await api().runImport({ path: { kind: "people" }, query: { dryRun: true }, body: { csv } });
    if (!dry.ok) throw new Error("dryRun refusé");
    expect(dry.data.errors.map((e) => [e.line, e.column, e.code])).toEqual([[3, "name", "required"], [4, "hours_per_day", "invalid_number"]]);
    const refused = await api().runImport({ path: { kind: "people" }, body: { csv } });
    expect(refused.status).toBe(422);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: "IMPORT_HAS_ERRORS", params: { invalid: 2, rows: 3 } });
  });
});
