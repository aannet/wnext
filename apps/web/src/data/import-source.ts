// Import CSV simple (US-1.2) côté écran : même interface pour l'API et pour la démo (?demo=1, sans réseau).
//  * API : POST /imports/{kind} (client généré) ; les erreurs gardent leur code stable, l'écran les traduit.
//  * Démo : même analyse et même plan (@wnext/engine) contre un état local tiré des données de démonstration ; les
//    règles du serveur sont reprises (5 000 lignes au plus, tout ou rien sans skipInvalid, ré-import idempotent).
import { IMPORT_MAX_ERRORS, IMPORT_MAX_ROWS, type ImportKind, type ImportReport, type ScheduleResponse } from "@wnext/contracts";
import { analyzeImport, importReport, nameKey, planImport, type ExistingPerson, type ExistingProject, type ImportPlan, type ImportSnapshot, type RefValue } from "@wnext/engine";
import type { createClient } from "../api/client.gen";

export type ImportFailure = "IMPORT_HAS_ERRORS" | "IMPORT_TOO_LARGE" | "FORBIDDEN" | "VALIDATION_FAILED" | "NETWORK" | "OTHER";
export type ImportOutcome = { ok: true; report: ImportReport } | { ok: false; error: ImportFailure; params: Record<string, string | number | boolean> };
export interface ImportSource {
  run(kind: ImportKind, csv: string, opts: { dryRun: boolean; skipInvalid?: boolean }): Promise<ImportOutcome>;
}

const KNOWN = new Set<string>(["IMPORT_HAS_ERRORS", "IMPORT_TOO_LARGE", "FORBIDDEN", "VALIDATION_FAILED"]);

export function createApiImportSource(api: Pick<ReturnType<typeof createClient>, "runImport">): ImportSource {
  return {
    async run(kind, csv, { dryRun, skipInvalid }) {
      try {
        const r = await api.runImport({ path: { kind }, ...(dryRun && { query: { dryRun: true } }), body: { csv, ...(skipInvalid && { skipInvalid: true }) } });
        if (r.ok) return { ok: true, report: r.data };
        return { ok: false, error: KNOWN.has(r.error.code) ? (r.error.code as ImportFailure) : "OTHER", params: r.error.params };
      } catch {
        return { ok: false, error: "NETWORK", params: {} };
      }
    },
  };
}

/** État d'import tiré du Schedule de démonstration (aucun e-mail ni client en démo : tout import de personnes ou de clients crée). */
export function demoImportSnapshot(data: ScheduleResponse, today: string): ImportSnapshot {
  return {
    today,
    departments: data.departments.map((d) => ({ id: d.id, name: d.name })),
    roles: data.roles.map((r) => ({ id: r.id, name: r.name })),
    clients: [],
    people: data.people.map((p) => ({
      id: p.id, name: p.name, email: null, peopleType: p.peopleType, departmentId: p.departmentId, roleId: p.roleId, country: p.country,
      workDaysHours: p.workDaysHours, tags: p.tags, lockedThrough: null,
    })),
    projects: data.projects.map((p) => ({
      id: p.id, name: p.name, projectCode: p.projectCode, clientId: null, color: p.color, startDate: p.startDate, endDate: p.endDate,
      status: p.status, projectManagerId: null, nonBillable: p.nonBillable, tags: [], notes: null,
    })),
  };
}

/** Applique un plan à l'état local (ce que fait l'API en base) : les ré-imports suivants le voient. */
function applyLocal(snap: ImportSnapshot, plan: ImportPlan, newId: () => string): ImportSnapshot {
  const next: ImportSnapshot = { ...snap, departments: [...snap.departments], roles: [...snap.roles], clients: [...snap.clients], people: [...snap.people], projects: [...snap.projects] };
  const created = { departments: new Map<string, string>(), roles: new Map<string, string>(), clients: new Map<string, string>() };
  for (const kind of ["departments", "roles", "clients"] as const) {
    for (const name of plan.references[kind]) {
      const id = newId();
      created[kind].set(nameKey(name), id);
      if (kind === "clients") next.clients.push({ id, name, shortName: null, tags: [] });
      else next[kind].push({ id, name });
    }
  }
  const ref = (r: RefValue | undefined, kind: keyof typeof created) => (r === undefined ? undefined : "id" in r ? r.id : created[kind].get(nameKey(r.create))!);
  const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  const upsert = <T extends { id: string }>(list: T[], id: string | null, values: Partial<T>, fresh: () => T) => {
    const i = id === null ? -1 : list.findIndex((x) => x.id === id);
    if (i < 0) list.push({ ...fresh(), ...values });
    else list[i] = { ...list[i]!, ...values };
  };
  const rows = [...plan.creates.map((c) => ({ id: null as string | null, w: c.values })), ...plan.updates.map((u) => ({ id: u.id as string | null, w: u.changes }))];
  for (const { id, w } of rows) {
    if (plan.kind === "people") {
      const { department, role, ...rest } = w as ImportPlan<"people">["creates"][number]["values"];
      upsert(next.people, id, defined({ ...rest, departmentId: ref(department, "departments"), roleId: ref(role, "roles") }), (): ExistingPerson => ({
        id: newId(), name: "", email: null, peopleType: "employee", departmentId: null, roleId: null, country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], lockedThrough: null,
      }));
    } else if (plan.kind === "projects") {
      const { client, ...rest } = w as ImportPlan<"projects">["creates"][number]["values"];
      upsert(next.projects, id, defined({ ...rest, clientId: ref(client, "clients") }), (): ExistingProject => ({
        id: newId(), name: "", projectCode: null, clientId: null, color: "#3B82F6", startDate: null, endDate: null, status: "planned", projectManagerId: null,
        nonBillable: false, tags: [], notes: null,
      }));
    } else {
      upsert(next.clients, id, defined(w as ImportPlan<"clients">["creates"][number]["values"]), () => ({ id: newId(), name: "", shortName: null, tags: [] }));
    }
  }
  return next;
}

export function createDemoImportSource(initial: ImportSnapshot): ImportSource {
  let snap = initial;
  let seq = 0;
  return {
    async run(kind, csv, { dryRun, skipInvalid }): Promise<ImportOutcome> {
      const analysis = analyzeImport(kind, csv);
      if (analysis.rows > IMPORT_MAX_ROWS) return { ok: false, error: "IMPORT_TOO_LARGE", params: { maxRows: IMPORT_MAX_ROWS, rows: analysis.rows } };
      const plan = planImport(analysis, snap);
      if (!dryRun && plan.errors.length > 0 && !skipInvalid) return { ok: false, error: "IMPORT_HAS_ERRORS", params: { invalid: plan.invalid, rows: plan.rows } };
      if (!dryRun) snap = applyLocal(snap, plan, () => `demo-import-${++seq}`);
      return { ok: true, report: importReport(plan, { dryRun, applied: !dryRun, maxErrors: IMPORT_MAX_ERRORS }) };
    },
  };
}
