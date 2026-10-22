// Detection structurelle de ruptures entre deux specs OpenAPI (oasdiff n'existe pas sur npm :
// le paquet "oasdiff" est un placeholder securite). Perimetre : voir packages/contracts/README.md.
type Json = Record<string, any>;

function resolve(spec: Json, s: Json | undefined): Json | undefined {
  while (s?.$ref) {
    const name = String(s.$ref).split("/").pop()!;
    s = spec.components?.schemas?.[name];
  }
  return s;
}

/**
 * Exception relue à la règle « un $ref renommé est une rupture » (fichier breaking-allowlist.json, voir le README de
 * packages/contracts). `at` = emplacement sous la réponse, tel que l'affiche le rapport : "" (racine), ".items[]", ".person"...
 */
export interface RefRenameException { method: string; path: string; status: string; at: string; from: string; to: string; reason: string; rt: string }

const EXCEPTION_KEYS = ["method", "path", "status", "at", "from", "to", "reason", "rt"] as const;
/** Lit et valide la liste d'exceptions ; lève une erreur sur toute entrée incomplète, inconnue ou mal formée. */
export function parseAllowlist(text: string): RefRenameException[] {
  const doc = JSON.parse(text) as { exceptions?: unknown };
  if (!Array.isArray(doc.exceptions)) throw new Error("breaking-allowlist : `exceptions` doit etre un tableau");
  return doc.exceptions.map((e: any, i: number) => {
    const where = `breaking-allowlist : exception ${i}`;
    if (!e || typeof e !== "object") throw new Error(`${where} : objet attendu`);
    const extra = Object.keys(e).filter((k) => !(EXCEPTION_KEYS as readonly string[]).includes(k));
    if (extra.length) throw new Error(`${where} : champ(s) inconnu(s) ${extra.join(", ")}`);
    for (const k of EXCEPTION_KEYS) if (typeof e[k] !== "string") throw new Error(`${where} : ${k} manquant`);
    if (!/^(get|post|put|patch|delete)$/.test(e.method)) throw new Error(`${where} : method en minuscules (get, post...)`);
    if (!/^\d{3}$/.test(e.status)) throw new Error(`${where} : status sur 3 chiffres`);
    for (const k of ["from", "to"] as const) if (!/^#\/components\/schemas\/[\w.-]+$/.test(e[k])) throw new Error(`${where} : ${k} = #/components/schemas/<Nom>`);
    if (!e.reason.trim()) throw new Error(`${where} : reason vide`);
    if (!/^RT-\d{3}$/.test(e.rt)) throw new Error(`${where} : rt au format RT-NNN`);
    return e as RefRenameException;
  });
}

/** Sérialisation canonique (clés triées), pour comparer deux schémas sans dépendre de l'ordre des clés. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Json)[k])}`).join(",")}}`
  : JSON.stringify(v);

/**
 * Le nouveau schéma est-il exactement l'ancien plus des propriétés FACULTATIVES (même type, mêmes required, mêmes propriétés à
 * l'identique, rien d'autre) ? Seul cas qu'une exception peut couvrir ; tout autre écart reste une rupture.
 */
function onlyAddsOptional(a: Json, b: Json): boolean {
  if (!a.properties || !b.properties) return false;
  const required = new Set<string>(b.required ?? []);
  const added = Object.keys(b.properties).filter((k) => !(k in a.properties));
  if (added.some((k) => required.has(k))) return false;
  const trimmed: Json = { ...b, properties: Object.fromEntries(Object.entries(b.properties).filter(([k]) => !added.includes(k))) };
  return canon(a) === canon(trimmed);
}

interface RespCtx { method: string; path: string; status: string; prefix: string; allow: readonly RefRenameException[] }

function cmpSchema(a: Json | undefined, b: Json | undefined, oldSpec: Json, newSpec: Json, where: string, out: string[], seen: Set<string>, ctx?: RespCtx): void {
  if (!a) return;
  if (!b) {
    out.push(`${where} : schema supprime`);
    return;
  }
  if (a.$ref || b.$ref) {
    // `seen` mémorise la PAIRE (ancien, nouveau) : un même ancien $ref peut être comparé à deux cibles différentes.
    const key = `${a.$ref ?? "inline"} -> ${b.$ref ?? "inline"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const renamed = a.$ref !== b.$ref;
    const ra = resolve(oldSpec, a);
    const rb = resolve(newSpec, b);
    if (!ra) return;
    if (!rb) return void out.push(`${where} : schema supprime`);
    if (!renamed) return cmpSchema(ra, rb, oldSpec, newSpec, where, out, seen, ctx);
    // $ref renommé : rupture, sauf exception listée à l'emplacement exact, sans écart structurel et sans autre ajout que du facultatif.
    const inner: string[] = [];
    cmpSchema(ra, rb, oldSpec, newSpec, where, inner, seen, ctx);
    const at = ctx && where.startsWith(ctx.prefix) ? where.slice(ctx.prefix.length) : null;
    const listed = ctx && at !== null && ctx.allow.some((e) =>
      e.method === ctx.method && e.path === ctx.path && e.status === ctx.status && e.at === at && e.from === a.$ref && e.to === b.$ref);
    if (listed && inner.length === 0 && onlyAddsOptional(ra, rb)) return;
    out.push(`${where} : $ref ${a.$ref ?? "inline"} -> ${b.$ref ?? "inline"}`, ...inner);
    return;
  }
  if (JSON.stringify(a.type) !== JSON.stringify(b.type)) {
    out.push(`${where} : type ${JSON.stringify(a.type)} -> ${JSON.stringify(b.type)}`);
    return;
  }
  if (a.enum) {
    const gone = a.enum.filter((v: unknown) => !(b.enum ?? []).includes(v));
    if (!b.enum || gone.length) out.push(`${where} : valeur(s) d'enum retiree(s) ${JSON.stringify(gone.length ? gone : a.enum)}`);
  }
  for (const k of a.required ?? []) {
    if (!(b.required ?? []).includes(k)) out.push(`${where}.${k} : n'est plus garanti present (required retire)`);
  }
  for (const [k, v] of Object.entries<Json>(a.properties ?? {})) {
    if (!b.properties?.[k]) out.push(`${where}.${k} : propriete supprimee`);
    else cmpSchema(v, b.properties[k], oldSpec, newSpec, `${where}.${k}`, out, seen, ctx);
  }
  if (a.items) cmpSchema(a.items, b.items, oldSpec, newSpec, `${where}[]`, out, seen, ctx);
  for (const key of ["anyOf", "oneOf"] as const) {
    (a[key] ?? []).forEach((v: Json, i: number) => cmpSchema(v, b[key]?.[i], oldSpec, newSpec, `${where}|${i}`, out, seen, ctx));
  }
}

// Cote REQUETE le sens s'inverse : ce qui casse un client existant, c'est d'exiger plus (propriete requise nouvelle),
// d'accepter moins (valeur d'enum retiree) ou de changer le type attendu. Retirer une propriete optionnelle n'est pas
// detecte (le serveur peut l'ignorer ou la refuser : cela releve de la semantique).
function cmpRequest(a: Json | undefined, b: Json | undefined, oldSpec: Json, newSpec: Json, where: string, out: string[], seen: Set<string>): void {
  if (!a || !b) return;
  if (a.$ref || b.$ref) {
    if (a.$ref !== b.$ref) out.push(`${where} : $ref ${a.$ref ?? "inline"} -> ${b.$ref ?? "inline"}`);
    const k = String(a.$ref);
    if (a.$ref && seen.has(k)) return;
    if (a.$ref) seen.add(k);
    a = resolve(oldSpec, a);
    b = resolve(newSpec, b);
    if (!a || !b) return;
  }
  if (JSON.stringify(a.type) !== JSON.stringify(b.type)) {
    out.push(`${where} : type ${JSON.stringify(a.type)} -> ${JSON.stringify(b.type)}`);
    return;
  }
  if (a.enum) {
    const gone = a.enum.filter((v: unknown) => !(b.enum ?? []).includes(v));
    if (!b.enum || gone.length) out.push(`${where} : valeur(s) d'enum acceptee(s) retiree(s) ${JSON.stringify(gone.length ? gone : a.enum)}`);
  }
  for (const k of b.required ?? []) {
    if (!(a.required ?? []).includes(k)) out.push(`${where}.${k} : nouvelle propriete requise`);
  }
  for (const [k, v] of Object.entries<Json>(a.properties ?? {})) {
    if (b.properties?.[k]) cmpRequest(v, b.properties[k], oldSpec, newSpec, `${where}.${k}`, out, seen);
  }
  if (a.items) cmpRequest(a.items, b.items, oldSpec, newSpec, `${where}[]`, out, seen);
  for (const k of ["anyOf", "oneOf"] as const) {
    if ((a[k]?.length ?? 0) > (b[k]?.length ?? 0)) out.push(`${where} : variante(s) retiree(s) de ${k}`);
    (a[k] ?? []).forEach((v: Json, i: number) => cmpRequest(v, b[k]?.[i], oldSpec, newSpec, `${where}|${i}`, out, seen));
  }
}

/** Liste lisible des ruptures de `next` par rapport a `base` (vide = compatible). Cote reponses. */
export function findBreakingChanges(base: Json, next: Json, allow: readonly RefRenameException[] = []): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<Json>(base.paths ?? {})) {
    for (const [method, op] of Object.entries<Json>(item)) {
      const id = `${method.toUpperCase()} ${path}`;
      const nop = next.paths?.[path]?.[method];
      if (!nop) {
        out.push(`${id} : operation supprimee`);
        continue;
      }
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        const nresp = nop.responses?.[code];
        if (!nresp) {
          out.push(`${id} : reponse ${code} supprimee`);
          continue;
        }
        const ctx: RespCtx = { method, path, status: code, prefix: `${id} ${code}`, allow };
        cmpSchema(resp.content?.["application/json"]?.schema, nresp.content?.["application/json"]?.schema, base, next, `${id} ${code}`, out, new Set(), ctx);
      }
      const oldBody = op.requestBody;
      const newBody = nop.requestBody;
      if (oldBody && !newBody) out.push(`${id} : corps de requete supprime`);
      if (newBody?.required && !oldBody?.required) out.push(`${id} : corps de requete devient requis`);
      cmpRequest(oldBody?.content?.["application/json"]?.schema, newBody?.content?.["application/json"]?.schema, base, next, `${id} corps`, out, new Set());
      const key = (p: Json) => `${p.in}:${p.name}`;
      const baseParams = new Map<string, Json>((op.parameters ?? []).map((p: Json) => [key(p), p]));
      const nextParams = new Map<string, Json>((nop.parameters ?? []).map((p: Json) => [key(p), p]));
      for (const [k, p] of nextParams) {
        if (p.required && !baseParams.has(k)) out.push(`${id} : nouveau parametre requis ${k}`);
      }
      for (const [k, p] of baseParams) {
        const n = nextParams.get(k);
        if (!n) {
          out.push(`${id} : parametre supprime ${k}`);
          continue;
        }
        if (n.required && !p.required) out.push(`${id} : ${k} : devient requis`);
        if (JSON.stringify(p.schema?.type) !== JSON.stringify(n.schema?.type)) {
          out.push(`${id} : ${k} : type ${JSON.stringify(p.schema?.type)} -> ${JSON.stringify(n.schema?.type)}`);
        }
        // Cote requete, retirer une valeur acceptee casse les clients existants (l'inverse est compatible).
        const gone = (p.schema?.enum ?? []).filter((v: unknown) => !(n.schema?.enum ?? []).includes(v));
        if (p.schema?.enum && gone.length) out.push(`${id} : ${k} : valeur(s) d'enum retiree(s) ${JSON.stringify(gone)}`);
      }
    }
  }
  return out;
}
