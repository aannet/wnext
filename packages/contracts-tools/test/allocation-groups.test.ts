// Contrat des groupes d'allocations (BR-26) : création multi-personnes, édition « tous », routes.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { AllocationGroup, AllocationGroupCreate, AllocationGroupMax, AllocationGroupPatch, AllocationPathParams, IfMatchHeader, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;
const h = (n: number) => ({ mode: "hours", hoursPerDay: n }) as const;
const base = { projectId: "2", startDate: "2026-03-02", endDate: "2026-03-06" };

describe("création d'un groupe", () => {
  it("2 membres au moins, chacun avec sa charge ou la charge commune", () => {
    expect(ok(AllocationGroupCreate, { ...base, load: h(4), members: [{ personId: "1" }, { personId: "2" }] })).toBe(true);
    expect(ok(AllocationGroupCreate, { ...base, members: [{ personId: "1", load: h(4) }, { personId: "2", load: { mode: "percentage", percent: 50 } }] })).toBe(true);
    expect(ok(AllocationGroupCreate, { ...base, load: h(4), members: [{ personId: "1", load: h(2) }, { personId: "2" }] })).toBe(true); // surcharge d'un membre
  });
  it("refus : un seul membre, doublon, 51 membres, charge manquante, charge invalide", () => {
    for (const [label, v] of [
      ["un membre", { ...base, members: [{ personId: "1", load: h(4) }] }],
      ["aucun membre", { ...base, members: [] }],
      ["membres absents", { ...base, load: h(4) }],
      ["doublon", { ...base, members: [{ personId: "1", load: h(4) }, { personId: "1", load: h(2) }] }],
      ["trop de membres", { ...base, load: h(1), members: Array.from({ length: AllocationGroupMax + 1 }, (_, i) => ({ personId: String(i + 1) })) }],
      ["un membre sans charge", { ...base, members: [{ personId: "1", load: h(4) }, { personId: "2" }] }],
      ["charge nulle", { ...base, members: [{ personId: "1", load: h(0) }, { personId: "2", load: h(4) }] }],
      ["pourcentage hors plafond", { ...base, members: [{ personId: "1", load: { mode: "percentage", percent: 501 } }, { personId: "2", load: h(4) }] }],
      ["personId vide", { ...base, load: h(4), members: [{ personId: "" }, { personId: "2" }] }],
    ] as const) expect(ok(AllocationGroupCreate, v), label).toBe(false);
    expect(ok(AllocationGroupCreate, { ...base, load: h(1), members: Array.from({ length: AllocationGroupMax }, (_, i) => ({ personId: String(i + 1) })) })).toBe(true);
  });
  it("mêmes règles de dates et de répétition qu'une allocation seule", () => {
    const m = { load: h(4), members: [{ personId: "1" }, { personId: "2" }] };
    expect(ok(AllocationGroupCreate, { ...base, ...m, endDate: "2026-03-01" })).toBe(false);
    expect(ok(AllocationGroupCreate, { ...base, ...m, repeatState: "weekly" })).toBe(false);
    expect(ok(AllocationGroupCreate, { ...base, ...m, repeatState: "weekly", repeatEndDate: "2026-04-03" })).toBe(true);
    expect(ok(AllocationGroupCreate, { ...base, ...m, repeatState: "none", repeatEndDate: "2026-04-03" })).toBe(false);
  });
  it("pas de personId au niveau du groupe", () => {
    const parsed = AllocationGroupCreate.parse({ ...base, load: h(4), members: [{ personId: "1" }, { personId: "2" }], personId: "9" }) as Record<string, unknown>;
    expect("personId" in parsed).toBe(false);
  });
});

describe("édition « tous »", () => {
  it("champs communs seulement, non vide, dates ordonnées", () => {
    expect(ok(AllocationGroupPatch, { name: "Sprint" })).toBe(true);
    expect(ok(AllocationGroupPatch, { phaseId: null, status: "tentative", repeatState: "none", repeatEndDate: null })).toBe(true);
    expect(ok(AllocationGroupPatch, {})).toBe(false);
    expect(ok(AllocationGroupPatch, { startDate: "2026-03-06", endDate: "2026-03-02" })).toBe(false);
  });
  it("la personne et la charge sont propres à chaque ligne : refusées (corps strict), comme toute clé inconnue", () => {
    for (const v of [{ personId: "2" }, { load: h(4) }, { name: "x", personId: "2" }, { name: "x", foo: 1 }]) expect(ok(AllocationGroupPatch, v), JSON.stringify(v)).toBe(false);
  });
  it("forme lue", () => {
    const a = { id: "1", version: 1, personId: "2", projectId: "3", phaseId: null, taskId: null, groupId: "g1", name: null, notes: null, startDate: "2026-03-02", endDate: "2026-03-06", status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 8, percent: null };
    expect(ok(AllocationGroup, { groupId: "g1", items: [a, { ...a, id: "2", personId: "3" }] })).toBe(true);
    expect(ok(AllocationGroup, { items: [a] })).toBe(false);
  });
});

describe("routes", () => {
  const op = (id: string) => routes.find((r) => r.operationId === id)!;
  it("création : POST à plat, 201, corps du contrat, droits d'écriture", () => {
    const r = op("createAllocationGroup");
    expect([r.method, r.path, r.body]).toEqual(["post", "/api/v1/allocation-groups", AllocationGroupCreate]);
    for (const code of [201, 400, 401, 403, 404]) expect(r.responses[code], String(code)).toBeDefined();
  });
  it("édition « tous » : sous l'allocation désignée, If-Match, 404 sans groupe, 409 et 428", () => {
    const p = op("updateAllocationGroup");
    const d = op("deleteAllocationGroup");
    expect([p.method, p.path, p.params, p.headers, p.body]).toEqual(["patch", "/api/v1/allocations/{id}/group", AllocationPathParams, IfMatchHeader, AllocationGroupPatch]);
    expect([d.method, d.path, d.params, d.headers]).toEqual(["delete", "/api/v1/allocations/{id}/group", AllocationPathParams, IfMatchHeader]);
    for (const r of [p, d]) for (const code of [400, 401, 403, 404, 409, 428]) expect(r.responses[code], `${r.operationId} ${code}`).toBeDefined();
    expect(d.responses[204]).toBeDefined();
  });
  it("la spec contient les chemins ; l'allocation seule garde les siens", () => {
    const spec = buildSpec() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(spec.paths["/api/v1/allocation-groups"]!)).toEqual(["post"]);
    expect(Object.keys(spec.paths["/api/v1/allocations/{id}/group"]!).sort()).toEqual(["delete", "patch"]);
    expect(Object.keys(spec.paths["/api/v1/allocations/{id}"]!).sort()).toEqual(["delete", "get", "patch"]);
  });
});
