// Ecritures : parametres de chemin, en-tetes (If-Match), corps JSON, reponse 204. Spec -> client typé et exécutable, et ruptures côté requête.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBreakingChanges } from "../src/breaking";
import { generateClient } from "../src/client";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const ok = { "200": { description: "ok", content: { "application/json": { schema: obj({ n: { type: "number" } }, ["n"]) } } } };

const spec = (over: { body?: unknown; bodyRequired?: boolean } = {}): any => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  components: { schemas: {} },
  paths: {
    "/api/v1/things/{id}": {
      patch: {
        operationId: "patchThing",
        summary: "Modifier",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: { required: over.bodyRequired ?? true, content: { "application/json": { schema: over.body ?? obj({ name: { type: "string" }, kind: { type: "string", enum: ["a", "b"] } }, []) } } },
        responses: ok,
      },
      delete: {
        operationId: "deleteThing",
        summary: "Supprimer",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "supprime" } },
      },
    },
  },
});

describe("client genere : chemin, en-tete, corps", () => {
  const src = generateClient(spec());
  it("type l'entree en groupes path / headers / body", () => {
    expect(src).toContain("async patchThing(input: {");
    expect(src).toMatch(/path: \{\n\s+id: string;/);
    expect(src).toMatch(/headers: \{\n\s+"If-Match": string;/);
    expect(src).toMatch(/body: \{/);
  });
  it("execution reelle : URL encodee, en-tete transmis, corps JSON, 204 sans lecture du corps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wnext-client-"));
    try {
      const file = join(dir, "client.ts");
      writeFileSync(file, src);
      const { createClient } = await import(/* @vite-ignore */ file);
      const calls: any[] = [];
      const fetch = async (url: string, init: any) => (calls.push({ url, init }), init.method === "DELETE"
        ? { status: 204, json: async () => { throw new Error("pas de corps"); } }
        : { status: 200, json: async () => ({ n: 1 }) });
      const api = createClient({ baseUrl: "http://x", fetch });
      await api.patchThing({ path: { id: "a/b 1" }, headers: { "If-Match": '"3"' }, body: { name: "z" } });
      const del = await api.deleteThing({ path: { id: "7" }, headers: { "If-Match": '"1"' } });
      expect(calls[0].url).toBe("http://x/api/v1/things/a%2Fb%201");
      expect(calls[0].init.method).toBe("PATCH");
      expect(calls[0].init.headers).toEqual({ accept: "application/json", "content-type": "application/json", "If-Match": '"3"' });
      expect(JSON.parse(calls[0].init.body)).toEqual({ name: "z" });
      expect(calls[1].init.body).toBeUndefined();
      expect(del).toEqual({ ok: true, status: 204, data: undefined });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detection de rupture : requete", () => {
  const base = spec();
  const withBody = (body: unknown, bodyRequired?: boolean) => spec({ body, bodyRequired });
  it("identique : aucune rupture", () => expect(findBreakingChanges(base, clone(base))).toEqual([]));
  it("propriete optionnelle ajoutee : compatible", () => {
    expect(findBreakingChanges(base, withBody(obj({ name: { type: "string" }, kind: { type: "string", enum: ["a", "b"] }, tag: { type: "string" } }, [])))).toEqual([]);
  });
  it("propriete requise ajoutee : rupture", () => {
    expect(findBreakingChanges(base, withBody(obj({ name: { type: "string" }, kind: { type: "string", enum: ["a", "b"] } }, ["name"]))).join()).toMatch(/corps\.name : nouvelle propriete requise/);
  });
  it("valeur d'enum acceptee retiree : rupture ; ajoutee : compatible", () => {
    expect(findBreakingChanges(base, withBody(obj({ name: { type: "string" }, kind: { type: "string", enum: ["a"] } }, []))).join()).toMatch(/corps\.kind : valeur\(s\) d'enum acceptee\(s\) retiree\(s\) \["b"\]/);
    expect(findBreakingChanges(base, withBody(obj({ name: { type: "string" }, kind: { type: "string", enum: ["a", "b", "c"] } }, [])))).toEqual([]);
  });
  it("type change : rupture", () => {
    expect(findBreakingChanges(base, withBody(obj({ name: { type: "number" }, kind: { type: "string", enum: ["a", "b"] } }, []))).join()).toMatch(/corps\.name : type/);
  });
  it("corps devenu requis ou supprime : rupture", () => {
    expect(findBreakingChanges(spec({ bodyRequired: false }), base).join()).toMatch(/corps de requete devient requis/);
    const noBody = clone(base);
    delete noBody.paths["/api/v1/things/{id}"].patch.requestBody;
    expect(findBreakingChanges(base, noBody).join()).toMatch(/corps de requete supprime/);
  });
  it("variante retiree d'une union : rupture", () => {
    const u = (n: number) => ({ oneOf: Array.from({ length: n }, (_, i) => obj({ m: { type: "string", enum: [`m${i}`] } }, ["m"])) });
    expect(findBreakingChanges(withBody(u(2)), withBody(u(1))).join()).toMatch(/variante\(s\) retiree\(s\) de oneOf/);
    expect(findBreakingChanges(withBody(u(1)), withBody(u(2)))).toEqual([]);
  });
  it("en-tete ou chemin nouveau et requis : rupture", () => {
    const next = clone(base);
    next.paths["/api/v1/things/{id}"].patch.parameters.push({ name: "X-Tenant", in: "header", required: true, schema: { type: "string" } });
    expect(findBreakingChanges(base, next).join()).toMatch(/nouveau parametre requis header:X-Tenant/);
  });
});
