// Données des écrans Personnes et Réglages (lot L-F2 : RT-012 Personnes et Réglages, US-1.1, BR-19, BR-31) : deux sources de même
// interface, comme pour le planning et les projets.
//  * createApiPeopleSource / createApiReferenceSource : branchées sur /api/v1 (client généré) ; PATCH et DELETE portent
//    If-Match = version lue, la modification datée envoie `effectiveFrom`.
//  * createDemoDirectory (?demo=1) : tout en mémoire, mêmes règles que l'API (périodes d'horaire datées, références en usage
//    refusées à la suppression, désactivation avec disposition), et chaque écriture est répercutée sur la source du planning.
// Les erreurs sont les codes stables du contrat ; l'écran les traduit. `params` porte ce que l'API précise.
import type { ApiError, PersonDeactivationRequest, PersonDeactivationSummary, PersonHistoryEntry, ScheduleResponse } from "@wnext/contracts";
import type { createClient } from "../api/client.gen";
import { errorCodeOf } from "./schedule-source";

export type DirError = { code: ApiError["code"]; params: Record<string, string | number | boolean> };
export type DirResult<T> = { ok: true; value: T } | { ok: false; error: DirError };

export type Person = ScheduleResponse["people"][number];
export type PeopleType = Person["peopleType"];
export type Department = NonNullable<ScheduleResponse["departments"]>[number];
export type Role = NonNullable<ScheduleResponse["roles"]>[number];
export type TimeoffType = NonNullable<ScheduleResponse["timeoffTypes"]>[number];
export type Holiday = NonNullable<ScheduleResponse["holidays"]>[number];
export type WorkPeriod = NonNullable<Person["workSchedule"]>[number];

export interface PersonInput {
  name: string;
  peopleType?: PeopleType;
  departmentId?: string | null;
  roleId?: string | null;
  country?: string | null;
  workDaysHours?: number[];
}
/** `effectiveFrom` : date d'effet de l'horaire, du département et du rôle (BR-19) ; défaut serveur : aujourd'hui. */
export interface PersonPatchInput extends Partial<PersonInput> { active?: boolean; effectiveFrom?: string }

export interface PeopleSource {
  /** Personnes du compte, désactivées comprises. */
  listPeople(): Promise<DirResult<Person[]>>;
  createPerson(input: PersonInput): Promise<DirResult<Person>>;
  /** If-Match = person.version. */
  updatePerson(person: Person, patch: PersonPatchInput): Promise<DirResult<Person>>;
  /** Relit une personne (après un VERSION_CONFLICT) ; null si elle n'existe plus. */
  reloadPerson(id: string): Promise<Person | null>;
  history(personId: string): Promise<DirResult<PersonHistoryEntry[]>>;
  deactivationSummary(personId: string): Promise<DirResult<PersonDeactivationSummary>>;
  /** Désactive (BR-31) ; l'erreur d'une confirmation manquante ou périmée porte le récapitulatif courant dans `params`. */
  deactivate(person: Person, request: PersonDeactivationRequest): Promise<DirResult<Person>>;
}

/** Une table de référence : liste, création, modification (If-Match), suppression (REFERENCE_IN_USE si elle sert encore). */
export interface RefStore<T extends { id: string; version: number }, C, P> {
  list(): Promise<DirResult<T[]>>;
  create(input: C): Promise<DirResult<T>>;
  update(item: T, patch: P): Promise<DirResult<T>>;
  remove(item: T): Promise<DirResult<null>>;
}
export interface HolidayInput { name: string; date: string; country: string | null; hoursOff: number | null }
export interface ReferenceSource {
  departments: RefStore<Department, { name: string }, { name: string }>;
  roles: RefStore<Role, { name: string }, { name: string }>;
  timeoffTypes: RefStore<TimeoffType, { name: string; deducted: boolean }, { name?: string; deducted?: boolean }>;
  holidays: RefStore<Holiday, HolidayInput, Partial<HolidayInput>>;
}

