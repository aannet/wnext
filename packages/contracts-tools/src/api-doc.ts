import "./zod-setup";
import { OpenApiGeneratorV31, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  REALTIME_PATH, REALTIME_PROTOCOL_VERSION, REALTIME_RETRY_AFTER_SECONDS, REALTIME_TICKET_PARAM, REALTIME_TICKET_PATH,
  REALTIME_TICKET_TTL_SECONDS, RealtimeChanges, RealtimeError, RealtimeNotifications, RealtimeReady, RealtimeResync, RealtimeSubscribe,
} from "@wnext/contracts";

// Doc API lisible (docs/03-tech/api.html) rendue depuis la spec OpenAPI et les schémas du temps réel, qui ne sont pas dans la spec.
// Générée par `npm run generate:contract`, contrôlée par `check:contract` comme openapi.json : jamais éditée à la main.

type Schema = Record<string, any>;
type Spec = { info: { title: string; version: string }; paths: Record<string, Record<string, any>>; components: { schemas: Record<string, Schema> } };

const CLIENT_MESSAGES = { RealtimeSubscribe };
const SERVER_MESSAGES = { RealtimeChanges, RealtimeReady, RealtimeResync, RealtimeError, RealtimeNotifications };

/** Composants JSON Schema des messages temps réel (et des schémas qu'ils référencent). */
export function buildRealtimeComponents(): Record<string, Schema> {
  const registry = new OpenAPIRegistry();
  for (const [name, schema] of Object.entries({ ...CLIENT_MESSAGES, ...SERVER_MESSAGES })) registry.register(name, schema);
  const doc = new OpenApiGeneratorV31(registry.definitions).generateComponents() as { components?: { schemas?: Record<string, Schema> } };
  return doc.components?.schemas ?? {};
}

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const refName = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);
const METHODS = ["get", "post", "put", "patch", "delete"];

