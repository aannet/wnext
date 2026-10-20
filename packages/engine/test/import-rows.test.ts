// Import CSV simple (US-1.2), analyse : en-têtes FR/EN tolérants, validation par cellule, codes d'erreur stables par ligne.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeImport, normalizeHeader } from "../src/import-rows";

const codes = (csv: string, kind: "people" | "projects" | "clients" = "people") =>
  analyzeImport(kind, csv).errors.map((e) => [e.line, e.column, e.code]);

describe("en-têtes", () => {
  it("français, accents, casse et ponctuation ignorés ; séparateur ; ; colonnes inconnues listées", () => {
    const a = analyzeImport("people", "﻿Nom;E-mail;Département;Rôle;Type;Pays;Heures/jour;Étiquettes;Matricule\r\nAlice Martin;Alice@X.fr;Design;Lead;Prestataire;fr;7,5;a|b|a;42\r\n");
    expect(a).toMatchObject({ delimiter: ";", rows: 1, errors: [], ignoredColumns: ["Matricule"], fatal: false });
    expect(a.valid).toEqual([{ line: 2, values: {
      name: "Alice Martin", email: "alice@x.fr", department: "Design", role: "Lead", peopleType: "contractor", country: "FR", hoursPerDay: 7.5, tags: ["a", "b"],
    } }]);
  });
  it("anglais, ordre quelconque", () => {
    const a = analyzeImport("projects", "Project Code,Name,Client,Colour,Start date,End date,Status,Project manager,Billable,Tags,Notes\nP-1,Site,ACME,3b82f6,01/02/2026,2026-03-31,En cours,bob@x.fr,non,x,hello\n");
    expect(a.errors).toEqual([]);
    expect(a.valid[0]!.values).toEqual({
      projectCode: "P-1", name: "Site", client: "ACME", color: "#3B82F6", startDate: "2026-02-01", endDate: "2026-03-31", status: "in_progress",
      projectManager: "bob@x.fr", nonBillable: true, tags: ["x"], notes: "hello",
    });
  });
  it("clients : « Client » = nom, nom court", () => {
    expect(analyzeImport("clients", "Client,Sigle\nAcme Corp,AC\n").valid).toEqual([{ line: 2, values: { name: "Acme Corp", shortName: "AC" } }]);
  });
  it("colonne requise absente, colonne en double : erreurs de fichier (ligne 1), aucune ligne exploitable", () => {
    const a = analyzeImport("people", "Nom,Courriel,Mail\nA,a@x.fr,b@x.fr\n");
    expect(a.fatal).toBe(true);
    expect(a.errors).toEqual([{ line: 1, column: "email", code: "duplicate_column", value: "Mail", params: {} }]);
    expect(a.rows).toBe(1);
    expect(a.valid).toEqual([]);
    expect(codes("Nom\nA\n", "people")).toEqual([[1, "email", "missing_column"]]);
    expect(codes("name\nA\n", "projects")).toEqual([[1, "project_code", "missing_column"]]);
  });
  it("fichier vide ou guillemet non fermé dès l'en-tête", () => {
    expect(analyzeImport("clients", "\n\n")).toMatchObject({ rows: 0, fatal: true, errors: [{ line: 1, code: "empty_file" }] });
    expect(analyzeImport("clients", '"nom\n')).toMatchObject({ rows: 0, fatal: true, errors: [{ line: 1, code: "unterminated_quote" }] });
  });
  it("normalizeHeader", () => {
    expect(normalizeHeader(" Date de début ")).toBe("datededebut");
    expect(normalizeHeader("E-MAIL")).toBe("email");
  });
});

