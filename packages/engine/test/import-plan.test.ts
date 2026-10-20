// Import CSV simple (US-1.2), plan contre l'existant : créations, mises à jour, inchangées, références, idempotence.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { importReport, planImport, type ExistingPerson, type ExistingProject, type ImportSnapshot, type PersonWrite, type ProjectWrite, type ClientWrite } from "../src/import-plan";
import { analyzeImport } from "../src/import-rows";

const person = (id: string, over: Partial<ExistingPerson> = {}): ExistingPerson => ({
  id, name: `P${id}`, email: `p${id}@x.fr`, peopleType: "employee", departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], lockedThrough: null, ...over,
});
const project = (id: string, over: Partial<ExistingProject> = {}): ExistingProject => ({
  id, name: `Projet ${id}`, projectCode: `C${id}`, clientId: null, color: "#3B82F6", startDate: null, endDate: null, status: "planned",
  projectManagerId: null, nonBillable: false, tags: [], notes: null, ...over,
});
const snap = (over: Partial<ImportSnapshot> = {}): ImportSnapshot => ({
  today: "2026-10-20", departments: [{ id: "d1", name: "Design" }], roles: [{ id: "r1", name: "Lead" }],
  clients: [{ id: "c1", name: "Acme", shortName: null, tags: [] }], people: [person("1")], projects: [project("1")], ...over,
});
const plan = (kind: "people" | "projects" | "clients", csv: string, s = snap()) => planImport(analyzeImport(kind, csv), s);

describe("personnes", () => {
  it("création avec références existantes (sans casse) et à créer (une fois, première graphie)", () => {
    const p = plan("people", "name,email,department,role,hours_per_day,tags\nA,a@x.fr,design,Dev,7,t\nB,b@x.fr,Ops,DEV,,\n");
    expect(p.creates).toEqual([
      { line: 2, values: { name: "A", email: "a@x.fr", department: { id: "d1" }, role: { create: "Dev" }, workDaysHours: [7, 7, 7, 7, 7, 0, 0], tags: ["t"] } satisfies PersonWrite },
      { line: 3, values: { name: "B", email: "b@x.fr", department: { create: "Ops" }, role: { create: "DEV" } } },
    ]);
    expect(p.references).toEqual({ departments: ["Ops"], roles: ["Dev"], clients: [] });
    expect([p.updates, p.unchanged, p.invalid]).toEqual([[], 0, 0]);
  });
  it("e-mail existant (sans casse) : mise à jour des seuls champs fournis qui diffèrent, sinon inchangée", () => {
    const s = snap({ people: [person("1", { departmentId: "d1", tags: ["b", "a"], country: "FR" }), person("2")] });
    const p = plan("people", "name,email,department,tags,country,type,hours_per_day\nP1,P1@X.FR,Design,a|b,FR,employee,8\nNouveau nom,p2@x.fr,,,BE,contractor,6\n", s);
    expect(p.unchanged).toBe(1);
    expect(p.updates).toEqual([{ line: 3, id: "2", changes: { name: "Nouveau nom", country: "BE", peopleType: "contractor", workDaysHours: [6, 6, 6, 6, 6, 0, 0] } }]);
    const roles = plan("people", "name,email,role,department\nP1,p1@x.fr,Lead,Neuf\n");
    expect(roles.updates).toEqual([{ line: 2, id: "1", changes: { role: { id: "r1" }, department: { create: "Neuf" } } }]);
  });
  it("référence ambiguë (deux départements de même nom sans casse, aucun exact) : erreur, ligne ignorée", () => {
    const s = snap({ departments: [{ id: "d1", name: "Design" }, { id: "d2", name: "DESIGN" }] });
    expect(plan("people", "name,email,department\nA,a@x.fr,design\nB,b@x.fr,DESIGN\n", s)).toMatchObject({
      errors: [{ line: 2, column: "department", code: "ambiguous_reference", value: "design" }], invalid: 1,
      creates: [{ line: 3, values: { department: { id: "d2" } } }],
    });
    const r = plan("people", "name,email,role\nA,a@x.fr,lead\n", snap({ roles: [{ id: "r1", name: "Lead" }, { id: "r2", name: "LEAD" }] }));
    expect(r.errors.map((e) => e.code)).toEqual(["ambiguous_reference"]);
  });
  it("BR-19/BR-12 : changer horaire, département ou rôle d'une personne aux temps verrouillés jusqu'à aujourd'hui ou après : history_locked", () => {
    const s = snap({ people: [person("1", { lockedThrough: "2026-10-20" }), person("2", { lockedThrough: "2026-10-19" })] });
    const p = plan("people", "name,email,hours_per_day,role\nP1,p1@x.fr,6,\nP2,p2@x.fr,6,\nP1 bis,p1@x.fr,,\n", s);
    expect(p.errors).toEqual([
      { line: 2, column: "hours_per_day", code: "history_locked", value: "p1@x.fr", params: { lockedThrough: "2026-10-20" } },
      { line: 4, column: "email", code: "duplicate_in_file", value: "p1@x.fr", params: { firstLine: 2 } },
    ]);
    expect(p.updates.map((u) => u.id)).toEqual(["2"]);
    const dep = plan("people", "name,email,department\nP1,p1@x.fr,Design\n", s);
    expect(dep.errors[0]).toMatchObject({ column: "department", code: "history_locked" });
    const role = plan("people", "name,email,role\nP1,p1@x.fr,Lead\n", s);
    expect(role.errors[0]).toMatchObject({ column: "role", code: "history_locked" });
    // Un autre champ (nom) reste modifiable.
    expect(plan("people", "name,email\nRenommée,p1@x.fr\n", s).updates).toEqual([{ line: 2, id: "1", changes: { name: "Renommée" } }]);
  });
  it("une personne sans e-mail en base n'est pas une clé", () => {
    const s = snap({ people: [person("1", { email: null, name: "A" })] });
    expect(plan("people", "name,email\nA,a@x.fr\n", s).creates).toHaveLength(1);
  });
});

