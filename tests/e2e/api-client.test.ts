// Bout en bout : le client GÉNÉRÉ depuis le contrat (apps/web) parle à un vrai serveur HTTP (apps/api) sur PGlite.
// Prouve la chaîne contrat -> OpenAPI -> client -> serveur. Vit hors des apps : elles ne s'importent pas entre elles.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../apps/web/src/api/client.gen";
import { createHttpServer, type Db } from "../../apps/api/src/index";

let pg: PGlite;
let server: Server;
let base: string;
const auth = { authorization: "Bearer ok" };

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync("schema.sql", "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A');
    INSERT INTO people (account_id, name, tags) VALUES (1, 'Alice', '{é &=?}'), (1, 'Bob', '{}');
    INSERT INTO projects (account_id, name) VALUES (1, 'P1');
    INSERT INTO timeoff_types (account_id, name) VALUES (1, 'Vacances');
  `);
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  server = createHttpServer({ db, authenticate: async (h) => (h.authorization === "Bearer ok" ? { accountId: "1", userId: "1", role: "admin" } : null) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await pg?.close(); }, 60_000);

const client = (headers: Record<string, string> = auth) =>
  createClient({ baseUrl: base, fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...headers } }) as never });

describe("client généré <-> serveur", () => {
  it("getSchedule renvoie les données ; un tag à caractères spéciaux traverse l'encodage URL", async () => {
    const res = await client().getSchedule({ from: "2026-03-02", to: "2026-03-06", tag: "é &=?" });
    expect(res.ok).toBe(true);
    if (res.ok && "people" in res.data) expect(res.data.people.map((p) => p.name)).toEqual(["Alice"]);
    else throw new Error("réponse inattendue");
  });

  it("une plage invalide arrive en 400 avec le code du contrat", async () => {
    const res = await client().getSchedule({ from: "2026-03-10", to: "2026-03-01" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error).toMatchObject({ code: "SCHEDULE_RANGE_INVALID" });
    }
  });

  it("sans jeton : 401", async () => {
    expect((await client({}).getSchedule({ from: "2026-03-02", to: "2026-03-06" })).status).toBe(401);
  });
});

describe("écritures : client généré <-> serveur", () => {
  it("créer, modifier avec If-Match, subir un conflit, recharger, rejouer, supprimer (204)", async () => {
    const api = client();
    const created = await api.createAllocation({ body: { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-06", load: { mode: "percentage", percent: 150 } } });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("création refusée");
    const a = created.data;
    const ifMatch = (v: number) => ({ "If-Match": `"${v}"` });

    const moved = await api.updateAllocation({ path: { id: a.id }, headers: ifMatch(a.version), body: { personId: "2", name: "déplacée / test" } });
    expect(moved.ok && moved.data).toMatchObject({ personId: "2", name: "déplacée / test", version: a.version + 1 });

    const stale = await api.updateAllocation({ path: { id: a.id }, headers: ifMatch(a.version), body: { name: "périmée" } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatchObject({ code: "VERSION_CONFLICT", params: { currentVersion: a.version + 1 } });

    const noHeader = await createClient({ baseUrl: base, fetch: (u, i) => fetch(u, { ...i, headers: { ...i.headers, ...auth } }) as never })
      .updateAllocation({ path: { id: a.id }, headers: {} as never, body: { name: "x" } });
    expect(noHeader.status).toBe(428);

    const del = await api.deleteAllocation({ path: { id: a.id }, headers: ifMatch(a.version + 1) });
    expect(del).toEqual({ ok: true, status: 204, data: undefined });
    const gone = await api.deleteAllocation({ path: { id: a.id }, headers: ifMatch(a.version + 1) });
    expect(gone.status).toBe(404);
  });
});

describe("congés : client généré <-> serveur", () => {
  it("créer, chevaucher (TIMEOFF_OVERLAP), modifier avec If-Match, supprimer (204)", async () => {
    const api = client();
    const body = { personId: "1", typeId: "1", startDate: "2026-07-06", endDate: "2026-07-10" };
    const created = await api.createTimeoff({ body });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("création refusée");
    const t = created.data;

    const overlap = await api.createTimeoff({ body: { ...body, startDate: "2026-07-08", endDate: "2026-07-08" } });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect([overlap.status, overlap.error]).toEqual([409, expect.objectContaining({ code: "TIMEOFF_OVERLAP" })]);

    const ifMatch = (v: number) => ({ "If-Match": `"${v}"` });
    const approved = await api.updateTimeoff({ path: { id: t.id }, headers: ifMatch(t.version), body: { approvalStatus: "approved" } });
    expect(approved.ok && approved.data).toMatchObject({ approvalStatus: "approved", version: t.version + 1 });

    const stale = await api.updateTimeoff({ path: { id: t.id }, headers: ifMatch(t.version), body: { notes: "périmée" } });
    if (stale.ok) throw new Error("conflit attendu");
    expect(stale.error).toMatchObject({ code: "VERSION_CONFLICT" });

    expect(await api.deleteTimeoff({ path: { id: t.id }, headers: ifMatch(t.version + 1) })).toEqual({ ok: true, status: 204, data: undefined });
  });
});

describe("personnes : client généré <-> serveur", () => {
  it("créer, modifier avec If-Match, désactiver, subir un conflit", async () => {
    const api = client();
    const created = await api.createPerson({ body: { name: "Chloé", country: "FR", workDaysHours: [8, 8, 4, 8, 0, 0, 0], tags: ["é &=?"] } });
    expect(created.status).toBe(201);
    if (!created.ok) throw new Error("création refusée");
    const p = created.data;
    expect(p).toMatchObject({ name: "Chloé", active: true, version: 1 });

    const off = await api.updatePerson({ path: { id: p.id }, headers: { "If-Match": `"${p.version}"` }, body: { active: false } });
    expect(off.ok && off.data).toMatchObject({ active: false, version: 2 });

    const stale = await api.updatePerson({ path: { id: p.id }, headers: { "If-Match": `"${p.version}"` }, body: { name: "périmée" } });
    if (stale.ok) throw new Error("conflit attendu");
    expect([stale.status, stale.error.code]).toEqual([409, "VERSION_CONFLICT"]);
  });
});

describe("retrait d'équipe (BR-10) : client généré <-> serveur", () => {
  it("récapitulatif, refus sans confirmation, exécution avec confirmation", async () => {
    const api = client();
    await pg.exec(`INSERT INTO allocations (account_id, person_id, project_id, start_date, end_date, mode, hours_per_day) VALUES (1, 2, 1, '2026-09-07', '2026-09-08', 'hours', 4)`);
    const path = { projectId: "1", personId: "2" };
    const sum = await api.getTeamRemovalSummary({ path });
    expect(sum.ok && sum.data).toMatchObject({ allocationCount: 1, canRemove: true });

    const refused = await api.removeFromTeam({ path, body: {} });
    if (refused.ok) throw new Error("confirmation exigée");
    expect([refused.status, refused.error.code]).toEqual([428, "TEAM_REMOVAL_CONFIRMATION_REQUIRED"]);

    const done = await api.removeFromTeam({ path, body: { confirmation: { allocationCount: 1, logCount: 0, logHours: 0 } } });
    expect(done.ok && done.data).toMatchObject({ removedAllocations: 1 });
  });

  it("ajouter à l'équipe (PUT idempotent) puis retirer", async () => {
    const api = client();
    const path = { projectId: "1", personId: "2" };
    const first = await api.addToTeam({ path, headers: {} });
    expect(first.ok && first.data).toEqual({ added: true });
    const again = await api.addToTeam({ path, headers: {} });
    expect(again.ok && again.data).toEqual({ added: false });
    const gone = await api.removeFromTeam({ path, body: {} });
    expect(gone.ok && gone.data).toMatchObject({ wasInTeam: true, removedAllocations: 0 });
  });

  it("entités de référence : créer, modifier, doublon, supprimer, projet sans suppression", async () => {
    const api = client();
    const dep = await api.createDepartment({ body: { name: "Studio" } });
    if (!dep.ok) throw new Error("création attendue");
    expect(dep.data).toMatchObject({ name: "Studio", version: 1 });
    const dup = await api.createDepartment({ body: { name: "Studio" } });
    if (dup.ok) throw new Error("doublon attendu");
    expect([dup.status, dup.error.code]).toEqual([409, "ALREADY_EXISTS"]);
    const ren = await api.updateDepartment({ path: { id: dep.data.id }, headers: { "If-Match": '"1"' }, body: { name: "Studio 2" } });
    expect(ren.ok && ren.data).toMatchObject({ name: "Studio 2", version: 2 });
    const del = await api.deleteDepartment({ path: { id: dep.data.id }, headers: { "If-Match": '"2"' } });
    expect(del.ok).toBe(true);

    const proj = await api.createProject({ body: { name: "Refonte", projectCode: "R-1", tags: ["web"] } });
    if (!proj.ok) throw new Error("création attendue");
    const archived = await api.updateProject({ path: { id: proj.data.id }, headers: { "If-Match": '"1"' }, body: { status: "archived" } });
    expect(archived.ok && archived.data).toMatchObject({ status: "archived", version: 2, projectCode: "R-1" });
  });

  it("entités de référence : lister, paginer, relire par id, archivés à part (client généré)", async () => {
    const api = client();
    for (const name of ["Lire 1", "Lire 2", "Lire 3"]) await api.createRole({ body: { name } });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await api.listRoles({ limit: 2, ...(cursor ? { cursor } : {}) });
      if (!p.ok) throw new Error("liste attendue");
      seen.push(...p.data.items.map((i) => i.name));
      cursor = p.data.page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expect.arrayContaining(["Lire 1", "Lire 2", "Lire 3"]));
    const one = await api.listRoles({ limit: 1 });
    if (!one.ok) throw new Error("liste attendue");
    const got = await api.getRole({ path: { id: one.data.items[0]!.id } });
    expect(got.ok && got.data).toEqual(one.data.items[0]);

    const proj = await api.createProject({ body: { name: "Rangé", projectCode: "RG-1" } });
    if (!proj.ok) throw new Error("création attendue");
    await api.updateProject({ path: { id: proj.data.id }, headers: { "If-Match": '"1"' }, body: { status: "archived" } });
    const live = await api.listProjects({});
    const old = await api.listProjects({ status: "archived" });
    expect(live.ok && live.data.items.some((p) => p.id === proj.data.id)).toBe(false);
    expect(old.ok && old.data.items.some((p) => p.id === proj.data.id)).toBe(true);
    const bad = await api.listRoles({ cursor: "!!!" });
    if (bad.ok) throw new Error("curseur invalide attendu");
    expect([bad.status, bad.error.code]).toEqual([400, "SCHEDULE_CURSOR_INVALID"]);
  });

  it("clients, phases et tâches : création, filtre par projet, déplacement, suppression refusée tant que référencée", async () => {
    const api = client();
    const proj = await api.createProject({ body: { name: "Structure" } });
    if (!proj.ok) throw new Error("projet attendu");
    const cl = await api.createClient({ body: { name: "ACME", tags: ["vip"] } });
    if (!cl.ok) throw new Error("client attendu");
    const ph = await api.createPhase({ body: { projectId: proj.data.id, name: "Cadrage" } });
    if (!ph.ok) throw new Error("phase attendue");
    const task = await api.createProjectTask({ body: { projectId: proj.data.id, name: "Design", phaseId: ph.data.id } });
    if (!task.ok) throw new Error("tâche attendue");
    expect(task.data).toMatchObject({ projectId: proj.data.id, phaseId: ph.data.id, billable: true, version: 1 });

    const tasks = await api.listProjectTasks({ projectId: proj.data.id, phaseId: ph.data.id });
    expect(tasks.ok && tasks.data.items.map((t) => t.id)).toEqual([task.data.id]);
    const phases = await api.listPhases({ projectId: proj.data.id });
    expect(phases.ok && phases.data.page.total).toBe(1);

    const refused = await api.deletePhase({ path: { id: ph.data.id }, headers: { "If-Match": '"1"' } });
    if (refused.ok) throw new Error("refus attendu");
    expect([refused.status, refused.error.code, refused.error.params.tasks]).toEqual([409, "REFERENCE_IN_USE", 1]);

    const moved = await api.updateProjectTask({ path: { id: task.data.id }, headers: { "If-Match": '"1"' }, body: { phaseId: null } });
    expect(moved.ok && moved.data.phaseId).toBeNull();
    expect((await api.deletePhase({ path: { id: ph.data.id }, headers: { "If-Match": '"1"' } })).status).toBe(204);
    expect((await api.deleteProjectTask({ path: { id: task.data.id }, headers: { "If-Match": '"2"' } })).status).toBe(204);
    expect((await api.deleteClient({ path: { id: cl.data.id }, headers: { "If-Match": '"1"' } })).status).toBe(204);
  });

  it("jalons : création, filtre par échéance, déplacement vers une phase, suppression", async () => {
    const api = client();
    const proj = await api.createProject({ body: { name: "Jalons" } });
    if (!proj.ok) throw new Error("projet attendu");
    const ph = await api.createPhase({ body: { projectId: proj.data.id, name: "Livraison" } });
    if (!ph.ok) throw new Error("phase attendue");
    const m = await api.createMilestone({ body: { projectId: proj.data.id, name: "Recette", dueDate: "2026-06-30" } });
    if (!m.ok) throw new Error("jalon attendu");
    expect(m.data).toMatchObject({ projectId: proj.data.id, phaseId: null, dueDate: "2026-06-30", version: 1 });

    const inRange = await api.listMilestones({ projectId: proj.data.id, dueFrom: "2026-06-01", dueTo: "2026-06-30" });
    expect(inRange.ok && inRange.data.items.map((x) => x.id)).toEqual([m.data.id]);
    const outside = await api.listMilestones({ projectId: proj.data.id, dueFrom: "2026-07-01" });
    expect(outside.ok && outside.data.page.total).toBe(0);

    const moved = await api.updateMilestone({ path: { id: m.data.id }, headers: { "If-Match": '"1"' }, body: { phaseId: ph.data.id } });
    expect(moved.ok && moved.data).toMatchObject({ phaseId: ph.data.id, version: 2 });
    const refused = await api.deletePhase({ path: { id: ph.data.id }, headers: { "If-Match": '"1"' } });
    if (refused.ok) throw new Error("refus attendu");
    expect([refused.status, refused.error.params.milestones]).toEqual([409, 1]);
    expect((await api.deleteMilestone({ path: { id: m.data.id }, headers: { "If-Match": '"2"' } })).status).toBe(204);
    expect((await api.deletePhase({ path: { id: ph.data.id }, headers: { "If-Match": '"1"' } })).status).toBe(204);
  });

  it("équipe d'un projet : ajout, lecture paginée, retrait, 404 d'un projet inconnu", async () => {
    const api = client();
    const proj = await api.createProject({ body: { name: "Équipe" } });
    if (!proj.ok) throw new Error("projet attendu");
    const people = await api.getSchedule({ from: "2026-03-02", to: "2026-03-06" });
    if (!people.ok || !("people" in people.data)) throw new Error("planning attendu");
    const ids = people.data.people.map((p) => p.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) await api.addToTeam({ path: { projectId: proj.data.id, personId: id } });

    const p1 = await api.listProjectTeam({ path: { projectId: proj.data.id }, query: { limit: 1 } });
    if (!p1.ok) throw new Error("page attendue");
    expect(p1.data.page.total).toBe(ids.length);
    expect(p1.data.items).toHaveLength(1);
    const p2 = await api.listProjectTeam({ path: { projectId: proj.data.id }, query: { cursor: p1.data.page.nextCursor ?? undefined } });
    expect(p2.ok && p2.data.items.length).toBe(ids.length - 1);

    await api.removeFromTeam({ path: { projectId: proj.data.id, personId: ids[0]! }, body: {} });
    const after = await api.listProjectTeam({ path: { projectId: proj.data.id } });
    expect(after.ok && after.data.page.total).toBe(ids.length - 1);

    const missing = await api.listProjectTeam({ path: { projectId: "99999" } });
    if (missing.ok) throw new Error("404 attendu");
    expect([missing.status, missing.error.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("ajout en lot à l'équipe : deux listes, rejouable, tout ou rien", async () => {
    const api = client();
    const proj = await api.createProject({ body: { name: "Lot" } });
    if (!proj.ok) throw new Error("projet attendu");
    const sched = await api.getSchedule({ from: "2026-03-02", to: "2026-03-06" });
    if (!sched.ok || !("people" in sched.data)) throw new Error("planning attendu");
    const ids = sched.data.people.map((p) => p.id);
    const path = { projectId: proj.data.id };
    const first = await api.addManyToTeam({ path, body: { personIds: ids } });
    expect(first.ok && first.data).toEqual({ added: ids, alreadyInTeam: [] });
    const again = await api.addManyToTeam({ path, body: { personIds: ids } });
    expect(again.ok && again.data).toEqual({ added: [], alreadyInTeam: ids });
    const bad = await api.addManyToTeam({ path: { projectId: proj.data.id }, body: { personIds: ["99999"] } });
    if (bad.ok) throw new Error("404 attendu");
    expect([bad.status, bad.error.code, bad.error.params.personId]).toEqual([404, "NOT_FOUND", "99999"]);
    const dup = await api.addManyToTeam({ path, body: { personIds: [ids[0]!, ids[0]!] } });
    if (dup.ok) throw new Error("400 attendu");
    expect([dup.status, dup.error.params.field]).toEqual([400, "personIds"]);
  });

  it("personnes : liste filtrée, lecture par id, projets d'une personne", async () => {
    const api = client();
    const created = await api.createPerson({ body: { name: "Zélie Lecture", tags: ["lecture"] } });
    if (!created.ok) throw new Error("personne attendue");
    const found = await api.listPeople({ search: "zélie", tag: "lecture" });
    expect(found.ok && found.data.items.map((p) => p.id)).toEqual([created.data.id]);
    const one = await api.getPerson({ path: { id: created.data.id } });
    expect(one.ok && one.data).toEqual(created.data);

    await api.updatePerson({ path: { id: created.data.id }, headers: { "If-Match": '"1"' }, body: { active: false } });
    const hidden = await api.listPeople({ search: "zélie" });
    const shown = await api.listPeople({ search: "zélie", includeInactive: true });
    expect([hidden.ok && hidden.data.items.length, shown.ok && shown.data.items.length]).toEqual([0, 1]);

    const proj = await api.createProject({ body: { name: "Projets de Zélie" } });
    if (!proj.ok) throw new Error("projet attendu");
    await api.addToTeam({ path: { projectId: proj.data.id, personId: created.data.id } });
    const mine = await api.listPersonProjects({ path: { id: created.data.id } });
    expect(mine.ok && mine.data.items.map((i) => [i.project.id, i.inTeam, i.allocationCount])).toEqual([[proj.data.id, true, 0]]);

    const missing = await api.getPerson({ path: { id: "99999" } });
    if (missing.ok) throw new Error("404 attendu");
    expect([missing.status, missing.error.params.entity]).toEqual([404, "person"]);
  });

  it("allocations d'un projet : création, lecture par id, liste sur une fenêtre avec filtres, 404 d'un projet inconnu", async () => {
    const api = client();
    const proj = await api.createProject({ body: { name: "Lecture des allocations" } });
    const sched = await api.getSchedule({ from: "2026-03-02", to: "2026-03-06" });
    if (!proj.ok || !sched.ok || !("people" in sched.data)) throw new Error("préparation");
    const [alice, bob] = sched.data.people.map((p) => p.id) as [string, string];
    const mk = async (personId: string, startDate: string, endDate: string, status?: "tentative" | "confirmed") => {
      const r = await api.createAllocation({ body: { personId, projectId: proj.data.id, startDate, endDate, status, load: { mode: "hours", hoursPerDay: 4 } } });
      if (!r.ok) throw new Error("allocation attendue");
      return r.data;
    };
    const a = await mk(alice, "2026-03-02", "2026-03-03");
    const b = await mk(bob, "2026-03-05", "2026-03-09", "tentative");
    await mk(alice, "2026-04-01", "2026-04-02"); // hors fenêtre

    const path = { projectId: proj.data.id };
    const win = { from: "2026-03-02", to: "2026-03-06" };
    const all = await api.listProjectAllocations({ path, query: win });
    expect(all.ok && all.data.items.map((x) => x.id)).toEqual([a.id, b.id]);
    const tent = await api.listProjectAllocations({ path, query: { ...win, status: "tentative" } });
    expect(tent.ok && tent.data.items.map((x) => x.id)).toEqual([b.id]);
    const mine = await api.listProjectAllocations({ path, query: { ...win, personId: alice } });
    expect(mine.ok && mine.data.page.total).toBe(1);

    const one = await api.getAllocation({ path: { id: a.id } });
    expect(one.ok && one.data).toEqual(a);

    const missing = await api.listProjectAllocations({ path: { projectId: "99999" }, query: win });
    if (missing.ok) throw new Error("404 attendu");
    expect([missing.status, missing.error.params.entity]).toEqual([404, "project"]);
    const bad = await api.listProjectAllocations({ path, query: { from: "2026-03-06", to: "2026-03-02" } });
    if (bad.ok) throw new Error("400 attendu");
    expect(bad.error.code).toBe("SCHEDULE_RANGE_INVALID");
  });
});
