// Import CSV (US-1.2) côté écran : source de démo (mêmes règles que l'API : dryRun, tout ou rien, skipInvalid, idempotence,
// borne de lignes) et source API (codes d'erreur stables conservés, panne réseau).
import { IMPORT_MAX_ROWS } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createApiImportSource, createDemoImportSource, demoImportSnapshot } from "../src/data/import-source";
import { demoSchedule } from "../src/demo";

const TODAY = "2026-10-20";
const demo = () => createDemoImportSource(demoImportSnapshot(demoSchedule(TODAY), TODAY));
const PEOPLE = "Nom;E-mail;Département\nAlice;alice@x.fr;Nouveau\nBruno;bruno@x.fr;\nSans mail;;\n";

describe("source de démo", () => {
  it("dryRun : rapport, rien n'est retenu ; sans skipInvalid : IMPORT_HAS_ERRORS ; avec : lignes valides, puis ré-import idempotent", async () => {
    const s = demo();
    const dry = await s.run("people", PEOPLE, { dryRun: true });
    expect(dry.ok && dry.report).toMatchObject({ dryRun: true, applied: false, rows: 3, created: 2, invalid: 1, references: { departments: ["Nouveau"] } });
    expect(await s.run("people", PEOPLE, { dryRun: false })).toEqual({ ok: false, error: "IMPORT_HAS_ERRORS", params: { invalid: 1, rows: 3 } });
    const applied = await s.run("people", PEOPLE, { dryRun: false, skipInvalid: true });
    expect(applied.ok && applied.report).toMatchObject({ applied: true, created: 2, invalid: 1 });
    const again = await s.run("people", PEOPLE, { dryRun: true });
    expect(again.ok && again.report).toMatchObject({ created: 0, updated: 0, unchanged: 2, references: { departments: [] } });
  });
  it("projets et clients : création puis ré-import inchangé ; mise à jour visible ensuite", async () => {
    const s = demo();
    const csv = "project_code,name,client,status\nX-1,Nouveau,Acme,tentative\n";
    expect((await s.run("projects", csv, { dryRun: false }))).toMatchObject({ ok: true, report: { created: 1, references: { clients: ["Acme"] } } });
    expect((await s.run("projects", csv, { dryRun: true }))).toMatchObject({ ok: true, report: { created: 0, unchanged: 1, references: { clients: [] } } });
    expect((await s.run("projects", "project_code,name\nX-1,Renommé\n", { dryRun: false }))).toMatchObject({ ok: true, report: { updated: 1 } });
    expect((await s.run("clients", "name,short_name\nacme,AC\n", { dryRun: false }))).toMatchObject({ ok: true, report: { updated: 1 } });
    expect((await s.run("clients", "name,short_name\nacme,AC\n", { dryRun: true }))).toMatchObject({ ok: true, report: { unchanged: 1 } });
    expect((await s.run("clients", "name\nGlobex\n", { dryRun: false }))).toMatchObject({ ok: true, report: { created: 1 } });
  });
  it("personnes existantes de la démo (sans e-mail) : un rôle existant est retrouvé par son nom", async () => {
    const data = demoSchedule(TODAY);
    const role = data.roles[0]!.name.toUpperCase();
    const r = await demo().run("people", `name,email,role\nZoé,zoe@x.fr,${role}\n`, { dryRun: true });
    expect(r.ok && r.report).toMatchObject({ created: 1, references: { roles: [] } });
  });
  it(`plus de ${IMPORT_MAX_ROWS} lignes : IMPORT_TOO_LARGE`, async () => {
    const csv = `name\n${Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `c${i}`).join("\n")}`;
    expect(await demo().run("clients", csv, { dryRun: true })).toEqual({ ok: false, error: "IMPORT_TOO_LARGE", params: { maxRows: IMPORT_MAX_ROWS, rows: IMPORT_MAX_ROWS + 1 } });
  });
});

describe("source API", () => {
  const report = { kind: "clients", dryRun: true, applied: false, delimiter: ",", rows: 0, created: 0, updated: 0, unchanged: 0, invalid: 0,
    references: { departments: [], roles: [], clients: [] }, ignoredColumns: [], errors: [], errorsTruncated: false } as const;
  it("dryRun et skipInvalid transmis ; rapport rendu tel quel", async () => {
    const calls: unknown[] = [];
    const s = createApiImportSource({ runImport: async (input) => { calls.push(input); return { ok: true, status: 200, data: report }; } });
    expect(await s.run("clients", "name\n", { dryRun: true })).toEqual({ ok: true, report });
    await s.run("people", "x", { dryRun: false, skipInvalid: true });
    expect(calls).toEqual([
      { path: { kind: "clients" }, query: { dryRun: true }, body: { csv: "name\n" } },
      { path: { kind: "people" }, body: { csv: "x", skipInvalid: true } },
    ]);
  });
  it("codes connus conservés, autres -> OTHER, exception -> NETWORK", async () => {
    const fail = (code: string) => createApiImportSource({ runImport: async () => ({ ok: false, status: 400, error: { code, params: { a: 1 }, requestId: "r" } }) as never });
    expect(await fail("FORBIDDEN").run("people", "x", { dryRun: true })).toEqual({ ok: false, error: "FORBIDDEN", params: { a: 1 } });
    expect(await fail("INTERNAL_ERROR").run("people", "x", { dryRun: true })).toMatchObject({ ok: false, error: "OTHER" });
    const down = createApiImportSource({ runImport: async () => { throw new TypeError("fetch failed"); } });
    expect(await down.run("people", "x", { dryRun: true })).toEqual({ ok: false, error: "NETWORK", params: {} });
  });
});
