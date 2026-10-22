// Contrat des réglages du compte (RT-041, PO-05) : lecture par tout membre, écriture owner/admin sous verrou optimiste.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { AccountPatch, AccountSettings, AccountLocale, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;
const settings = { id: "1", version: 3, name: "Compte A", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr", capacityThresholds: { underPercent: 80 } };

describe("AccountSettings", () => {
  it("forme complète : identité, version, fuseau, semaine ISO, langue, seuil de sous-allocation", () => {
    expect(ok(AccountSettings, settings)).toBe(true);
    expect(ok(AccountSettings, { ...settings, capacityThresholds: { underPercent: 72.5 } })).toBe(true);
  });
  it.each([
    ["version absente", { ...settings, version: undefined }],
    ["semaine hors 1-7", { ...settings, weekStart: 0 }],
    ["seuil hors 1-100", { ...settings, capacityThresholds: { underPercent: 101 } }],
    ["seuil absent", { ...settings, capacityThresholds: {} }],
  ])("refuse : %s", (_n, v) => expect(ok(AccountSettings, v)).toBe(false));
});

describe("AccountPatch", () => {
  it("chaque champ seul est accepté ; corps vide refusé", () => {
    expect(AccountLocale.options).toEqual(["fr", "en"]);
    for (const v of [{ timezone: "America/New_York" }, { weekStart: 7 }, { defaultLocale: "en" }, { capacityThresholds: { underPercent: 1 } }, { capacityThresholds: { underPercent: 100 } }]) {
      expect(ok(AccountPatch, v)).toBe(true);
    }
    expect(ok(AccountPatch, {})).toBe(false);
  });
  it.each([
    ["fuseau vide", { timezone: "" }],
    ["semaine 0", { weekStart: 0 }],
    ["semaine 8", { weekStart: 8 }],
    ["semaine non entière", { weekStart: 1.5 }],
    ["langue hors fr|en", { defaultLocale: "de" }],
    ["seuil 0", { capacityThresholds: { underPercent: 0 } }],
    ["seuil 101", { capacityThresholds: { underPercent: 101 } }],
    ["seuil sans valeur", { capacityThresholds: {} }],
  ])("refuse : %s", (_n, v) => expect(ok(AccountPatch, v)).toBe(false));
  it("le nom est en lecture seule : un corps qui ne porte que le nom est vide", () => {
    expect(ok(AccountPatch, { name: "Autre" })).toBe(false);
  });
});

describe("routes", () => {
  it("GET ouvert à tout membre, PATCH owner/admin avec If-Match : 403, 409 et 428 documentés", () => {
    const ops = routes.filter((r) => r.path === "/api/v1/account");
    expect(ops.map((r) => `${r.method} ${r.operationId}`).sort()).toEqual(["get getAccount", "patch updateAccount"]);
    const patch = ops.find((r) => r.method === "patch")!;
    expect(patch.headers?.shape).toHaveProperty("If-Match");
    for (const s of [200, 400, 401, 403, 409, 428]) expect(patch.responses[s]).toBeDefined();
    expect(ops.find((r) => r.method === "get")!.responses[200]!.schema).toBe(AccountSettings);
    const spec = buildSpec() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(spec.paths["/api/v1/account"]!).sort()).toEqual(["get", "patch"]);
  });
});