export function renderApiDoc(spec: Spec, realtime: Record<string, Schema>): string {
  const rest = spec.components.schemas;
  const anchor = (name: string) => (name in rest ? `schema-${name}` : `ws-${name}`);
  const link = (name: string) => `<a href="#${anchor(name)}"><code>${esc(name)}</code></a>`;

  const constraints = (s: Schema) => {
    const c: string[] = [];
    if (s.format) c.push(s.format);
    if (s.pattern) c.push(`motif ${s.pattern}`);
    for (const [k, l] of [["minLength", "long. ≥"], ["maxLength", "long. ≤"], ["minimum", "≥"], ["maximum", "≤"], ["exclusiveMinimum", ">"], ["exclusiveMaximum", "<"], ["minItems", "éléments ≥"], ["maxItems", "éléments ≤"]] as const)
      if (s[k] !== undefined) c.push(`${l} ${s[k]}`);
    if (s.default !== undefined) c.push(`défaut ${JSON.stringify(s.default)}`);
    return c.length ? ` <span class="c">${esc(c.join(" · "))}</span>` : "";
  };

  /** Type d'un schéma en une ligne (les objets anonymes ont leur propre tableau). */
  const typeOf = (s: Schema | undefined, depth = 0): string => {
    if (!s || Object.keys(s).length === 0) return "<code>any</code>";
    if (s.$ref) return link(refName(s.$ref));
    if (s.const !== undefined) return `<code>${esc(JSON.stringify(s.const))}</code>`;
    if (s.enum) return s.enum.map((v: unknown) => `<code>${esc(JSON.stringify(v))}</code>`).join(" | ") + constraints(s);
    for (const k of ["oneOf", "anyOf"]) if (s[k]) return s[k].map((x: Schema) => typeOf(x, depth)).join(" | ");
    if (s.allOf) return s.allOf.map((x: Schema) => typeOf(x, depth)).join(" &amp; ");
    const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const parts = types.map((t) => {
      if (t === "array") return `${typeOf(s.items, depth)}[]`;
      if (t === "object") {
        if (s.properties && depth < 4) return `objet${propsTable(s, depth + 1)}`;
        if (s.additionalProperties && typeof s.additionalProperties === "object") return `objet { clé : ${typeOf(s.additionalProperties, depth)} }`;
        return "<code>objet</code>";
      }
      return `<code>${esc(t)}</code>`;
    });
    return (parts.join(" | ") || "<code>any</code>") + constraints(s);
  };

  const propsTable = (s: Schema, depth: number): string => {
    const req = new Set<string>(s.required ?? []);
    const rows = Object.entries(s.properties ?? {}).map(([k, v]) =>
      `<tr><td><code>${esc(k)}</code>${req.has(k) ? "" : ' <span class="opt">facultatif</span>'}</td><td>${typeOf(v as Schema, depth)}</td></tr>`).join("");
    const extra = s.additionalProperties === false ? '<p class="note">Aucune autre propriété acceptée.</p>' : "";
    return `<table class="props${depth > 0 ? " nested" : ""}"><tbody>${rows}</tbody></table>${extra}`;
  };

  const schemaBlock = (name: string, s: Schema, id: string) => {
    const body = s.type === "object" || s.properties ? propsTable(s, 0) : `<p>${typeOf(s)}</p>`;
    return `<section class="schema" id="${id}"><h3><code>${esc(name)}</code></h3>${s.description ? `<p>${esc(s.description)}</p>` : ""}${body}</section>`;
  };

  // ----- opérations, groupées par ressource (premier segment après /api/v1/) -----
  const groups = new Map<string, string[]>();
  let opCount = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    const group = path.replace(/^\/api\/v\d+\//, "").split("/")[0] || "racine";
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      opCount++;
      const params = (op.parameters ?? []) as Schema[];
      const paramRows = params.map((p) =>
        `<tr><td><code>${esc(p.name)}</code>${p.required ? "" : ' <span class="opt">facultatif</span>'}</td><td>${esc(p.in)}</td><td>${typeOf(p.schema)}</td></tr>`).join("");
      const body = op.requestBody?.content?.["application/json"]?.schema;
      const responses = Object.entries(op.responses ?? {}).map(([code, r]: [string, any]) => {
        const schema = r.content?.["application/json"]?.schema;
        return `<tr><td><span class="st s${code[0]}">${esc(code)}</span></td><td>${esc(r.description ?? "")}</td><td>${schema ? typeOf(schema) : "—"}</td></tr>`;
      }).join("");
      const html = `<article class="op" id="op-${esc(op.operationId)}">
<h3><span class="verb ${method}">${method.toUpperCase()}</span> <code class="path">${esc(path)}</code></h3>
<p>${esc(op.summary ?? "")} <span class="opid">${esc(op.operationId)}</span></p>
${paramRows ? `<table><thead><tr><th>Paramètre</th><th>Où</th><th>Type</th></tr></thead><tbody>${paramRows}</tbody></table>` : ""}
${body ? `<p class="body">Corps JSON${op.requestBody.required ? "" : " (facultatif)"} : ${typeOf(body)}</p>` : ""}
<table><thead><tr><th>Statut</th><th>Signification</th><th>Réponse</th></tr></thead><tbody>${responses}</tbody></table>
</article>`;
      groups.set(group, [...(groups.get(group) ?? []), html]);
    }
  }

  const errorCodes: string[] = rest.ErrorCode?.enum ?? [];
  const restNames = Object.keys(rest).sort();
  const wsNames = Object.keys(realtime).filter((n) => !(n in rest)).sort();
  const messages = (names: string[]) => names.map((n) => `<li>${link(n)} : <code>type</code> = ${typeOf(realtime[n]?.properties?.type)}</li>`).join("");

  const nav = `<aside class="side"><nav aria-label="Sommaire">
  <p class="doc">API WNEXT</p>
  <ul>
    <li><a href="#intro">Introduction</a></li>
    <li><a href="#auth">Authentification</a></li>
    <li><a href="#erreurs">Erreurs</a></li>
    <li><a href="#ressources">Ressources</a>
      <ul>${[...groups.keys()].map((g) => `<li><a href="#grp-${esc(g)}">${esc(g)}</a></li>`).join("")}</ul>
    </li>
    <li><a href="#temps-reel">Temps réel</a></li>
    <li><a href="#schemas">Schémas</a></li>
  </ul>
</nav></aside>`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API WNEXT</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
${CSS}
</style>
</head>
<body>
<div class="layout">
${nav}
<main>
<header id="intro">
  <h1>${esc(spec.info.title)} <span class="ver">v${esc(spec.info.version)}</span></h1>
  <p class="lede">${opCount} opérations REST JSON sous <code>/api/v1</code>, plus un canal temps réel en WebSocket. Page générée par <code>npm run generate:contract</code> depuis <code>packages/contracts</code> (Zod, ADR-003) : ne pas l'éditer. La spec brute est <code>packages/contracts/openapi.json</code> ; le client TypeScript généré est <code>apps/web/src/api/client.gen.ts</code>.</p>
  <ul>
    <li>Écritures avec verrou optimiste : l'en-tête <code>If-Match</code> porte la <code>version</code> lue ; une version périmée répond 409 <code>VERSION_CONFLICT</code>, son absence 428 <code>PRECONDITION_REQUIRED</code>.</li>
    <li>Le compte vient toujours de la session (RLS PostgreSQL), jamais d'un paramètre.</li>
    <li>Les réponses ne portent jamais de texte d'interface : l'écran traduit les codes.</li>
  </ul>
