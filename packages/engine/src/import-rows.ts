// Import CSV simple (US-1.2), étape 1 : texte -> lignes normalisées + erreurs par ligne. Pur, partagé par l'API et l'écran.
// Contrat (formats, colonnes, codes) : @wnext/contracts imports.ts. Étape 2 (contre les données existantes) : import-plan.ts.
//  * En-têtes tolérants : casse, accents, espaces et ponctuation ignorés (« E-mail » = « email », « Département » = « department »),
//    alias anglais et français par type d'import. Colonne inconnue : ignorée et listée. Deux en-têtes pour le même champ :
//    duplicate_column ; colonne requise absente : missing_column. Ces erreurs de fichier (ligne 1) rendent toutes les lignes invalides.
//  * Ligne dont toutes les cellules sont vides (« ;;; » d'un tableur) : ignorée, comme une ligne vide.
//  * Cellule vide = valeur absente (un import n'efface jamais) ; requise et vide : required. Valeurs rognées.
//  * Clé (e-mail sans casse, project_code exact, nom de client sans casse) répétée dans le fichier : duplicate_in_file sur la
//    seconde ligne (params.firstLine), la première est gardée.
import { parseCsv, type CsvDelimiter } from "./csv";

export type ImportKind = "people" | "projects" | "clients";
/** Miroir de ImportRowErrorCode (@wnext/contracts) ; l'égalité est vérifiée à la compilation côté API. */
export type ImportErrorCode =
  | "empty_file" | "missing_column" | "duplicate_column" | "unterminated_quote" | "field_count"
  | "required" | "too_long" | "invalid_email" | "invalid_number" | "invalid_enum" | "invalid_date" | "invalid_date_range" | "invalid_color"
  | "invalid_country" | "invalid_boolean" | "too_many_tags"
  | "duplicate_in_file" | "ambiguous_key" | "unknown_reference" | "ambiguous_reference" | "history_locked";
export interface ImportError { line: number; column: string | null; code: ImportErrorCode; value: string | null; params: Record<string, string | number> }

export type PeopleType = "employee" | "contractor" | "placeholder";
export type ProjectStatus = "tentative" | "planned" | "in_progress" | "on_hold" | "completed" | "archived";
export interface PersonRow { name: string; email: string; peopleType?: PeopleType; department?: string; role?: string; country?: string; hoursPerDay?: number; tags?: string[] }
export interface ProjectRow {
  name: string; projectCode: string; client?: string; color?: string; startDate?: string; endDate?: string; status?: ProjectStatus;
  projectManager?: string; nonBillable?: boolean; tags?: string[]; notes?: string;
}
export interface ClientRow { name: string; shortName?: string; tags?: string[] }
export interface RowsOf { people: PersonRow; projects: ProjectRow; clients: ClientRow }

export interface ImportAnalysis<K extends ImportKind = ImportKind> {
  kind: K;
  delimiter: CsvDelimiter;
  /** Lignes de données lues (hors en-têtes et lignes vides), enregistrement non fermé compris. */
  rows: number;
  /** Lignes sans erreur, dans l'ordre du fichier. */
  valid: Array<{ line: number; values: RowsOf[K] }>;
  errors: ImportError[];
  ignoredColumns: string[];
  /** Erreur de fichier : aucune ligne n'est exploitable. */
  fatal: boolean;
}

const VALUE_MAX = 200;
const clip = (v: string) => (v.length > VALUE_MAX ? v.slice(0, VALUE_MAX) : v);
export const normalizeHeader = (h: string) => h.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** Clé de comparaison des noms (références, clients) : rognée, sans casse. */
export const nameKey = (s: string) => s.trim().toLowerCase();

type Parsed = { ok: true; value: unknown } | { ok: false; code: ImportErrorCode; params?: Record<string, string | number> };
const ok = (value: unknown): Parsed => ({ ok: true, value });
const ko = (code: ImportErrorCode, params?: Record<string, string | number>): Parsed => ({ ok: false, code, ...(params && { params }) });