describe("projets", () => {
  const s = snap({
    people: [person("1", { name: "Bob" }), person("2", { name: "Ann" }), person("3", { name: "ann", email: null })],
    projects: [project("1", { startDate: "2026-01-01", color: "#abcdef", clientId: "c1", projectManagerId: "1", tags: ["x"], notes: "n" })],
  });
  it("création : client existant ou à créer, chef de projet par e-mail ou par nom", () => {
    const p = plan("projects", "name,project_code,client,project_manager,billable,status,color,start_date,end_date,tags,notes\nN,C9,ACME,P1@x.fr,non,tentative,#000000,2026-01-01,2026-02-01,a,b\nM,C8,Globex,Bob,,,,,,,\n", s);
    expect(p.creates).toEqual([
      { line: 2, values: { name: "N", projectCode: "C9", client: { id: "c1" }, projectManagerId: "1", nonBillable: true, status: "tentative", color: "#000000",
        startDate: "2026-01-01", endDate: "2026-02-01", tags: ["a"], notes: "b" } satisfies ProjectWrite },
      { line: 3, values: { name: "M", projectCode: "C8", client: { create: "Globex" }, projectManagerId: "1" } },
    ]);
    expect(p.references.clients).toEqual(["Globex"]);
  });
  it("chef de projet inconnu ou ambigu : erreur, rien n'est créé (pas même le client)", () => {
    const p = plan("projects", "name,project_code,project_manager,client\nN,C9,inconnu@x.fr,Neuf\nM,C8,ANN,Neuf\nO,C7,Zed,\n", s);
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([[2, "unknown_reference"], [3, "ambiguous_reference"], [4, "unknown_reference"]]);
    expect([p.creates, p.references.clients, p.invalid]).toEqual([[], [], 3]);
  });
  it("client ambigu : erreur", () => {
    const amb = snap({ clients: [{ id: "c1", name: "Acme", shortName: null, tags: [] }, { id: "c2", name: "acme", shortName: null, tags: [] }] });
    expect(plan("projects", "name,project_code,client\nN,C9,ACME\n", amb).errors[0]).toMatchObject({ column: "client", code: "ambiguous_reference" });
  });
  it("mise à jour par project_code, couleur comparée sans casse, inchangé si tout est égal", () => {
    const same = plan("projects", "name,project_code,color,client,project_manager,start_date,tags,notes,billable,status\nProjet 1,C1,#ABCDEF,acme,Bob,2026-01-01,x,n,oui,planned\n", s);
    expect([same.unchanged, same.updates]).toEqual([1, []]);
    const p = plan("projects", "name,project_code,color,client,project_manager,start_date,end_date,tags,notes,billable,status\nAutre,C1,#000000,Globex,P2@x.fr,2026-02-01,2026-03-01,y,m,non,completed\n", s);
    expect(p.updates).toEqual([{ line: 2, id: "1", changes: {
      name: "Autre", color: "#000000", client: { create: "Globex" }, projectManagerId: "2", startDate: "2026-02-01", endDate: "2026-03-01",
      tags: ["y"], notes: "m", nonBillable: true, status: "completed",
    } satisfies ProjectWrite }]);
  });
  it("fin avant début, valeurs existantes comprises : invalid_date_range", () => {
    const p = plan("projects", "name,project_code,end_date\nProjet 1,C1,2025-12-31\nN,C2,2026-01-01\n", s);
    expect(p.errors).toEqual([{ line: 2, column: "end_date", code: "invalid_date_range", value: "2025-12-31", params: { startDate: "2026-01-01" } }]);
    expect(p.creates).toHaveLength(1);
    expect(plan("projects", "name,project_code,start_date,end_date\nN,C2,2026-02-01,2026-01-01\n", s).errors[0]!.code).toBe("invalid_date_range");
  });
});

