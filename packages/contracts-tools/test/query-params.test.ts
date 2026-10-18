// Paramètres de requête (GET avec filtres, ex. /schedule) : spec OpenAPI -> client typé, et détection de ruptures.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBreakingChanges } from "../src/breaking";
import { generateClient } from "../src/client";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const specWith = (parameters: unknown[]) => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  components: { schemas: {} },
  paths: {
    "/api/v1/things": {
      get: {
        operationId: "listThings",
        summary: "Liste",
        parameters,
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } } } },
      },
    },
  },
});

const q = (name: string, schema: unknown, required = false) => ({ name, in: "query", required, schema });

describe("client genere : parametres de requete", () => {
  const src = generateClient(specWith([
    q("from", { type: "string" }, true),
    q("limit", { type: "integer" }),
    q("includeInactive", { type: "boolean" }),
    q("kind", { type: "string", enum: ["a", "b"] }),
    q("tag", { type: "array", items: { type: "string" } }),
  ]));
  it("type la requete : requis sans '?', optionnels avec '?'", () => {
    expect(src).toContain("async listThings(query: {");
    expect(src).toMatch(/from: string;/);
    expect(src).toMatch(/limit\?: number;/);
    expect(src).toMatch(/includeInactive\?: boolean;/);
    expect(src).toMatch(/kind\?: "a" \| "b";/);
    expect(src).toMatch(/tag\?: Array<string>;/);
  });
  it("serialise la requete (valeurs indefinies omises, tableaux repetes)", () => {
    expect(src).toContain("toQueryString(query)");
    expect(src).toContain("function toQueryString");
  });
  it("tous les parametres optionnels : requete facultative", () => {
    expect(generateClient(specWith([q("limit", { type: "integer" })]))).toContain("query: {\n      limit?: number;\n    } = {}");
  });
  it("aucun parametre : signature inchangee", () => {
    expect(generateClient(specWith([]))).toContain("async listThings(): Promise");
  });
  it("parametre de chemin ou d'en-tete : erreur explicite (non supporte)", () => {
    expect(() => generateClient(specWith([{ name: "id", in: "path", required: true, schema: { type: "string" } }]))).toThrow(/non supporte/);
  });
  it("le client genere construit la bonne URL (execution reelle)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wnext-client-"));
    try {
      const file = join(dir, "client.ts");
      writeFileSync(file, src);
      const { createClient } = await import(/* @vite-ignore */ file);
      const urls: string[] = [];
      const fetch = async (url: string) => (urls.push(url), { status: 200, json: async () => ({ n: 1 }) });
      const api = createClient({ baseUrl: "http://x", fetch });
      await api.listThings({ from: "2026-03-01", limit: 5, includeInactive: false, kind: "b", tag: ["a b", "c"] });
      await api.listThings({ from: "2026-03-01", limit: undefined });
      expect(urls[0]).toBe("http://x/api/v1/things?from=2026-03-01&limit=5&includeInactive=false&kind=b&tag=a%20b&tag=c");
      expect(urls[1]).toBe("http://x/api/v1/things?from=2026-03-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detection de rupture : parametres de requete", () => {
  const base = specWith([q("from", { type: "string" }, true), q("limit", { type: "integer" }), q("kind", { type: "string", enum: ["a", "b"] })]);
  it("identique : aucune rupture", () => {
    expect(findBreakingChanges(base, clone(base))).toEqual([]);
  });
  it("ajout d'un parametre optionnel : compatible", () => {
    const next = specWith([...(base as any).paths["/api/v1/things"].get.parameters, q("cursor", { type: "string" })]);
    expect(findBreakingChanges(base, next)).toEqual([]);
  });
  it("nouveau parametre requis : rupture (deja detecte)", () => {
    const next = specWith([...(base as any).paths["/api/v1/things"].get.parameters, q("tenant", { type: "string" }, true)]);
    expect(findBreakingChanges(base, next).join()).toMatch(/nouveau parametre requis query:tenant/);
  });
  it("parametre supprime : rupture", () => {
    const next = specWith([q("from", { type: "string" }, true), q("kind", { type: "string", enum: ["a", "b"] })]);
    expect(findBreakingChanges(base, next).join()).toMatch(/parametre supprime query:limit/);
  });
  it("parametre optionnel devenu requis : rupture", () => {
    const next = specWith([q("from", { type: "string" }, true), q("limit", { type: "integer" }, true), q("kind", { type: "string", enum: ["a", "b"] })]);
    expect(findBreakingChanges(base, next).join()).toMatch(/query:limit : devient requis/);
  });
  it("type modifie : rupture", () => {
    const next = specWith([q("from", { type: "integer" }, true), q("limit", { type: "integer" }), q("kind", { type: "string", enum: ["a", "b"] })]);
    expect(findBreakingChanges(base, next).join()).toMatch(/query:from : type/);
  });
  it("valeur d'enum acceptee retiree : rupture ; ajoutee : compatible", () => {
    const narrower = specWith([q("from", { type: "string" }, true), q("limit", { type: "integer" }), q("kind", { type: "string", enum: ["a"] })]);
    expect(findBreakingChanges(base, narrower).join()).toMatch(/query:kind : valeur\(s\) d'enum retiree\(s\) \["b"\]/);
    const wider = specWith([q("from", { type: "string" }, true), q("limit", { type: "integer" }), q("kind", { type: "string", enum: ["a", "b", "c"] })]);
    expect(findBreakingChanges(base, wider)).toEqual([]);
  });
});
