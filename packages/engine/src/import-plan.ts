// Import CSV simple (US-1.2), étape 2 : lignes analysées (import-rows.ts) + état existant du compte -> plan d'écritures et
// rapport. Pur : l'API charge l'état dans sa transaction puis exécute le plan ; la démo fait de même sur ses données locales.
//  * Clé existante -> mise à jour des seuls champs fournis qui DIFFÈRENT ; aucun -> inchangée (pas d'écriture) : réimporter
//    le même fichier donne 0 création et 0 mise à jour. L'e-mail (clé, sans casse) et le nom d'un client (clé) ne sont pas réécrits.
//  * Références par nom (rognées, sans casse ; une correspondance exacte l'emporte) : département, rôle et client absents sont à
//    créer (une seule fois par nom, première graphie du fichier) ; plusieurs candidats : ambiguous_reference. Chef de projet : par
//    e-mail (contient « @ ») ou par nom, jamais créé : unknown_reference / ambiguous_reference.
//  * Personne : hours_per_day = lundi à vendredi, week-end à 0. Changer horaire, département ou rôle d'une personne dont des
//    temps saisis non brouillons couvrent aujourd'hui ou après : history_locked (BR-12, BR-19 ; la date d'effet est aujourd'hui).
//  * Projet : la fin ne précède pas le début, valeurs existantes comprises (invalid_date_range sur end_date).
//  * Les références à créer ne viennent que des lignes valides qui écrivent.
import type { ImportAnalysis, ImportError, ImportKind, PeopleType, ProjectStatus } from "./import-rows";
import { nameKey } from "./import-rows";

export interface NamedRef { id: string; name: string }
export interface ExistingPerson {
  id: string; name: string; email: string | null; peopleType: PeopleType; departmentId: string | null; roleId: string | null;
  country: string | null; workDaysHours: number[]; tags: string[];
  /** Dernier jour couvert par un temps saisi non brouillon (BR-12), ou null. */
  lockedThrough: string | null;
}
export interface ExistingProject {
  id: string; name: string; projectCode: string | null; clientId: string | null; color: string; startDate: string | null; endDate: string | null;
  status: ProjectStatus; projectManagerId: string | null; nonBillable: boolean; tags: string[]; notes: string | null;
}
export interface ExistingClient { id: string; name: string; shortName: string | null; tags: string[] }
export interface ImportSnapshot {
  /** Aujourd'hui dans le fuseau du compte (date d'effet de l'historique). */
  today: string;
  departments: NamedRef[]; roles: NamedRef[]; clients: ExistingClient[]; people: ExistingPerson[]; projects: ExistingProject[];
}

/** Référence résolue : entité existante, ou nom à créer. */
export type RefValue = { id: string } | { create: string };
export interface PersonWrite { name?: string; email?: string; peopleType?: PeopleType; department?: RefValue; role?: RefValue; country?: string; workDaysHours?: number[]; tags?: string[] }
export interface ProjectWrite {
  name?: string; projectCode?: string; client?: RefValue; color?: string; startDate?: string; endDate?: string; status?: ProjectStatus;
  projectManagerId?: string; nonBillable?: boolean; tags?: string[]; notes?: string;
}
export interface ClientWrite { name?: string; shortName?: string; tags?: string[] }
export interface WritesOf { people: PersonWrite; projects: ProjectWrite; clients: ClientWrite }

