// Generateur minimal Spec OpenAPI 3.1 -> client TypeScript (types + fonctions typees).
// Maison, volontairement : openapi-typescript exige l'API JS de TypeScript 5 (incompatible TS 7),
// orval et hey-api exigent Node >= 22.18. Couvre le sous-ensemble produit par zod-to-openapi
// pour nos schemas ; toute construction inconnue leve une erreur (jamais de `any` silencieux).
type Json = Record<string, any>;

function ref(r: string): string {
  const m = /^#\/components\/schemas\/(\w+)$/.exec(r);
  if (!m) throw new Error(`$ref non supporte : ${r}`);
  return m[1]!;
}

export function tsType(s: Json, indent = ""): string {
  if (s.$ref) return ref(s.$ref);
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map((x: Json) => tsType(x, indent)).join(" | ");
  const t = Array.isArray(s.type) ? s.type : [s.type];
  const parts = t.map((one: string) => {
    switch (one) {
      case "string": return "string";
      case "number": case "integer": return "number";
      case "boolean": return "boolean";
      case "null": return "null";
      case "array": return `Array<${tsType(s.items ?? {}, indent)}>`;
      case "object": return objectType(s, indent);
      default: throw new Error(`type de schema non supporte : ${JSON.stringify(s)}`);
    }
  });
  return parts.join(" | ");
}

function objectType(s: Json, indent: string): string {
  const props: Json = s.properties ?? {};
  const required: string[] = s.required ?? [];
  const lines = Object.entries(props).map(
    ([k, v]) => `${indent}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${required.includes(k) ? "" : "?"}: ${tsType(v as Json, indent + "  ")};`,
  );
  if (s.additionalProperties && typeof s.additionalProperties === "object") {
    lines.push(`${indent}  [key: string]: ${tsType(s.additionalProperties, indent + "  ")};`);
  }
  return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "Record<string, never>";
}

const jsonSchema = (r: Json): Json | undefined => r?.content?.["application/json"]?.schema;

export function generateClient(spec: Json): string {
  const out: string[] = [
    "// GENERE par packages/contracts-tools (npm run generate:contract) a partir de",
    "// packages/contracts/openapi.json. Ne pas editer a la main.",
    "",
  ];
  for (const [name, schema] of Object.entries<Json>(spec.components?.schemas ?? {})) {
    const body = tsType(schema);
    out.push(body.startsWith("{") ? `export interface ${name} ${body}` : `export type ${name} = ${body};`, "");
  }
  out.push(
    "export interface FetchResponse {",
    "  status: number;",
    "  json(): Promise<unknown>;",
    "}",
    "export type Fetcher = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;",
    "",
    "export type ApiResult<T, E> = { ok: true; status: number; data: T } | { ok: false; status: number; error: E };",
    "",
    "export function createClient(options: { baseUrl: string; fetch: Fetcher }) {",
    "  return {",
  );
  for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<Json>(item)) {
      if (!op.operationId) throw new Error(`operationId manquant : ${method} ${path}`);
      const ok: string[] = [];
      const err: string[] = [];
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        const s = jsonSchema(resp);
        const t = s ? tsType(s) : "void";
        (/^2/.test(code) ? ok : err).push(t);
      }
      const okT = ok.join(" | ") || "void";
      const errT = err.join(" | ") || "never";
      out.push(
        `    /** ${op.summary ?? op.operationId} (${method.toUpperCase()} ${path}) */`,
        `    async ${op.operationId}(): Promise<ApiResult<${okT}, ${errT}>> {`,
        `      const res = await options.fetch(options.baseUrl + ${JSON.stringify(path)}, { method: ${JSON.stringify(method.toUpperCase())}, headers: { accept: "application/json" } });`,
        `      const body = await res.json();`,
        `      return res.status >= 200 && res.status < 300`,
        `        ? { ok: true, status: res.status, data: body as ${okT} }`,
        `        : { ok: false, status: res.status, error: body as ${errT} };`,
        `    },`,
      );
    }
  }
  out.push("  };", "}", "");
  return out.join("\n");
}
