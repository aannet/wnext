// Exceptions de check:breaking (breaking-allowlist.json) : un $ref renommé n'est accepté que s'il figure dans la liste relue,
// à l'emplacement exact, ET que le nouveau schéma est l'ancien plus des propriétés facultatives (aucun autre écart).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findBreakingChanges, parseAllowlist, type RefRenameException } from "../src/breaking";
import { buildSpec } from "../src/openapi";
import { paths } from "../src/paths";

type Json = Record<string, any>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ref = (name: string) => `#/components/schemas/${name}`;

// Spec minimale : GET /x, réponse 200 = $ref Old ; `next` la fait pointer vers New.
function pair(oldSchemas: Json, newSchemas: Json, from = "Old", to = "New") {
  const spec = (schemas: Json, name: string) => ({
    openapi: "3.1.0", components: { schemas },
    paths: { "/x": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: ref(name) } } } } } } } },
  });
  return { base: spec(oldSchemas, from), next: spec(newSchemas, to) };
}
const allow = (over: Partial<RefRenameException> = {}): RefRenameException[] => [
  { method: "get", path: "/x", status: "200", at: "", from: ref("Old"), to: ref("New"), reason: "test", rt: "RT-999", ...over },
];
const obj = (properties: Json, required = Object.keys(properties)) => ({ type: "object", properties, required });

// Cas reproduits par le relecteur : chacun est une rupture, avec ou sans exception listée.
const reviewerCases: [string, Json, Json][] = [
  ["deux propriétés vers Value, la seconde devient number (seen ne mémorisait que l'ancien $ref)",
    { Old: obj({ a: { $ref: ref("Value") }, b: { $ref: ref("Value") } }), Value: { type: "string" } },
    { New: obj({ a: { $ref: ref("Value") }, b: { $ref: ref("Value2") } }), Value: { type: "string" }, Value2: { type: "number" } }],
  ["nullable false -> true", { Old: obj({ a: { type: "string" } }) }, { New: obj({ a: { type: ["string", "null"] } }) }],
  ["nullable par anyOf ajouté", { Old: obj({ a: { type: "string" } }) }, { New: obj({ a: { anyOf: [{ type: "string" }, { type: "null" }] } }) }],
  ["enum élargie en réponse", { Old: obj({ s: { type: "string", enum: ["a"] } }) }, { New: obj({ s: { type: "string", enum: ["a", "b"] } }) }],
  ["variante oneOf ajoutée", { Old: obj({ u: { oneOf: [{ type: "string" }] } }) }, { New: obj({ u: { oneOf: [{ type: "string" }, { type: "number" }] } }) }],
  ["additionalProperties modifié", { Old: { ...obj({ a: { type: "string" } }), additionalProperties: false } }, { New: { ...obj({ a: { type: "string" } }), additionalProperties: true } }],
  ["propriété requise supprimée dans allOf",
    { Old: { allOf: [obj({ a: { type: "string" }, b: { type: "string" } })] } },
    { New: { allOf: [obj({ a: { type: "string" } })] } }],
];

describe("check:breaking : $ref renommé", () => {
  it.each(reviewerCases)("rupture sans exception : %s", (_n, o, n) => {
    const { base, next } = pair(o, n);
    expect(findBreakingChanges(base, next).join("\n")).toMatch(/\$ref #\/components\/schemas\/Old -> #\/components\/schemas\/New/);
  });
  it.each(reviewerCases)("rupture même avec une exception exacte : %s", (_n, o, n) => {
    const { base, next } = pair(o, n);
    expect(findBreakingChanges(base, next, allow()).length).toBeGreaterThan(0);
  });

  it("exception exacte + ancien schéma plus une propriété facultative : acceptée", () => {
    const o = { Old: obj({ a: { type: "string" } }) };
    const n = { New: { ...obj({ a: { type: "string" } }), properties: { a: { type: "string" }, extra: { type: "number" } } } };
    const { base, next } = pair(o, n);
    expect(findBreakingChanges(base, next)).toHaveLength(1);
    expect(findBreakingChanges(base, next, allow())).toEqual([]);
    const required = clone(n);
    required.New.required = ["a", "extra"]; // une propriété ajoutée mais requise n'est pas « l'ancien plus du facultatif »
    expect(findBreakingChanges(base, pair(o, required).next, allow()).length).toBeGreaterThan(0);
  });

  it.each([
    ["méthode", { method: "post" }], ["chemin", { path: "/y" }], ["statut", { status: "201" }], ["emplacement", { at: ".items[]" }],
    ["ancien $ref", { from: ref("Autre") }], ["nouveau $ref", { to: ref("Autre") }],
  ])("une exception qui ne correspond pas exactement (%s) laisse la rupture", (_n, over) => {
    const { base, next } = pair({ Old: obj({ a: { type: "string" } }) }, { New: obj({ a: { type: "string" } }) });
    expect(findBreakingChanges(base, next, allow(over as Partial<RefRenameException>))).toHaveLength(1);
  });

  it("liste versionnée : SchedulePerson -> PersonDetail sur les 4 routes people (RT-040) passe, et rien d'autre", () => {
    const list = parseAllowlist(readFileSync(new URL("../breaking-allowlist.json", import.meta.url), "utf8"));
    expect(list.map((e) => `${e.method} ${e.path} ${e.status}${e.at} ${e.rt}`).sort()).toEqual([
      "get /api/v1/people 200.items[] RT-040", "get /api/v1/people/{id} 200 RT-040", "patch /api/v1/people/{id} 200 RT-040", "post /api/v1/people 201 RT-040",
    ]);
    const next = buildSpec() as Json;
    const base = clone(next); // la spec d'avant RT-040 : les 4 réponses pointaient vers SchedulePerson
    base.components.schemas.PersonList.properties.items.items.$ref = ref("SchedulePerson");
    for (const [p, m, c] of [["/api/v1/people/{id}", "get", "200"], ["/api/v1/people/{id}", "patch", "200"], ["/api/v1/people", "post", "201"]] as const) {
      base.paths[p][m].responses[c].content["application/json"].schema.$ref = ref("SchedulePerson");
    }
    delete base.components.schemas.PersonDetail;
    expect(findBreakingChanges(base, next)).toHaveLength(4);
    expect(findBreakingChanges(base, next, list)).toEqual([]);
    // Si PersonDetail perdait un champ de SchedulePerson, l'exception ne couvrirait plus rien.
    const poorer = clone(next);
    delete poorer.components.schemas.PersonDetail.properties.tags;
    poorer.components.schemas.PersonDetail.required = poorer.components.schemas.PersonDetail.required.filter((k: string) => k !== "tags");
    expect(findBreakingChanges(base, poorer, list).length).toBeGreaterThan(0);
    expect(paths.allowlist).toMatch(/breaking-allowlist\.json$/);
  });

  it("entrée incomplète ou sans raison : refusée à la lecture", () => {
    const good = allow()[0]!;
    expect(parseAllowlist(JSON.stringify({ exceptions: [good] }))).toEqual([good]);
    for (const bad of [{ ...good, reason: "" }, { ...good, rt: "40" }, { ...good, method: "GET" }, { ...good, from: "Old" }, { ...good, extra: 1 }]) {
      expect(() => parseAllowlist(JSON.stringify({ exceptions: [bad] })), JSON.stringify(bad)).toThrow();
    }
  });
});
