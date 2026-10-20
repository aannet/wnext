// Analyseur CSV RFC 4180 (import simple, US-1.2) : exemples puis propriétés (fast-check) sur un sérialiseur de référence.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";

const fields = (text: string) => parseCsv(text).records.map((r) => r.fields);

describe("parseCsv : exemples", () => {
  it("virgule, LF, champs simples", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual({ delimiter: ",", records: [{ line: 1, fields: ["a", "b"] }, { line: 2, fields: ["1", "2"] }], unterminatedAt: null });
  });
  it("point-virgule détecté sur l'en-tête (export Excel FR), CRLF, BOM", () => {
    const r = parseCsv("﻿Nom;E-mail\r\nAlice;a@x.fr\r\n");
    expect(r.delimiter).toBe(";");
    expect(r.records.map((x) => x.fields)).toEqual([["Nom", "E-mail"], ["Alice", "a@x.fr"]]);
  });
  it("séparateur : celui qui apparaît le plus hors guillemets ; égalité ou aucun : virgule", () => {
    expect(parseCsv('"a;b;c",d').delimiter).toBe(",");
    expect(parseCsv("a;b,c;d").delimiter).toBe(";");
    expect(parseCsv("a,b;c").delimiter).toBe(",");
    expect(parseCsv("seul").delimiter).toBe(",");
    expect(parseCsv("").delimiter).toBe(",");
  });
  it("guillemets : séparateur, saut de ligne et guillemet doublé dans un champ", () => {
    expect(fields('a,"b,1","c ""q""","d\r\ne"\n')).toEqual([["a", "b,1", 'c "q"', "d\r\ne"]]);
  });
  it("numéro de ligne = ligne physique de début d'enregistrement (saut dans un champ compté)", () => {
    const r = parseCsv('h1,h2\n"x\ny",1\n\nz,2\rw,3');
    expect(r.records.map((x) => [x.line, x.fields])).toEqual([[1, ["h1", "h2"]], [2, ["x\ny", "1"]], [5, ["z", "2"]], [6, ["w", "3"]]]);
  });
  it("lignes vides ignorées, dernier saut de ligne facultatif, champs vides conservés", () => {
    expect(fields("\n\na,,b\n\n,\n")).toEqual([["a", "", "b"], ["", ""]]);
    expect(fields("a,b")).toEqual([["a", "b"]]);
  });
  it("guillemet au milieu d'un champ non cité : littéral ; texte après un guillemet fermant : conservé", () => {
    expect(fields('ab"c,"d"e\n')).toEqual([['ab"c', "de"]]);
  });
  it("guillemet non fermé : enregistrement abandonné, ligne de début signalée", () => {
    const r = parseCsv('a,b\n1,"oups\n2,3\n');
    expect(r.records.map((x) => x.fields)).toEqual([["a", "b"]]);
    expect(r.unterminatedAt).toBe(2);
  });
  it("champ cité vide et enregistrement réduit à un champ cité vide", () => {
    expect(fields('"",a\n""\n')).toEqual([["", "a"], [""]]);
  });
});

// Sérialiseur de référence RFC 4180 : cite un champ s'il contient un séparateur possible, un guillemet ou un saut de ligne.
const quote = (f: string) => (/[",;\r\n]/.test(f) || f === "" ? `"${f.replace(/"/g, '""')}"` : f);
const field = fc.string({ unit: fc.constantFrom("a", "é", " ", ",", ";", '"', "\n", "\r", "x", "1", "€", "\t"), maxLength: 8 });
const table = fc.array(fc.array(field, { minLength: 2, maxLength: 5 }), { minLength: 1, maxLength: 8 });

describe("parseCsv : propriétés", () => {
  it("relit exactement ce que le sérialiseur écrit (séparateur, fin de ligne, BOM, dernier saut quelconques)", () => {
    fc.assert(fc.property(table, fc.constantFrom(",", ";"), fc.constantFrom("\n", "\r\n", "\r"), fc.boolean(), fc.boolean(), (rows, sep, eol, bom, trailing) => {
      const text = (bom ? "﻿" : "") + rows.map((r) => r.map(quote).join(sep)).join(eol) + (trailing ? eol : "");
      const parsed = parseCsv(text);
      expect(parsed.unterminatedAt).toBeNull();
      expect(parsed.delimiter).toBe(sep);
      expect(parsed.records.map((r) => r.fields)).toEqual(rows);
    }));
  });
  it("numéros de ligne = 1 + sauts de ligne avant le début de l'enregistrement", () => {
    fc.assert(fc.property(table, fc.constantFrom("\n", "\r\n"), (rows, eol) => {
      const serialized = rows.map((r) => r.map(quote).join(","));
      const expected: number[] = [];
      let line = 1;
      for (const s of serialized) {
        expected.push(line);
        line += (s.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
      }
      expect(parseCsv(serialized.join(eol)).records.map((r) => r.line)).toEqual(expected);
    }));
  });
  it("ne lève jamais d'exception et ne renvoie jamais d'enregistrement vide, quel que soit le texte", () => {
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom("a", ",", ";", '"', "\n", "\r", "﻿", " "), maxLength: 40 }), (text) => {
      const r = parseCsv(text);
      for (const rec of r.records) expect(rec.fields.length).toBeGreaterThan(0);
      expect(r.records.every((rec, i) => i === 0 || rec.line > r.records[i - 1]!.line)).toBe(true);
    }));
  });
});
