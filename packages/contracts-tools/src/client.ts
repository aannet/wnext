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

type Param = { name: string; in: string; required?: boolean; schema: Json };

/** Parametres d'une operation. Les cookies ne sont pas supportes : erreur explicite. */
function operationParams(op: Json, where: string): Record<"query" | "path" | "header", Param[]> {
  const out = { query: [] as Param[], path: [] as Param[], header: [] as Param[] };
  for (const p of (op.parameters ?? []) as Param[]) {
    if (p.in !== "query" && p.in !== "path" && p.in !== "header") throw new Error(`parametre ${p.in}:${p.name} non supporte par le generateur de client (${where})`);
    out[p.in].push(p);
  }
  return out;
}

const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

function paramsType(params: Param[], indent: string): string {
  const lines = params.map((p) => `${indent}  ${key(p.name)}${p.required ? "" : "?"}: ${tsType(p.schema)};`);
  return `{\n${lines.join("\n")}\n${indent}}`;
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
    const isInterface = (schema as Json).type === "object" && !(schema as Json).oneOf && !(schema as Json).anyOf && body.startsWith("{");
    out.push(isInterface ? `export interface ${name} ${body}` : `export type ${name} = ${body};`, "");
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
    "/** Valeurs indefinies omises ; un tableau repete la cle (?tag=a&tag=b). */",
    "function toQueryString(query: Record<string, unknown>): string {",
    "  const parts: string[] = [];",
    "  for (const [key, value] of Object.entries(query)) {",
    "    if (value === undefined) continue;",
    "    for (const item of Array.isArray(value) ? value : [value]) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);",
    "  }",
    "  return parts.length ? `?${parts.join(\"&\")}` : \"\";",
    "}",
    "",
    "export function createClient(options: { baseUrl: string; fetch: Fetcher }) {",
    "  return {",
  );
  for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<Json>(item)) {
      if (!op.operationId) throw new Error(`operationId manquant : ${method} ${path}`);
      const where = `${method.toUpperCase()} ${path}`;
      const params = operationParams(op, where);
      const bodySchema = jsonSchema(op.requestBody);
      if (op.requestBody && !bodySchema) throw new Error(`corps de requete non JSON non supporte (${where})`);
      const onlyQuery = !params.path.length && !params.header.length && !bodySchema;
      const q = params.query;
      const allOptional = q.every((p) => !p.required);
      let arg = "";
      let get = (k: "path" | "query" | "header" | "body") => k as string;
      if (onlyQuery) {
        // Forme historique : la requete est l'argument.
        arg = q.length ? `query: ${paramsType(q, "    ")}${allOptional ? " = {}" : ""}` : "";
        get = () => "query";
      } else {
        const members: string[] = [];
        if (params.path.length) members.push(`path: ${paramsType(params.path, "      ")}`);
        if (q.length) members.push(`query${allOptional ? "?" : ""}: ${paramsType(q, "      ")}`);
        if (params.header.length) members.push(`headers${params.header.some((p) => p.required) ? "" : "?"}: ${paramsType(params.header, "      ")}`);
        if (bodySchema) members.push(`body${op.requestBody.required ? "" : "?"}: ${tsType(bodySchema, "      ")}`);
        arg = `input: {\n      ${members.join(";\n      ")};\n    }`;
        get = (k) => `input.${k === "header" ? "headers" : k}`;
      }
      const target = JSON.stringify(path).replace(/\{(\w+)\}/g, (_m, n) => `" + encodeURIComponent(String(${get("path")}.${n})) + "`);
      const urlExpr = `options.baseUrl + ${target}`.replace(/ \+ ""$/, "") + (q.length ? ` + toQueryString(${get("query")}${onlyQuery || !allOptional ? "" : " ?? {}"})` : "");
      const headerParts = [`accept: "application/json"`];
      if (bodySchema) headerParts.push(`"content-type": "application/json"`);
      const headers = `{ ${headerParts.join(", ")}${params.header.length ? `, ...${get("header")}` : ""} }`;
      const bodyInit = bodySchema ? `, body: JSON.stringify(${get("body")})` : "";
      const ok: string[] = [];
      const err: string[] = [];
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        const s = jsonSchema(resp);
        const t = s ? tsType(s) : "void";
        (/^2/.test(code) ? ok : err).push(t);
      }
      const okT = [...new Set(ok)].join(" | ") || "void";
      const errT = [...new Set(err)].join(" | ") || "never";
      out.push(
        `    /** ${op.summary ?? op.operationId} (${method.toUpperCase()} ${path}) */`,
        `    async ${op.operationId}(${arg}): Promise<ApiResult<${okT}, ${errT}>> {`,
        `      const res = await options.fetch(${urlExpr}, { method: ${JSON.stringify(method.toUpperCase())}, headers: ${headers}${bodyInit} });`,
        `      const body = res.status === 204 ? undefined : await res.json();`,
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