const fail = (code: DirError["code"], params: DirError["params"] = {}): { ok: false; error: DirError } => ({ ok: false, error: { code, params } });
const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });
const PAGE = 200;

type ApiLike = ReturnType<typeof createClient>;
type Page<T> = { items: T[]; page: { nextCursor?: string | null } };
type Raw<T> = Promise<{ ok: true; data: T } | { ok: false; status: number; error: unknown }>;

async function call<T>(run: () => Raw<T>): Promise<DirResult<T>> {
  try {
    const r = await run();
    if (r.ok) return { ok: true, value: r.data };
    const params = (r.error as { params?: DirError["params"] } | null | undefined)?.params;
    return fail(errorCodeOf(r.status, r.error), params && typeof params === "object" ? params : {});
  } catch {
    return fail("INTERNAL_ERROR");
  }
}
async function all<T>(fetchPage: (cursor?: string) => Raw<Page<T>>): Promise<DirResult<T[]>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const r = await call(() => fetchPage(cursor));
    if (!r.ok) return r;
    items.push(...r.value.items);
    cursor = r.value.page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return { ok: true, value: items };
}
const withCursor = (cursor?: string) => (cursor ? { cursor } : {});

export function createApiPeopleSource(api: ApiLike): PeopleSource {
  return {
    listPeople: () => all((c) => api.listPeople({ limit: PAGE, includeInactive: true, ...withCursor(c) })),
    createPerson: (input) => call(() => api.createPerson({ body: input })),
    updatePerson: (person, patch) => call(() => api.updatePerson({ path: { id: person.id }, headers: ifMatch(person.version), body: patch })),
    async reloadPerson(id) {
      const r = await call(() => api.getPerson({ path: { id } }));
      return r.ok ? r.value : null;
    },
    history: (personId) => all((c) => api.listPersonHistory({ path: { id: personId }, query: { limit: PAGE, ...withCursor(c) } })),
    deactivationSummary: (personId) => call(() => api.getPersonDeactivationSummary({ path: { id: personId } })),
    async deactivate(person, request) {
      const r = await call(() => api.deactivatePerson({ path: { id: person.id }, body: request }));
      return r.ok ? { ok: true, value: r.value.person } : r;
    },
  };
}

export function createApiReferenceSource(api: ApiLike): ReferenceSource {
  const none = async (r: Promise<DirResult<unknown>>): Promise<DirResult<null>> => { const x = await r; return x.ok ? { ok: true, value: null } : x; };
  return {
    departments: {
      list: () => all((c) => api.listDepartments({ limit: PAGE, ...withCursor(c) })),
      create: (body) => call(() => api.createDepartment({ body })),
      update: (d, body) => call(() => api.updateDepartment({ path: { id: d.id }, headers: ifMatch(d.version), body })),
      remove: (d) => none(call(() => api.deleteDepartment({ path: { id: d.id }, headers: ifMatch(d.version) }))),
    },
    roles: {
      list: () => all((c) => api.listRoles({ limit: PAGE, ...withCursor(c) })),
      create: (body) => call(() => api.createRole({ body })),
      update: (r, body) => call(() => api.updateRole({ path: { id: r.id }, headers: ifMatch(r.version), body })),
      remove: (r) => none(call(() => api.deleteRole({ path: { id: r.id }, headers: ifMatch(r.version) }))),
    },
    timeoffTypes: {
      list: () => all((c) => api.listTimeoffTypes({ limit: PAGE, ...withCursor(c) })),
      create: (body) => call(() => api.createTimeoffType({ body })),
      update: (x, body) => call(() => api.updateTimeoffType({ path: { id: x.id }, headers: ifMatch(x.version), body })),
      remove: (x) => none(call(() => api.deleteTimeoffType({ path: { id: x.id }, headers: ifMatch(x.version) }))),
    },
    holidays: {
      list: () => all((c) => api.listHolidays({ limit: PAGE, ...withCursor(c) })),
      create: (body) => call(() => api.createHoliday({ body })),
      update: (h, body) => call(() => api.updateHoliday({ path: { id: h.id }, headers: ifMatch(h.version), body })),
      remove: (h) => none(call(() => api.deleteHoliday({ path: { id: h.id }, headers: ifMatch(h.version) }))),
    },
  };
}