describe("validation par ligne", () => {
  const people = (rows: string) => `name,email,type,country,hours_per_day,tags,department\n${rows}`;
  it("requis, e-mail, énumération, pays, nombre : une erreur par cellule fautive, valeur recopiée", () => {
    const a = analyzeImport("people", people(",pas-un-mail,chef,FRA,25,,\nB,b@x.fr,,,-1,,\nC,c@x.fr,fictif,be,0,,\n"));
    expect(a.errors).toEqual([
      { line: 2, column: "name", code: "required", value: null, params: {} },
      { line: 2, column: "email", code: "invalid_email", value: "pas-un-mail", params: {} },
      { line: 2, column: "type", code: "invalid_enum", value: "chef", params: {} },
      { line: 2, column: "country", code: "invalid_country", value: "FRA", params: {} },
      { line: 2, column: "hours_per_day", code: "invalid_number", value: "25", params: { min: 0, max: 24 } },
      { line: 3, column: "hours_per_day", code: "invalid_number", value: "-1", params: { min: 0, max: 24 } },
    ]);
    expect(a.valid).toEqual([{ line: 4, values: { name: "C", email: "c@x.fr", peopleType: "placeholder", country: "BE", hoursPerDay: 0 } }]);
  });
  it("longueurs et tags", () => {
    const long = "x".repeat(201);
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`).join("|");
    expect(codes(people(`${long},a@x.fr,,,,,\nB,b@x.fr,,,,${"y".repeat(51)},\nC,c@x.fr,,,,${many},\n`))).toEqual([
      [2, "name", "too_long"], [3, "tags", "too_long"], [4, "tags", "too_many_tags"],
    ]);
    expect(analyzeImport("people", people(`${"z".repeat(300)},a@x.fr,,,,,\n`)).errors[0]!.value).toHaveLength(200);
    expect(codes(people(`A,${"a".repeat(250)}@x.fr,,,,,\n`))).toEqual([[2, "email", "too_long"]]);
  });
  it("dates, couleur, booléen, statut", () => {
    const head = "name,project_code,start_date,end_date,color,billable,status\n";
    expect(codes(`${head}A,1,31/02/2026,2026-13-01,#12345,peut-être,fini\nB,2,2026-2-1,,,,\n`, "projects")).toEqual([
      [2, "start_date", "invalid_date"], [2, "end_date", "invalid_date"], [2, "color", "invalid_color"], [2, "billable", "invalid_boolean"],
      [2, "status", "invalid_enum"], [3, "start_date", "invalid_date"],
    ]);
    const ok = analyzeImport("projects", `${head}A,1,5/3/2026,,#abcdef,oui,Terminé\n`);
    expect(ok.valid[0]!.values).toEqual({ name: "A", projectCode: "1", startDate: "2026-03-05", color: "#ABCDEF", nonBillable: false, status: "completed" });
  });
  it("trop de champs non vides : field_count ; champs manquants = vides ; champs en trop vides tolérés", () => {
    expect(codes("name\nA,B\nC,\n", "clients")).toEqual([[2, null, "field_count"]]);
    expect(analyzeImport("clients", "name,short_name,tags\nA\n").valid).toEqual([{ line: 2, values: { name: "A" } }]);
    expect(analyzeImport("clients", "name;short_name\n;\n ; \nB;\n")).toMatchObject({ rows: 1, errors: [], valid: [{ line: 4 }] });
  });
  it("clé en double dans le fichier : la seconde ligne en erreur, avec la première", () => {
    const a = analyzeImport("people", "name,email\nA,a@x.fr\nA bis,A@X.FR\n");
    expect(a.errors).toEqual([{ line: 3, column: "email", code: "duplicate_in_file", value: "a@x.fr", params: { firstLine: 2 } }]);
    expect(codes("name\nAcme\n acme \n", "clients")).toEqual([[3, "name", "duplicate_in_file"]]);
    expect(codes("name,project_code\nA,p1\nB,P1\nC,p1\n", "projects")).toEqual([[4, "project_code", "duplicate_in_file"]]);
  });
  it("guillemet non fermé : l'enregistrement est compté et signalé, les précédents restent valides", () => {
    const a = analyzeImport("clients", 'name\nA\n"B\n');
    expect(a.rows).toBe(2);
    expect(a.valid.map((v) => v.line)).toEqual([2]);
    expect(a.errors).toEqual([{ line: 3, column: null, code: "unterminated_quote", value: null, params: {} }]);
  });
});

describe("propriétés", () => {
  it("toute ligne de données est soit valide soit en erreur (jamais les deux) ; lignes valides uniques par clé", () => {
    const cell = fc.constantFrom("", "", "", "A", "a@x.fr", "b@x.fr", "x", "8", "30", "employee", "fr");
    fc.assert(fc.property(fc.array(fc.tuple(cell, cell, cell, cell), { maxLength: 40 }), (rows) => {
      const csv = `name,email,hours_per_day,type\n${rows.map((r) => r.join(",")).join("\n")}`;
      const a = analyzeImport("people", csv);
      const errLines = new Set(a.errors.map((e) => e.line));
      for (const v of a.valid) expect(errLines.has(v.line)).toBe(false);
      expect(new Set(a.valid.map((v) => v.values.email)).size).toBe(a.valid.length);
      const blank = rows.filter((r) => r.every((c) => c === "")).length;
      expect(a.rows).toBe(rows.length - blank);
    }));
  });
});
