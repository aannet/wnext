import { describe, expect, it, vi } from "vitest";
import { demoSchedule } from "../src/demo";
import { createApiPeopleSource, createApiReferenceSource, createDemoDirectory, type DirResult, type Person } from "../src/data/people-source";

async function value<T>(p: Promise<DirResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function demo() {
  const entities: string[] = [];
  const removed: string[] = [];
  const deactivated: unknown[][] = [];
  const dir = createDemoDirectory(demoSchedule("2026-10-20", 12), {
    today: "2026-10-20",
    onEntity: (kind, e) => entities.push(`${kind}:${e.id}:v${e.version}`),
    onRemoved: (kind, id) => removed.push(`${kind}:${id}`),
    onDeactivated: (...args) => deactivated.push(args),
  });
  return { ...dir, entities, removed, deactivated };
}

describe("démo : personnes (mêmes règles que l'API)", () => {
  it("crée une personne avec l'horaire par défaut quand seul le nom est donné, et la répercute", async () => {
    const { people, entities } = demo();
    const p = await value(people.createPerson({ name: "  Ada Lovelace " }));
    expect(p).toMatchObject({ name: "Ada Lovelace", peopleType: "employee", active: true, workDaysHours: [8, 8, 8, 8, 8, 0, 0], departmentId: null });
    expect(entities).toEqual([`people:${p.id}:v1`]);
    expect((await value(people.listPeople())).map((x) => x.name)).toContain("Ada Lovelace");
  });

  it("refuse un nom vide et une équipe inconnue", async () => {
    const { people } = demo();
    expect(await people.createPerson({ name: " " })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await people.createPerson({ name: "X", departmentId: "inconnue" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", params: { entity: "department" } } });
  });

  it("verrou optimiste : version périmée = VERSION_CONFLICT", async () => {
    const { people } = demo();
    const p = (await value(people.listPeople()))[0]!;
    await value(people.updatePerson(p, { country: "FR" }));
    expect(await people.updatePerson(p, { country: "BE" })).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
  });

  it("horaire daté (BR-19) : la période en cours est close la veille, la nouvelle court à partir de la date d'effet", async () => {
    const { people } = demo();
    const p = await value(people.createPerson({ name: "Ada" }));
    const next = await value(people.updatePerson(p, { workDaysHours: [8, 8, 8, 8, 0, 0, 0], effectiveFrom: "2026-11-02" }));
    expect(next.workDaysHours).toEqual([8, 8, 8, 8, 0, 0, 0]);
    const history = await value(people.history(p.id));
    expect(history).toMatchObject([
      { validFrom: null, validTo: "2026-11-01", workDaysHours: [8, 8, 8, 8, 8, 0, 0] },
      { validFrom: "2026-11-02", validTo: null, workDaysHours: [8, 8, 8, 8, 0, 0, 0] },
    ]);
  });

  it("sans date d'effet, la modification prend effet aujourd'hui ; un horaire inchangé n'ouvre pas de période", async () => {
    const { people } = demo();
    const p = await value(people.createPerson({ name: "Ada" }));
    const same = await value(people.updatePerson(p, { workDaysHours: [8, 8, 8, 8, 8, 0, 0] }));
    expect(await value(people.history(p.id))).toHaveLength(1);
    await value(people.updatePerson(same, { workDaysHours: [4, 4, 4, 4, 4, 0, 0] }));
    expect((await value(people.history(p.id))).at(-1)).toMatchObject({ validFrom: "2026-10-20", validTo: null });
  });

  it("désactivation : sans allocation à venir, un simple appel ; avec, confirmation du récapitulatif exigée puis réaffectation", async () => {
    const { people, deactivated } = demo();
    const fresh = await value(people.createPerson({ name: "Ada" }));
    expect(await value(people.deactivationSummary(fresh.id))).toMatchObject({ allocationCount: 0, alreadyInactive: false });
    expect((await value(people.deactivate(fresh, { asOf: "2026-10-20" }))).active).toBe(false);

    const busy = (await value(people.listPeople()))[0]!;
    const summary = await value(people.deactivationSummary(busy.id));
    expect(summary.allocationCount).toBeGreaterThan(0);
    const refused = await people.deactivate(busy, { asOf: summary.asOf });
    expect(refused).toMatchObject({ ok: false, error: { code: "PERSON_DEACTIVATION_CONFIRMATION_REQUIRED", params: { allocationCount: summary.allocationCount } } });
    const stale = await people.deactivate(busy, { disposition: "delete", confirmation: { allocationCount: summary.allocationCount + 1 }, asOf: summary.asOf });
    expect(stale).toMatchObject({ ok: false, error: { code: "PERSON_DEACTIVATION_STALE_CONFIRMATION", params: { allocationCount: summary.allocationCount } } });
    const self = await people.deactivate(busy, { disposition: "reassign", replacementId: busy.id, confirmation: { allocationCount: summary.allocationCount }, asOf: summary.asOf });
    expect(self).toMatchObject({ ok: false, error: { code: "PERSON_DEACTIVATION_INVALID_REPLACEMENT" } });
    const done = await value(people.deactivate(busy, { disposition: "reassign", replacementId: "2", confirmation: { allocationCount: summary.allocationCount }, asOf: summary.asOf }));
    expect(done.active).toBe(false);
    expect(deactivated.at(-1)).toEqual([busy.id, "2026-10-20", "reassign", "2"]);
  });
});

describe("démo : accès (RT-040)", () => {
  const withMembers = (memberIds?: readonly string[]) => {
    const entities: Record<string, unknown>[] = [];
    const dir = createDemoDirectory(demoSchedule("2026-10-20", 12), {
      today: "2026-10-20", onEntity: (_k, e) => entities.push(e as never), onRemoved: () => {}, onDeactivated: () => {},
      ...(memberIds ? { memberIds } : {}),
    });
    return { ...dir, entities };
  };
  it("memberIds : chaque personne porte access (member si listée, none sinon), une création est none, une écriture le garde", async () => {
    const { people, entities } = withMembers(["1", "3"]);
    const list = await value(people.listPeople());
    expect(list.filter((p) => p.access === "member").map((p) => p.id)).toEqual(["1", "3"]);
    expect(list.every((p) => p.access === "member" || p.access === "none")).toBe(true);
    expect((await value(people.createPerson({ name: "Ada" }))).access).toBe("none");
    const one = list.find((p) => p.id === "1")!;
    expect((await value(people.updatePerson(one, { name: "Une" }))).access).toBe("member");
    const { allocationCount } = await value(people.deactivationSummary("1"));
    expect((await value(people.deactivate({ ...one, version: one.version + 1 }, { disposition: "delete", confirmation: { allocationCount } }))).access).toBe("member");
    expect((await people.reloadPerson("1"))?.access).toBe("member");
    for (const e of entities) expect(Object.keys(e)).not.toContain("access"); // le planning ne le porte pas (comme /schedule)
  });
  it("sans memberIds (rôle member ou guest) : la clé est absente", async () => {
    const { people } = withMembers();
    for (const p of await value(people.listPeople())) expect(Object.keys(p)).not.toContain("access");
    expect(Object.keys(await value(people.createPerson({ name: "Ada" })))).not.toContain("access");
  });
});

describe("démo : équipes, rôles, types de congé", () => {
  it("crée, renomme, refuse un doublon (casse ignorée) et supprime ; l'élément en usage est refusé", async () => {
    const { reference, people, entities, removed } = demo();
    const team = await value(reference.departments.create({ name: "Données" }));
    expect(await reference.departments.create({ name: "données" })).toMatchObject({ ok: false, error: { code: "ALREADY_EXISTS" } });
    const renamed = await value(reference.departments.update(team, { name: "Data" }));
    expect(renamed).toMatchObject({ name: "Data", version: 2 });
    expect(await reference.departments.update(team, { name: "Autre" })).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
    expect(entities).toContain(`departments:${team.id}:v2`);

    const ada = await value(people.createPerson({ name: "Ada", departmentId: team.id }));
    expect(ada.departmentId).toBe(team.id);
    expect(await reference.departments.remove(renamed)).toMatchObject({ ok: false, error: { code: "REFERENCE_IN_USE" } });
    await value(people.updatePerson(ada, { departmentId: null }));
    await value(reference.departments.remove(renamed));
    expect(removed).toEqual([`departments:${team.id}`]);
    expect((await value(reference.departments.list())).map((d) => d.name)).not.toContain("Data");
  });

  it("types de congé : un type utilisé par un congé ne se supprime pas", async () => {
    const { reference } = demo();
    const types = await value(reference.timeoffTypes.list());
    const used = types.find((t) => t.name === "Congés payés")!;
    expect(await reference.timeoffTypes.remove(used)).toMatchObject({ ok: false, error: { code: "REFERENCE_IN_USE" } });
    const free = types.find((t) => t.name === "Formation")!;
    expect(await value(reference.timeoffTypes.update(free, { deducted: true }))).toMatchObject({ deducted: true });
  });

  it("jours fériés : création, doublon refusé, suppression", async () => {
    const { reference } = demo();
    const h = await value(reference.holidays.create({ name: "Noël", date: "2026-12-25", country: "FR", hoursOff: null }));
    expect(await reference.holidays.create({ name: "Noël", date: "2026-12-25", country: "FR", hoursOff: null })).toMatchObject({ ok: false, error: { code: "ALREADY_EXISTS" } });
    await value(reference.holidays.remove(h));
    expect(await value(reference.holidays.list())).toEqual([]);
  });
});

describe("source API : appels du client généré", () => {
  const page = <T,>(items: T[], nextCursor: string | null = null) => ({ ok: true as const, status: 200, data: { items, page: { nextCursor } } });
  const person = { id: "7", version: 3 } as Person;

  it("lit toutes les pages, désactivées comprises", async () => {
    const listPeople = vi.fn(async (q: { cursor?: string }) => (q.cursor ? page([{ id: "2" }]) : page([{ id: "1" }], "c2")));
    const r = await createApiPeopleSource({ listPeople } as never).listPeople();
    expect(r).toEqual({ ok: true, value: [{ id: "1" }, { id: "2" }] });
    expect(listPeople).toHaveBeenNthCalledWith(1, { limit: 200, includeInactive: true });
    expect(listPeople).toHaveBeenNthCalledWith(2, { limit: 200, includeInactive: true, cursor: "c2" });
  });

  it("PATCH porte If-Match = version lue et la date d'effet", async () => {
    const updatePerson = vi.fn(async () => ({ ok: true as const, status: 200, data: person }));
    await createApiPeopleSource({ updatePerson } as never).updatePerson(person, { workDaysHours: [8, 8, 8, 8, 0, 0, 0], effectiveFrom: "2026-11-02" });
    expect(updatePerson).toHaveBeenCalledWith({ path: { id: "7" }, headers: { "If-Match": '"3"' }, body: { workDaysHours: [8, 8, 8, 8, 0, 0, 0], effectiveFrom: "2026-11-02" } });
  });

  it("garde les params de PERSON_HISTORY_LOCKED (dernier jour verrouillé)", async () => {
    const updatePerson = vi.fn(async () => ({ ok: false as const, status: 409, error: { code: "PERSON_HISTORY_LOCKED", params: { lockedThrough: "2026-09-30" }, requestId: "r" } }));
    expect(await createApiPeopleSource({ updatePerson } as never).updatePerson(person, { workDaysHours: [1, 1, 1, 1, 1, 0, 0] }))
      .toEqual({ ok: false, error: { code: "PERSON_HISTORY_LOCKED", params: { lockedThrough: "2026-09-30" } } });
  });

  it("la désactivation renvoie la personne ; l'historique, le récapitulatif et les suppressions passent par le client", async () => {
    const deactivatePerson = vi.fn(async () => ({ ok: true as const, status: 200, data: { person: { id: "7", active: false } } }));
    const r = await createApiPeopleSource({ deactivatePerson } as never).deactivate(person, { asOf: "2026-10-20" });
    expect(r).toEqual({ ok: true, value: { id: "7", active: false } });
    expect(deactivatePerson).toHaveBeenCalledWith({ path: { id: "7" }, body: { asOf: "2026-10-20" } });

    const deleteDepartment = vi.fn(async () => ({ ok: false as const, status: 409, error: { code: "REFERENCE_IN_USE", params: { people: 2 }, requestId: "r" } }));
    expect(await createApiReferenceSource({ deleteDepartment } as never).departments.remove({ id: "4", version: 2, name: "X" }))
      .toEqual({ ok: false, error: { code: "REFERENCE_IN_USE", params: { people: 2 } } });
    expect(deleteDepartment).toHaveBeenCalledWith({ path: { id: "4" }, headers: { "If-Match": '"2"' } });
  });

  it("la désactivation garde l'accès lu (PersonDeactivationResult ne le porte pas, RT-040)", async () => {
    const deactivatePerson = vi.fn(async () => ({ ok: true as const, status: 200, data: { person: { id: "7", active: false } } }));
    expect(await createApiPeopleSource({ deactivatePerson } as never).deactivate({ ...person, access: "member" }, {}))
      .toEqual({ ok: true, value: { id: "7", active: false, access: "member" } });
  });

  it("un échec réseau devient INTERNAL_ERROR", async () => {
    const listPeople = vi.fn(async () => { throw new Error("réseau"); });
    expect(await createApiPeopleSource({ listPeople } as never).listPeople()).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });
});