</header>

<section id="auth">
  <h2>Authentification</h2>
  <ul>
    <li><b>Production</b> (<code>AUTH_MODE=oidc</code>) : <code>Authorization: Bearer &lt;JWT&gt;</code> émis par le fournisseur d'identité OIDC. L'API vérifie la signature (JWKS), l'émetteur, l'audience et l'expiration, puis relie <code>sub</code> à <code>users.idp_subject</code>. Ni mot de passe ni session côté API.</li>
    <li><b>Développement</b> (<code>AUTH_MODE=dev</code>, refusé en production) : en-têtes <code>x-dev-*</code>, sans preuve.</li>
    <li>Temps réel : un navigateur ne peut pas poser d'en-tête sur un WebSocket ; il demande un ticket à usage unique (voir <a href="#temps-reel">Temps réel</a>).</li>
  </ul>
</section>

<section id="erreurs">
  <h2>Erreurs</h2>
  <p>Toute erreur répond un ${link("ApiError")} : <code>code</code> stable, <code>params</code> (valeurs utiles à l'écran) et <code>requestId</code> (à citer dans un signalement). Codes :</p>
  <ul class="codes">${errorCodes.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul>
</section>

<section id="ressources">
  <h2>Ressources</h2>
  ${[...groups.entries()].map(([g, ops]) => `<section class="grp" id="grp-${esc(g)}"><h2 class="gh">${esc(g)}</h2>${ops.join("\n")}</section>`).join("\n")}
</section>

<section id="temps-reel">
  <h2>Temps réel</h2>
  <p>Le canal ne fait que diffuser : aucune écriture par WebSocket. Un message ne porte que des références (entité, id, version) ; le client recharge l'entité, ou ignore le message si sa copie est déjà à cette version. Source : l'outbox <code>change_log</code>. Contrat complet : <code>packages/contracts/src/realtime.ts</code> (hors spec OpenAPI).</p>
  <table><tbody>
    <tr><td>Chemin WebSocket</td><td><code>${esc(REALTIME_PATH)}</code></td></tr>
    <tr><td>Ticket d'upgrade</td><td><code>POST ${esc(REALTIME_TICKET_PATH)}</code>, puis <code>?${esc(REALTIME_TICKET_PARAM)}=…</code> ; valable ${REALTIME_TICKET_TTL_SECONDS} s, une seule connexion</td></tr>
    <tr><td>Version du protocole</td><td><code>v = ${REALTIME_PROTOCOL_VERSION}</code></td></tr>
    <tr><td>Refus à l'upgrade</td><td>401 non authentifié · 404 mauvais chemin · 429 plafond ou débit (<code>Retry-After</code> ≥ ${REALTIME_RETRY_AFTER_SECONDS} s) · 500</td></tr>
  </tbody></table>
  <p>Déroulé : le client envoie <code>subscribe</code> avec son curseur (le <code>changeCursor</code> de <code>GET /api/v1/schedule</code>, puis le dernier reçu) ; le serveur rattrape par lots <code>changes</code>, envoie <code>ready</code>, puis diffuse en direct. Un curseur trop ancien reçoit <code>resync</code> : recharger le planning et se réabonner.</p>
  <h3>Client → serveur</h3>
  <ul>${messages(Object.keys(CLIENT_MESSAGES))}</ul>
  <h3>Serveur → client</h3>
  <ul>${messages(Object.keys(SERVER_MESSAGES))}</ul>
  ${wsNames.map((n) => schemaBlock(n, realtime[n]!, `ws-${n}`)).join("\n")}
</section>

<section id="schemas">
  <h2>Schémas</h2>
  ${restNames.map((n) => schemaBlock(n, rest[n]!, `schema-${n}`)).join("\n")}
</section>
</main>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}

const CSS = `:root {
  color-scheme: light;
  --bg: #f6f7f5;
  --surface: #ffffff;
  --fg: #1d2421;
  --muted: #5c6661;
  --line: #d5dad6;
  --node: #eef1ee;
  --accent: #1b6b66;
  --get: #1f6f9a;
  --post: #1f7a4d;
  --put: #8a5a00;
  --patch: #8a5a00;
  --delete: #b3361f;
  --font-body: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
body {
  margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-body); line-height: 1.55;
  padding-block: 28px 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
main { min-width: 0; display: grid; gap: 36px; }
main > *, .grp > * { min-width: 0; }
li code, p code { overflow-wrap: anywhere; }
h1 { font-size: 1.6rem; line-height: 1.2; margin: 0 0 6px; font-weight: 600; }
h2 { font-size: 1.15rem; margin: 0 0 10px; font-weight: 600; }
h3 { font-size: .98rem; margin: 0 0 6px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0 0 8px; max-width: 78ch; }
ul { margin: 0 0 8px; padding-left: 1.1rem; display: grid; gap: 4px; }
a { color: var(--accent); }
.lede { color: var(--muted); }
.ver { font-family: var(--font-mono); font-size: .9rem; color: var(--muted); font-weight: 400; }
code { font-family: var(--font-mono); font-size: .86em; }
.grp { display: grid; gap: 14px; margin-top: 18px; }
.gh { font-family: var(--font-mono); font-size: 1rem; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.op, .schema { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px; min-width: 0; overflow-x: auto; }
.schema { margin-top: 12px; }
.verb { font-family: var(--font-mono); font-size: .76rem; font-weight: 500; padding: 2px 7px; border-radius: 3px; color: #fff; vertical-align: 1px; }
.verb.get { background: var(--get); } .verb.post { background: var(--post); } .verb.put { background: var(--put); }
.verb.patch { background: var(--patch); } .verb.delete { background: var(--delete); }
.path { font-size: .92rem; }
.opid { font-family: var(--font-mono); font-size: .76rem; color: var(--muted); }
.body { font-size: .9rem; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; margin: 6px 0 4px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: .74rem; text-transform: uppercase; letter-spacing: .05em; }
td:first-child { white-space: nowrap; }
table.nested { margin: 4px 0 0; background: var(--node); }
table.nested td { border-bottom-color: var(--surface); }
.opt { font-size: .74rem; color: var(--muted); }
.c { font-size: .76rem; color: var(--muted); }
.note { font-size: .78rem; color: var(--muted); margin: 2px 0 0; }
.st { font-family: var(--font-mono); font-size: .8rem; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--line); }
.st.s2 { color: var(--post); border-color: var(--post); }
.st.s4, .st.s5 { color: var(--delete); border-color: var(--delete); }
.codes { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); list-style: none; padding: 0; }

/* Sommaire latéral, thème clair uniquement */
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 36px; max-width: 1260px; margin: 0 auto; align-items: start; }
.side { position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow-y: auto; font-size: .88rem; border-right: 1px solid var(--line); padding-right: 16px; }
.side .doc { font-weight: 650; margin: 0 0 10px; line-height: 1.3; }
.side ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.side ul ul { margin: 2px 0 6px 12px; }
.side a { display: block; padding: 4px 8px; border-radius: 3px; color: var(--muted); text-decoration: none; }
.side a:hover { color: var(--fg); background: var(--node); }
.side a.on { color: var(--accent); background: var(--node); font-weight: 600; }
.side a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
html { scroll-behavior: smooth; scroll-padding-top: 16px; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
@media (max-width: 880px) {
  .layout { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .side { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); padding: 0 0 12px; }
  .side ul { display: flex; flex-wrap: wrap; gap: 4px 8px; }
  .side ul ul { margin: 0; display: contents; }
}`;

const SCRIPT = `(function () {
  var links = [].slice.call(document.querySelectorAll('.side a[href^="#"]'));
  var map = {};
  links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var targets = Object.keys(map).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) { links.forEach(function (l) { l.classList.remove('on'); }); map[e.target.id].classList.add('on'); }
    });
  }, { rootMargin: '0px 0px -70% 0px' });
  targets.forEach(function (t) { io.observe(t); });
})();`;