// --- Démo --------------------------------------------------------------------------------------------------------------
type Kind = "people" | "departments" | "roles" | "timeoff_types" | "holidays";
export interface DemoDirectoryHooks {
  /** Une entité a été créée ou modifiée : la source du planning de la démo l'applique (nouvelle personne, horaire, équipe...). */
  onEntity(kind: Kind, entity: { id: string; version: number }): void;
  onRemoved(kind: Kind, id: string): void;
  /** Une personne est désactivée : ses allocations futures sont réaffectées ou supprimées (BR-31) dans la source du planning. */
  onDeactivated(personId: string, asOf: string, disposition: "reassign" | "delete" | undefined, replacementId: string | undefined): void;
  /** Date du jour (fuseau du compte), défaut d'une modification datée. */
  today: string;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const sameHours = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((h, i) => h === b[i]);

export function createDemoDirectory(schedule: ScheduleResponse, hooks: DemoDirectoryHooks): { people: PeopleSource; reference: ReferenceSource } {
  let seq = 0;
  const nextId = () => `demo-${++seq}`;
  const ok = <T,>(value: T): DirResult<T> => ({ ok: true, value });
  const people: Person[] = schedule.people.map((p) => ({ ...p }));
  const departments: Department[] = (schedule.departments ?? []).map((d) => ({ ...d }));
  const roles: Role[] = (schedule.roles ?? []).map((d) => ({ ...d }));
  const timeoffTypes: TimeoffType[] = (schedule.timeoffTypes ?? []).map((d) => ({ ...d }));
  const holidays: Holiday[] = (schedule.holidays ?? []).map((d) => ({ ...d }));
  // Périodes d'horaire datées par personne (BR-19) : la dernière court sans fin.
  const periods = new Map<string, WorkPeriod[]>();
  const periodsOf = (p: Person): WorkPeriod[] => periods.get(p.id) ?? [{ validFrom: null, validTo: null, workDaysHours: p.workDaysHours }];
  for (const p of people) if (p.workSchedule) periods.set(p.id, p.workSchedule.map((w) => ({ ...w })));
  const find = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id);
  const stale = (cur: { version: number }, given: { version: number }) => (cur.version !== given.version ? fail("VERSION_CONFLICT", { currentVersion: cur.version }) : null);