const text = (max: number) => (v: string): Parsed => (v.length > max ? ko("too_long", { max }) : ok(v));
const email = (v: string): Parsed => (v.length > 254 ? ko("too_long", { max: 254 }) : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? ok(v.toLowerCase()) : ko("invalid_email"));
const choice = (table: Record<string, string>) => (v: string): Parsed => {
  const hit = table[normalizeHeader(v)];
  return hit === undefined ? ko("invalid_enum") : ok(hit);
};
const hours = (v: string): Parsed => {
  const s = v.replace(",", ".");
  const n = Number(s);
  return /^\d+(\.\d+)?$/.test(s) && n <= 24 ? ok(n) : ko("invalid_number", { min: 0, max: 24 });
};
const date = (v: string): Parsed => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) return ko("invalid_date");
  const [y, mo, d] = v.includes("-") ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? ok(iso) : ko("invalid_date");
};
const color = (v: string): Parsed => (/^#?[0-9a-f]{6}$/i.test(v) ? ok(`#${v.replace("#", "").toUpperCase()}`) : ko("invalid_color"));
const country = (v: string): Parsed => (/^[a-z]{2}$/i.test(v) ? ok(v.toUpperCase()) : ko("invalid_country"));
const BOOLEANS: Record<string, boolean> = { yes: true, oui: true, true: true, vrai: true, y: true, o: true, 1: true, no: false, non: false, false: false, faux: false, n: false, 0: false };
const bool = (v: string): Parsed => {
  const b = BOOLEANS[normalizeHeader(v)];
  return b === undefined ? ko("invalid_boolean") : ok(b);
};
const tags = (v: string): Parsed => {
  const list = [...new Set(v.split(/[|,;]/).map((t) => t.trim()).filter((t) => t !== ""))];
  if (list.some((t) => t.length > 50)) return ko("too_long", { max: 50 });
  return list.length > 50 ? ko("too_many_tags", { max: 50 }) : ok(list);
};

const PEOPLE_TYPES: Record<string, PeopleType> = {
  employee: "employee", employe: "employee", salarie: "employee", staff: "employee", interne: "employee",
  contractor: "contractor", prestataire: "contractor", freelance: "contractor", contractuel: "contractor", externe: "contractor",
  placeholder: "placeholder", fictif: "placeholder", aplacer: "placeholder", tbd: "placeholder",
};
const STATUSES: Record<string, ProjectStatus> = {
  tentative: "tentative", tentatif: "tentative", provisoire: "tentative",
  planned: "planned", planifie: "planned", prevu: "planned",
  inprogress: "in_progress", encours: "in_progress", active: "in_progress", actif: "in_progress",
  onhold: "on_hold", enpause: "on_hold", suspendu: "on_hold", paused: "on_hold",
  completed: "completed", termine: "completed", done: "completed", complete: "completed",
  archived: "archived", archive: "archived",
};

interface Field { column: string; prop: string; aliases: string[]; parse(v: string): Parsed; required?: boolean }
const f = (column: string, prop: string, aliases: string[], parse: Field["parse"], required = false): Field => ({ column, prop, aliases, parse, required });
const TAGS = f("tags", "tags", ["tags", "tag", "etiquettes", "etiquette", "labels"], tags);

export const IMPORT_FIELDS: Record<ImportKind, Field[]> = {
  people: [
    f("name", "name", ["name", "nom", "fullname", "nomcomplet", "personne", "person"], text(200), true),
    f("email", "email", ["email", "mail", "courriel", "emailaddress", "adresseemail", "adressemail"], email, true),
    f("type", "peopleType", ["type", "peopletype", "persontype", "typedepersonne"], choice(PEOPLE_TYPES)),
    f("department", "department", ["department", "departement", "dept", "service"], text(200)),
    f("role", "role", ["role", "jobtitle", "poste", "fonction"], text(200)),
    f("country", "country", ["country", "pays", "countrycode", "codepays"], country),
    f("hours_per_day", "hoursPerDay", ["hoursperday", "heuresparjour", "heuresjour", "dailyhours", "workhours", "heures", "hours"], hours),
    TAGS,
  ],
  projects: [
    f("name", "name", ["name", "nom", "projectname", "nomduprojet", "projet", "project"], text(200), true),
    f("project_code", "projectCode", ["projectcode", "codeprojet", "codeduprojet", "code", "reference", "ref"], text(100), true),
    f("client", "client", ["client", "clientname", "nomduclient", "customer"], text(200)),
    f("color", "color", ["color", "colour", "couleur"], color),
    f("start_date", "startDate", ["startdate", "start", "debut", "datededebut", "datedebut"], date),
    f("end_date", "endDate", ["enddate", "end", "fin", "datedefin", "datefin"], date),
    f("status", "status", ["status", "statut", "etat"], choice(STATUSES)),
    f("project_manager", "projectManager", ["projectmanager", "manager", "chefdeprojet", "responsable", "pm"], text(254)),
    { ...f("billable", "nonBillable", ["billable", "facturable"], bool), parse: (v) => { const p = bool(v); return p.ok ? ok(!p.value) : p; } },
    TAGS,
    f("notes", "notes", ["notes", "note", "description", "commentaire", "commentaires", "comment"], text(5000)),
  ],
  clients: [
    f("name", "name", ["name", "nom", "client", "clientname", "nomduclient", "customer", "raisonsociale"], text(200), true),
    f("short_name", "shortName", ["shortname", "nomcourt", "abbreviation", "abreviation", "sigle"], text(50)),
    TAGS,
  ],
};

const KEY: { [K in ImportKind]: { column: string; of(v: RowsOf[K]): string } } = {
  people: { column: "email", of: (v) => v.email },
  projects: { column: "project_code", of: (v) => v.projectCode },
  clients: { column: "name", of: (v) => nameKey(v.name) },
};

export function analyzeImport<K extends ImportKind>(kind: K, csv: string): ImportAnalysis<K> {
  const parsed = parseCsv(csv);
  const [header, ...rest] = parsed.records;
  const data = rest.filter((r) => r.fields.some((v) => v.trim() !== "")); // « ;;; » : ligne vide exportée par un tableur
  const rows = data.length + (parsed.unterminatedAt !== null && header ? 1 : 0);
  const base = { kind, delimiter: parsed.delimiter, rows, valid: [] as ImportAnalysis<K>["valid"], ignoredColumns: [] as string[] };
  const errors: ImportError[] = [];
  const err = (line: number, column: string | null, code: ImportErrorCode, value: string | null, params: Record<string, string | number> = {}) =>
    errors.push({ line, column, code, value: value === null ? null : clip(value), params });

  if (!header) return { ...base, errors: [{ line: 1, column: null, code: parsed.unterminatedAt === null ? "empty_file" : "unterminated_quote", value: null, params: {} }], fatal: true };

  // En-têtes -> champs.
  const fields = IMPORT_FIELDS[kind];
  const byAlias = new Map(fields.flatMap((fd) => fd.aliases.map((a) => [a, fd] as const)));
  const columns: Array<Field | null> = [];
  const seen = new Set<Field>();
  for (const h of header.fields) {
    const fd = byAlias.get(normalizeHeader(h));
    if (!fd) { if (h.trim() !== "") base.ignoredColumns.push(h); columns.push(null); continue; }
    if (seen.has(fd)) err(1, fd.column, "duplicate_column", h);
    seen.add(fd);
    columns.push(fd);
  }
  for (const fd of fields) if (fd.required && !seen.has(fd)) err(1, fd.column, "missing_column", null);
  if (errors.length) return { ...base, errors, fatal: true };

  const firstLine = new Map<string, number>();
  for (const rec of data) {
    const before = errors.length;
    const values: Record<string, unknown> = {};
    const extra = rec.fields.slice(columns.length).some((v) => v.trim() !== "");
    if (extra) err(rec.line, null, "field_count", null, { expected: columns.length, found: rec.fields.length });
    columns.forEach((fd, i) => {
      if (!fd) return;
      const raw = (rec.fields[i] ?? "").trim();
      if (raw === "") { if (fd.required) err(rec.line, fd.column, "required", null); return; }
      const p = fd.parse(raw);
      if (p.ok) values[fd.prop] = p.value;
      else err(rec.line, fd.column, p.code, raw, p.params);
    });
    if (errors.length > before) continue;
    const row = values as unknown as RowsOf[K];
    const key = KEY[kind] as { column: string; of(v: RowsOf[K]): string };
    const k = key.of(row);
    const first = firstLine.get(k);
    if (first !== undefined) { err(rec.line, key.column, "duplicate_in_file", k, { firstLine: first }); continue; }
    firstLine.set(k, rec.line);
    base.valid.push({ line: rec.line, values: row });
  }
  if (parsed.unterminatedAt !== null) err(parsed.unterminatedAt, null, "unterminated_quote", null);
  return { ...base, errors, fatal: false };
}
