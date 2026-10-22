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

function cmpSchema(a: Json | undefined, b: Json | undefined, oldSpec: Json, newSpec: Json, where: string, out: string[], seen: Set<string>): void {
  if (!a) return;
  if (!b) {
    out.push(`${where} : schema supprime`);
    return;
  }
  // Un $ref renommé n'est pas une rupture en soi (le JSON reçu est le même) : on compare la structure résolue, qui signale
  // propriété supprimée, required retiré, type changé ou enum appauvrie (p. ex. SchedulePerson -> PersonDetail, RT-040).
  if (a.$ref || b.$ref) {
    const key = String(a.$ref);
    if (a.$ref && seen.has(key)) return;
    if (a.$ref) seen.add(key);
    a = resolve(oldSpec, a);
    b = resolve(newSpec, b);
    if (!a) return;
    if (!b) return void out.push(`${where} : schema supprime`);
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
    else cmpSchema(v, b.properties[k], oldSpec, newSpec, `${where}.${k}`, out, seen);
  }
  if (a.items) cmpSchema(a.items, b.items, oldSpec, newSpec, `${where}[]`, out, seen);
  for (const key of ["anyOf", "oneOf"] as const) {
    (a[key] ?? []).forEach((v: Json, i: number) => cmpSchema(v, b[key]?.[i], oldSpec, newSpec, `${where}|${i}`, out, seen));
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
export function findBreakingChanges(base: Json, next: Json): string[] {
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
        cmpSchema(resp.content?.["application/json"]?.schema, nresp.content?.["application/json"]?.schema, base, next, `${id} ${code}`, out, new Set());
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