  function store<T extends { id: string; version: number; name: string }, C extends { name: string }, P extends Partial<C>>(
    list: T[], kind: Kind, entity: string, make: (id: string, input: C) => T, inUse: (id: string) => number,
  ): RefStore<T, C, P> {
    const clash = (name: string, selfId: string | null) => list.some((x) => x.id !== selfId && x.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    return {
      list: async () => ok(list.map((x) => ({ ...x }))),
      async create(input) {
        if (!input.name.trim()) return fail("VALIDATION_FAILED", { field: "name" });
        if (clash(input.name, null)) return fail("ALREADY_EXISTS", { entity, field: "name" });
        const item = make(nextId(), { ...input, name: input.name.trim() });
        list.push(item);
        hooks.onEntity(kind, item);
        return ok({ ...item });
      },
      async update(item, patch) {
        const cur = find(list, item.id);
        if (!cur) return fail("NOT_FOUND", { entity });
        const bad = stale(cur, item);
        if (bad) return bad;
        const name = typeof patch.name === "string" ? patch.name.trim() : cur.name;
        if (!name) return fail("VALIDATION_FAILED", { field: "name" });
        if (clash(name, cur.id)) return fail("ALREADY_EXISTS", { entity, field: "name" });
        Object.assign(cur, patch, { name, version: cur.version + 1 });
        hooks.onEntity(kind, cur);
        return ok({ ...cur });
      },
      async remove(item) {
        const cur = find(list, item.id);
        if (!cur) return fail("NOT_FOUND", { entity });
        const bad = stale(cur, item);
        if (bad) return bad;
        const used = inUse(cur.id);
        if (used > 0) return fail("REFERENCE_IN_USE", { entity, people: used });
        list.splice(list.indexOf(cur), 1);
        hooks.onRemoved(kind, cur.id);
        return ok(null);
      },
    };
  }
  const reference: ReferenceSource = {
    departments: store(departments, "departments", "department", (id, c) => ({ id, version: 1, name: c.name }), (id) => people.filter((p) => p.departmentId === id).length),
    roles: store(roles, "roles", "role", (id, c) => ({ id, version: 1, name: c.name }), (id) => people.filter((p) => p.roleId === id).length),
    timeoffTypes: store(timeoffTypes, "timeoff_types", "timeoff_type", (id, c) => ({ id, version: 1, name: c.name, deducted: c.deducted }), (id) => schedule.timeoffs.filter((t) => t.typeId === id).length),
    holidays: {
      list: async () => ok(holidays.map((h) => ({ ...h }))),
      async create(input) {
        if (!input.name.trim()) return fail("VALIDATION_FAILED", { field: "name" });
        if (holidays.some((h) => h.date === input.date && h.country === input.country && h.name === input.name.trim())) return fail("ALREADY_EXISTS", { entity: "holiday", field: "date" });
        const h: Holiday = { id: nextId(), version: 1, name: input.name.trim(), date: input.date, country: input.country, departmentId: null, hoursOff: input.hoursOff };
        holidays.push(h);
        hooks.onEntity("holidays", h);
        return ok({ ...h });
      },
      async update(item, patch) {
        const cur = find(holidays, item.id);
        if (!cur) return fail("NOT_FOUND", { entity: "holiday" });
        const bad = stale(cur, item);
        if (bad) return bad;
        Object.assign(cur, patch, { version: cur.version + 1 });
        hooks.onEntity("holidays", cur);
        return ok({ ...cur });
      },
      async remove(item) {
        const cur = find(holidays, item.id);
        if (!cur) return fail("NOT_FOUND", { entity: "holiday" });
        holidays.splice(holidays.indexOf(cur), 1);
        hooks.onRemoved("holidays", cur.id);
        return ok(null);
      },
    },
  };

  const known = (list: { id: string }[], id: string | null | undefined, entity: string) => (id == null || list.some((x) => x.id === id) ? null : fail("NOT_FOUND", { entity }));
  const futureAllocations = (personId: string, asOf: string) => schedule.allocations.filter((a) => a.personId === personId && (a.repeatEndDate ?? a.endDate) >= asOf);

  const directory: PeopleSource = {
    listPeople: async () => ok(people.map((p) => ({ ...p }))),
    async createPerson(input) {
      if (!input.name.trim()) return fail("VALIDATION_FAILED", { field: "name" });
      const bad = known(departments, input.departmentId, "department") ?? known(roles, input.roleId, "role");
      if (bad) return bad;
      const p: Person = {
        id: nextId(), version: 1, name: input.name.trim(), peopleType: input.peopleType ?? "employee", departmentId: input.departmentId ?? null,
        roleId: input.roleId ?? null, country: input.country ?? null, workDaysHours: input.workDaysHours ?? [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
      };
      people.push(p);
      hooks.onEntity("people", p);
      return ok({ ...p });
    },
    async updatePerson(person, patch) {
      const cur = find(people, person.id);
      if (!cur) return fail("NOT_FOUND", { entity: "person" });
      const conflict = stale(cur, person);
      if (conflict) return conflict;
      const bad = known(departments, patch.departmentId, "department") ?? known(roles, patch.roleId, "role");
      if (bad) return bad;
      if (typeof patch.name === "string" && !patch.name.trim()) return fail("VALIDATION_FAILED", { field: "name" });
      const { effectiveFrom, workDaysHours, ...rest } = patch;
      Object.assign(cur, rest, patch.name ? { name: patch.name.trim() } : {});
      // Horaire daté : la période en cours est close la veille de la date d'effet, la nouvelle court sans fin (les périodes
      // déjà prévues à cette date ou après sont remplacées).
      if (workDaysHours && !sameHours(workDaysHours, cur.workDaysHours)) {
        const from = effectiveFrom ?? hooks.today;
        const before = periodsOf(cur).filter((w) => w.validFrom === null || w.validFrom < from).map((w) => (w.validTo === null || w.validTo >= from ? { ...w, validTo: addDays(from, -1) } : w));
        const next = [...before, { validFrom: before.length ? from : null, validTo: null, workDaysHours: [...workDaysHours] }];
        periods.set(cur.id, next);
        cur.workDaysHours = [...workDaysHours];
        if (next.length > 1) cur.workSchedule = next; else delete cur.workSchedule;
      }
      cur.version += 1;
      hooks.onEntity("people", cur);
      return ok({ ...cur });
    },
    reloadPerson: async (id) => { const p = find(people, id); return p ? { ...p } : null; },
    async history(personId) {
      const p = find(people, personId);
      if (!p) return fail("NOT_FOUND", { entity: "person" });
      return ok(periodsOf(p).map((w, i): PersonHistoryEntry => ({ id: `${personId}-${i}`, validFrom: w.validFrom, validTo: w.validTo, attribute: "workDaysHours", workDaysHours: w.workDaysHours })));
    },
    async deactivationSummary(personId) {
      const p = find(people, personId);
      if (!p) return fail("NOT_FOUND", { entity: "person" });
      const future = futureAllocations(personId, hooks.today);
      const starts = future.map((a) => a.startDate).sort();
      const ends = future.map((a) => a.repeatEndDate ?? a.endDate).sort();
      return ok({
        alreadyInactive: !p.active, asOf: hooks.today, allocationCount: future.length, projectCount: new Set(future.map((a) => a.projectId)).size,
        firstAllocation: starts[0] ?? null, lastAllocation: ends.at(-1) ?? null,
      });
    },
    async deactivate(person, request) {
      const cur = find(people, person.id);
      if (!cur) return fail("NOT_FOUND", { entity: "person" });
      const summary = (await directory.deactivationSummary(cur.id)) as { ok: true; value: PersonDeactivationSummary };
      const params = { ...summary.value, firstAllocation: summary.value.firstAllocation ?? "", lastAllocation: summary.value.lastAllocation ?? "" };
      if (summary.value.allocationCount > 0) {
        if (!request.disposition || !request.confirmation) return fail("PERSON_DEACTIVATION_CONFIRMATION_REQUIRED", params);
        if (request.confirmation.allocationCount !== summary.value.allocationCount) return fail("PERSON_DEACTIVATION_STALE_CONFIRMATION", params);
        if (request.disposition === "reassign") {
          const to = request.replacementId ? find(people, request.replacementId) : undefined;
          if (!to) return fail("NOT_FOUND", { entity: "person" });
          if (to.id === cur.id || !to.active) return fail("PERSON_DEACTIVATION_INVALID_REPLACEMENT", { reason: to.id === cur.id ? "same_person" : "inactive" });
        }
      }
      cur.active = false;
      cur.version += 1;
      hooks.onDeactivated(cur.id, hooks.today, request.disposition, request.replacementId);
      hooks.onEntity("people", cur);
      return ok({ ...cur });
    },
  };
  return { people: directory, reference };
}