describe("clients", () => {
  it("création, mise à jour (nom court, tags), inchangé, clé ambiguë", () => {
    const s = snap({ clients: [{ id: "c1", name: "Acme", shortName: "AC", tags: ["a"] }, { id: "c2", name: "Dup", shortName: null, tags: [] }, { id: "c3", name: "dup ", shortName: null, tags: [] }] });
    const p = plan("clients", "name,short_name,tags\nACME,AC,a\nacme corp,,\nAcme ,AX,b\nDUP,,\n", s);
    // « Acme » (ligne 2) et « Acme  » (ligne 4) ont la même clé : la seconde est un doublon du fichier.
    expect(p.unchanged).toBe(1);
    expect(p.creates).toEqual([{ line: 3, values: { name: "acme corp" } satisfies ClientWrite }]);
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([[4, "duplicate_in_file"], [5, "ambiguous_key"]]);
    const u = plan("clients", "name,short_name,tags\nacme,AX,b|c\n", s);
    expect(u.updates).toEqual([{ line: 2, id: "c1", changes: { shortName: "AX", tags: ["b", "c"] } }]);
    expect(plan("clients", "name,short_name,tags\nNew,N,t\n", s).creates).toEqual([{ line: 2, values: { name: "New", shortName: "N", tags: ["t"] } }]);
  });
});

describe("rapport", () => {
  it("compteurs, erreurs tronquées, fichier invalide = toutes les lignes invalides", () => {
    const p = plan("clients", "name,tags\nA,\n,x\n,y\n");
    expect(importReport(p, { dryRun: true, applied: false, maxErrors: 1 })).toEqual({
      kind: "clients", dryRun: true, applied: false, delimiter: ",", rows: 3, created: 1, updated: 0, unchanged: 0, invalid: 2,
      references: { departments: [], roles: [], clients: [] }, ignoredColumns: [], errors: [p.errors[0]], errorsTruncated: true,
    });
    expect(plan("clients", "Matricule\nA\nB\n")).toMatchObject({ rows: 2, invalid: 2, creates: [], ignoredColumns: ["Matricule"] });
  });
});

describe("propriété : idempotence", () => {
  it("appliquer le plan à l'état puis replanifier le même fichier : 0 création, 0 mise à jour", () => {
    const cell = fc.constantFrom("", "Design", "design", "Ops", "Lead", "7", "8", "a|b", "b|a", "FR", "contractor");
    const name = fc.constantFrom("A", "B", "C");
    const email = fc.constantFrom("a@x.fr", "B@x.fr", "p1@x.fr", "c@x.fr");
    fc.assert(fc.property(fc.array(fc.tuple(name, email, cell, cell, cell, cell), { maxLength: 10 }), (rows) => {
      const csv = `name,email,department,role,hours_per_day,tags\n${rows.map((r) => r.join(",")).join("\n")}`;
      const s0 = snap();
      const p = planImport(analyzeImport("people", csv), s0);
      // Application naïve du plan sur l'état (ce que fait l'API).
      const deps = [...s0.departments, ...p.references.departments.map((n, i) => ({ id: `nd${i}`, name: n }))];
      const roles = [...s0.roles, ...p.references.roles.map((n, i) => ({ id: `nr${i}`, name: n }))];
      const id = (list: { id: string; name: string }[], r: { id: string } | { create: string }) => ("id" in r ? r.id : list.find((x) => x.name.toLowerCase() === r.create.toLowerCase())!.id);
      const people = s0.people.map((x) => ({ ...x }));
      const apply = (target: ExistingPerson, w: PersonWrite) => Object.assign(target, {
        ...(w.name && { name: w.name }), ...(w.peopleType && { peopleType: w.peopleType }), ...(w.country && { country: w.country }),
        ...(w.workDaysHours && { workDaysHours: w.workDaysHours }), ...(w.tags && { tags: w.tags }),
        ...(w.department && { departmentId: id(deps, w.department) }), ...(w.role && { roleId: id(roles, w.role) }),
      });
      for (const c of p.creates) people.push(apply(person(`n${c.line}`, { email: c.values.email!, name: c.values.name! }), c.values));
      for (const u of p.updates) apply(people.find((x) => x.id === u.id)!, u.changes);
      const again = planImport(analyzeImport("people", csv), { ...s0, departments: deps, roles, people });
      expect([again.creates.length, again.updates.length]).toEqual([0, 0]);
      expect(again.references).toEqual({ departments: [], roles: [], clients: [] });
    }));
  });
});