export interface ImportPlan<K extends ImportKind = ImportKind> {
  kind: K;
  delimiter: "," | ";";
  rows: number;
  creates: Array<{ line: number; values: WritesOf[K] }>;
  updates: Array<{ line: number; id: string; changes: WritesOf[K] }>;
  unchanged: number;
  invalid: number;
  references: { departments: string[]; roles: string[]; clients: string[] };
  ignoredColumns: string[];
  errors: ImportError[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;

/** Résolution par nom : exacte (rognée) d'abord, sinon sans casse ; aucune -> à créer ; plusieurs -> ambiguë. */
function resolver(existing: readonly NamedRef[]) {
  const byKey = new Map<string, NamedRef[]>();
  for (const r of existing) byKey.set(nameKey(r.name), [...(byKey.get(nameKey(r.name)) ?? []), r]);
  return (name: string): RefValue | "ambiguous" => {
    const all = byKey.get(nameKey(name)) ?? [];
    const exact = all.filter((r) => r.name.trim() === name);
    const hit = exact.length === 1 ? exact : all;
    if (hit.length === 0) return { create: name };
    return hit.length === 1 ? { id: hit[0]!.id } : "ambiguous";
  };
}
const changed = (ref: RefValue, current: string | null) => !("id" in ref) || ref.id !== current;

export function planImport<K extends ImportKind>(analysis: ImportAnalysis<K>, snap: ImportSnapshot): ImportPlan<K> {
  const errors = [...analysis.errors];
  const plan: ImportPlan = {
    kind: analysis.kind, delimiter: analysis.delimiter, rows: analysis.rows, creates: [], updates: [], unchanged: 0, invalid: 0,
    references: { departments: [], roles: [], clients: [] }, ignoredColumns: analysis.ignoredColumns, errors,
  };
  const toCreate = { departments: new Map<string, string>(), roles: new Map<string, string>(), clients: new Map<string, string>() };
  const err = (line: number, column: string, code: ImportError["code"], value: string, params: ImportError["params"] = {}) =>
    errors.push({ line, column, code, value, params });
  /** Enregistre la ligne : création, mise à jour (si un champ change) ou inchangée ; note les références à créer. */
  const emit = (line: number, id: string | null, w: Record<string, unknown>, refs: Array<[keyof typeof toCreate, RefValue | undefined]>) => {
    if (id === null) plan.creates.push({ line, values: w });
    else if (Object.keys(w).length) plan.updates.push({ line, id, changes: w });
    else { plan.unchanged++; return; }
    for (const [kind, ref] of refs) if (ref && "create" in ref && !toCreate[kind].has(nameKey(ref.create))) toCreate[kind].set(nameKey(ref.create), ref.create);
  };
  const ref = (resolve: ReturnType<typeof resolver>, line: number, column: string, name: string | undefined): RefValue | undefined | null => {
    if (name === undefined) return undefined;
    const r = resolve(name);
    if (r !== "ambiguous") return r;
    err(line, column, "ambiguous_reference", name);
    return null;
  };

  if (analysis.kind === "people") {
    const department = resolver(snap.departments);
    const role = resolver(snap.roles);
    const byEmail = new Map(snap.people.filter((p) => p.email !== null).map((p) => [p.email!.toLowerCase(), p]));
    for (const { line, values: v } of (analysis as ImportAnalysis<"people">).valid) {
      const dep = ref(department, line, "department", v.department);
      const rol = ref(role, line, "role", v.role);
      if (dep === null || rol === null) continue;
      const wdh = v.hoursPerDay === undefined ? undefined : [v.hoursPerDay, v.hoursPerDay, v.hoursPerDay, v.hoursPerDay, v.hoursPerDay, 0, 0];
      const cur = byEmail.get(v.email);
      const w: PersonWrite = {};
      if (!cur) {
        Object.assign(w, { name: v.name, email: v.email }, v.peopleType && { peopleType: v.peopleType }, dep && { department: dep }, rol && { role: rol },
          v.country && { country: v.country }, wdh && { workDaysHours: wdh }, v.tags && { tags: v.tags });
      } else {
        if (v.name !== cur.name) w.name = v.name;
        if (v.peopleType && v.peopleType !== cur.peopleType) w.peopleType = v.peopleType;
        if (dep && changed(dep, cur.departmentId)) w.department = dep;
        if (rol && changed(rol, cur.roleId)) w.role = rol;
        if (v.country && v.country !== cur.country) w.country = v.country;
        if (wdh && wdh.some((h, i) => h !== cur.workDaysHours[i])) w.workDaysHours = wdh;
        if (v.tags && !sameSet(v.tags, cur.tags)) w.tags = v.tags;
        const historized = w.department ? "department" : w.role ? "role" : w.workDaysHours ? "hours_per_day" : null;
        if (historized && cur.lockedThrough !== null && cur.lockedThrough >= snap.today) {
          err(line, historized, "history_locked", v.email, { lockedThrough: cur.lockedThrough });
          continue;
        }
      }
      emit(line, cur?.id ?? null, w as Record<string, unknown>, [["departments", w.department], ["roles", w.role]]);
    }
  } else if (analysis.kind === "projects") {
    const client = resolver(snap.clients);
    const byCode = new Map(snap.projects.filter((p) => p.projectCode !== null).map((p) => [p.projectCode!, p]));
    const byEmail = new Map(snap.people.filter((p) => p.email !== null).map((p) => [p.email!.toLowerCase(), p.id]));
    const byName = new Map<string, string[]>();
    for (const p of snap.people) byName.set(nameKey(p.name), [...(byName.get(nameKey(p.name)) ?? []), p.id]);
    for (const { line, values: v } of (analysis as ImportAnalysis<"projects">).valid) {
      const cli = ref(client, line, "client", v.client);
      let manager: string | undefined;
      if (v.projectManager !== undefined) {
        const ids = v.projectManager.includes("@") ? [byEmail.get(v.projectManager.toLowerCase())].filter((x) => x !== undefined) : byName.get(nameKey(v.projectManager)) ?? [];
        if (ids.length !== 1) err(line, "project_manager", ids.length ? "ambiguous_reference" : "unknown_reference", v.projectManager);
        else manager = ids[0];
      }
      if (cli === null || (v.projectManager !== undefined && manager === undefined)) continue;
      const cur = byCode.get(v.projectCode);
      const start = v.startDate ?? cur?.startDate ?? null;
      const end = v.endDate ?? cur?.endDate ?? null;
      if (start !== null && end !== null && end < start) { err(line, "end_date", "invalid_date_range", end, { startDate: start }); continue; }
      const w: ProjectWrite = {};
      if (!cur) {
        Object.assign(w, { name: v.name, projectCode: v.projectCode }, cli && { client: cli }, v.color && { color: v.color }, v.startDate && { startDate: v.startDate },
          v.endDate && { endDate: v.endDate }, v.status && { status: v.status }, manager && { projectManagerId: manager },
          v.nonBillable !== undefined && { nonBillable: v.nonBillable }, v.tags && { tags: v.tags }, v.notes && { notes: v.notes });
      } else {
        if (v.name !== cur.name) w.name = v.name;
        if (cli && changed(cli, cur.clientId)) w.client = cli;
        if (v.color && v.color !== cur.color.toUpperCase()) w.color = v.color;
        if (v.startDate && v.startDate !== cur.startDate) w.startDate = v.startDate;
        if (v.endDate && v.endDate !== cur.endDate) w.endDate = v.endDate;
        if (v.status && v.status !== cur.status) w.status = v.status;
        if (manager && manager !== cur.projectManagerId) w.projectManagerId = manager;
        if (v.nonBillable !== undefined && v.nonBillable !== cur.nonBillable) w.nonBillable = v.nonBillable;
        if (v.tags && !sameSet(v.tags, cur.tags)) w.tags = v.tags;
        if (v.notes && v.notes !== cur.notes) w.notes = v.notes;
      }
      emit(line, cur?.id ?? null, w as Record<string, unknown>, [["clients", w.client]]);
    }
  } else {
    const byKey = new Map<string, ExistingClient[]>();
    for (const c of snap.clients) byKey.set(nameKey(c.name), [...(byKey.get(nameKey(c.name)) ?? []), c]);
    for (const { line, values: v } of (analysis as ImportAnalysis<"clients">).valid) {
      const found = byKey.get(nameKey(v.name)) ?? [];
      if (found.length > 1) { err(line, "name", "ambiguous_key", v.name); continue; }
      const cur = found[0];
      const w: ClientWrite = {};
      if (!cur) Object.assign(w, { name: v.name }, v.shortName && { shortName: v.shortName }, v.tags && { tags: v.tags });
      else {
        if (v.shortName && v.shortName !== cur.shortName) w.shortName = v.shortName;
        if (v.tags && !sameSet(v.tags, cur.tags)) w.tags = v.tags;
      }
      emit(line, cur?.id ?? null, w as Record<string, unknown>, []);
    }
  }

  errors.sort((a, b) => a.line - b.line);
  plan.invalid = analysis.fatal ? analysis.rows : new Set(errors.map((e) => e.line)).size;
  plan.references = { departments: [...toCreate.departments.values()], roles: [...toCreate.roles.values()], clients: [...toCreate.clients.values()] };
  return plan as ImportPlan<K>;
}

export interface ImportReportShape {
  kind: ImportKind; dryRun: boolean; applied: boolean; delimiter: "," | ";"; rows: number; created: number; updated: number; unchanged: number;
  invalid: number; references: ImportPlan["references"]; ignoredColumns: string[]; errors: ImportError[]; errorsTruncated: boolean;
}

/** Rapport (forme ImportReport du contrat) ; au plus `maxErrors` erreurs listées, compteurs exacts. */
export function importReport(plan: ImportPlan, opts: { dryRun: boolean; applied: boolean; maxErrors: number }): ImportReportShape {
  return {
    kind: plan.kind, dryRun: opts.dryRun, applied: opts.applied, delimiter: plan.delimiter, rows: plan.rows,
    created: plan.creates.length, updated: plan.updates.length, unchanged: plan.unchanged, invalid: plan.invalid,
    references: plan.references, ignoredColumns: plan.ignoredColumns,
    errors: plan.errors.slice(0, opts.maxErrors), errorsTruncated: plan.errors.length > opts.maxErrors,
  };
}
