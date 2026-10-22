import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSpec } from "../src/openapi";
import { generateClient } from "../src/client";
import { findBreakingChanges } from "../src/breaking";
import { paths } from "../src/paths";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("spec OpenAPI generee depuis Zod", () => {
  const spec = buildSpec() as any;
  it("decrit GET /api/v1/health avec 200 {status, version} et 500 ApiError", () => {
    const op = spec.paths["/api/v1/health"].get;
    expect(op.operationId).toBe("getHealth");
    expect(spec.components.schemas.HealthResponse.required).toEqual(["status", "version"]);
    expect(spec.components.schemas.ApiError.required).toEqual(["code", "params", "requestId"]);
    expect(op.responses["500"].content["application/json"].schema.$ref).toBe("#/components/schemas/ApiError");
  });
  it("est deterministe", () => {
    expect(JSON.stringify(buildSpec())).toBe(JSON.stringify(buildSpec()));
  });
  it("la spec commitee est a jour", () => {
    expect(JSON.parse(readFileSync(paths.spec, "utf8"))).toEqual(spec);
  });
});

describe("client genere", () => {
  const src = generateClient(buildSpec());
  it("expose les types et la fonction getHealth", () => {
    expect(src).toContain("export interface HealthResponse");
    expect(src).toContain('status: "ok" | "degraded";');
    expect(src).toContain("export interface ApiError");
    expect(src).toContain("getHealth");
  });
  it("le client commite est a jour", () => {
    expect(readFileSync(paths.client, "utf8")).toBe(src);
  });
});

describe("detection de rupture", () => {
  const base = buildSpec() as any;
  it("aucune rupture sur spec identique", () => {
    expect(findBreakingChanges(base, clone(base))).toEqual([]);
  });
  it("champ requis supprime de la reponse", () => {
    const next = clone(base);
    delete next.components.schemas.HealthResponse.properties.version;
    next.components.schemas.HealthResponse.required = ["status"];
    const r = findBreakingChanges(base, next);
    expect(r.join("\n")).toMatch(/200\.version : propriete supprimee/);
  });
  it("operation supprimee", () => {
    const next = clone(base);
    delete next.paths["/api/v1/health"];
    expect(findBreakingChanges(base, next).join()).toMatch(/GET \/api\/v1\/health/);
  });
  it("type modifie", () => {
    const next = clone(base);
    next.components.schemas.HealthResponse.properties.version.type = "integer";
    expect(findBreakingChanges(base, next).join()).toMatch(/version.*type/);
  });
  it("valeur d'enum retiree de la reponse", () => {
    const next = clone(base);
    next.components.schemas.HealthResponse.properties.status.enum = ["ok"];
    expect(findBreakingChanges(base, next).join()).toMatch(/status.*degraded/);
  });
  it("$ref renomme vers un schema compatible (meme forme + champ optionnel) n'est pas une rupture ; vers un schema appauvri, si", () => {
    const next = clone(base);
    const schema = next.paths["/api/v1/health"].get.responses["200"].content["application/json"].schema;
    schema.$ref = "#/components/schemas/HealthDetail";
    next.components.schemas.HealthDetail = clone(next.components.schemas.HealthResponse);
    next.components.schemas.HealthDetail.properties.uptime = { type: "number" };
    expect(findBreakingChanges(base, next)).toEqual([]);
    delete next.components.schemas.HealthDetail.properties.version;
    next.components.schemas.HealthDetail.required = ["status"];
    expect(findBreakingChanges(base, next).join("\n")).toMatch(/200\.version : propriete supprimee/);
  });
  it("ajout d'un champ optionnel n'est pas une rupture", () => {
    const next = clone(base);
    next.components.schemas.HealthResponse.properties.uptime = { type: "number" };
    expect(findBreakingChanges(base, next)).toEqual([]);
  });
});
