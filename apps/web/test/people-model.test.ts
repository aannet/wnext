import type { Me } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import type { Person } from "../src/data/people-source";
import {
  canEditPeople, diffOf, errorOf, filterPeople, initialsOf, NONE, NO_PEOPLE_FILTERS, newPersonValues, parseHours, parseWeek, validatePerson, valuesOf, weekdayName,
  weekOrder, weeklySummary,
} from "../src/people/people-model";
import { countriesOf, holidayInputOf, holidaysOf, NO_COUNTRY, validateHoliday } from "../src/settings/settings-model";

const person = (over: Partial<Person> = {}): Person => ({
  id: "1", version: 1, name: "Léa Martin", peopleType: "employee", departmentId: "d1", roleId: "r1", country: "FR", tags: [], avatarUrl: null, active: true,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], ...over,
});

describe("horaire hebdomadaire : stockage ISO (0 = lundi), affichage selon week_start", () => {
  it("l'ordre d'affichage commence au jour de début de semaine du compte", () => {
    expect(weekOrder(1)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekOrder(7)).toEqual([6, 0, 1, 2, 3, 4, 5]); // semaine commençant le dimanche (index ISO 6)
    expect(weekOrder(3)).toEqual([2, 3, 4, 5, 6, 0, 1]);
    expect(weekOrder(0)).toEqual(weekOrder(1)); // valeur invalide : lundi
  });

  it("nomme les jours d'après l'index ISO, dans la langue de l'interface", () => {
    expect(weekdayName(0, "fr")).toBe("lundi");
    expect(weekdayName(6, "fr")).toBe("dimanche");
    expect(weekdayName(0, "en")).toBe("Monday");
    expect(weekdayName(4, "en", "short")).toBe("Fri");
  });

  it("résume en heures par semaine et jours travaillés", () => {
    expect(weeklySummary([8, 8, 8, 8, 8, 0, 0])).toEqual({ total: 40, days: 5 });
    expect(weeklySummary([7.5, 7.5, 7.5, 7.5, 0, 0, 0])).toEqual({ total: 30, days: 4 });
  });

  it("lit les heures : virgule ou point, vide = 0, hors 0-24 ou non numérique refusé", () => {
    expect(parseHours("7,5")).toBe(7.5);
    expect(parseHours(" 8 ")).toBe(8);
    expect(parseHours("")).toBe(0);
    expect(parseHours("24")).toBe(24);
    expect(parseHours("24,5")).toBeNull();
    expect(parseHours("-1")).toBeNull();
    expect(parseHours("huit")).toBeNull();
    expect(parseWeek(["8", "8", "8", "8", "8", "", ""])).toEqual([8, 8, 8, 8, 8, 0, 0]);
    expect(parseWeek(["8", "8", "8", "8", "x", "", ""])).toBeNull();
  });
});

describe("liste filtrée", () => {
  const list = [
    person({ id: "1", name: "Élodie Durand", departmentId: "d1", roleId: "r1" }),
    person({ id: "2", name: "Bruno Petit", departmentId: null, roleId: "r2", peopleType: "contractor" }),
    person({ id: "3", name: "Alice Roux", departmentId: "d2", roleId: null, peopleType: "placeholder", active: false }),
  ];
  const names = (f: Partial<typeof NO_PEOPLE_FILTERS>) => filterPeople(list, { ...NO_PEOPLE_FILTERS, ...f }).map((p) => p.name);

  it("n'affiche que les actives par défaut, triées par nom", () => {
    expect(names({})).toEqual(["Bruno Petit", "Élodie Durand"]);
    expect(names({ state: "inactive" })).toEqual(["Alice Roux"]);
    expect(names({ state: "all" })).toEqual(["Alice Roux", "Bruno Petit", "Élodie Durand"]);
  });

  it("filtre par équipe (département), rôle, type ; « aucun » cible les champs vides", () => {
    expect(names({ departmentId: "d1" })).toEqual(["Élodie Durand"]);
    expect(names({ departmentId: NONE })).toEqual(["Bruno Petit"]);
    expect(names({ roleId: "r2" })).toEqual(["Bruno Petit"]);
    expect(names({ state: "all", roleId: NONE })).toEqual(["Alice Roux"]);
    expect(names({ type: "contractor" })).toEqual(["Bruno Petit"]);
  });

  it("recherche sans accent ni casse", () => {
    expect(names({ search: "elodie" })).toEqual(["Élodie Durand"]);
    expect(names({ search: "  PETIT " })).toEqual(["Bruno Petit"]);
    expect(names({ search: "zzz" })).toEqual([]);
  });
});

describe("formulaire", () => {
  it("la création demande le nom ; l'horaire par défaut est 8 h du lundi au vendredi", () => {
    const v = newPersonValues();
    expect(v.hours).toEqual(["8", "8", "8", "8", "8", "0", "0"]);
    expect(validatePerson(v)).toEqual({ name: "people.form.error.name" });
    expect(validatePerson({ ...v, name: "Ada" })).toEqual({});
  });

  it("refuse un pays qui n'a pas deux lettres et un jour hors 0-24", () => {
    const v = { ...newPersonValues(), name: "Ada" };
    expect(validatePerson({ ...v, country: "FRA" })).toEqual({ country: "people.form.error.country" });
    expect(validatePerson({ ...v, country: "fr" })).toEqual({});
    expect(validatePerson({ ...v, hours: ["8", "8", "8", "8", "25", "0", "0"] })).toEqual({ hours: "people.form.error.hours" });
  });

  it("ne compare que ce qui change ; horaire, équipe et rôle sont des modifications datées (BR-19)", () => {
    const p = person();
    expect(diffOf(p, valuesOf(p))).toEqual({ patch: {}, historized: false });
    expect(diffOf(p, { ...valuesOf(p), name: " Léa Durand " })).toEqual({ patch: { name: "Léa Durand" }, historized: false });
    expect(diffOf(p, { ...valuesOf(p), country: "be" })).toEqual({ patch: { country: "BE" }, historized: false });
    const hours = ["8", "8", "8", "8", "0", "0", "0"];
    expect(diffOf(p, { ...valuesOf(p), hours })).toEqual({ patch: { workDaysHours: [8, 8, 8, 8, 0, 0, 0] }, historized: true });
    expect(diffOf(p, { ...valuesOf(p), departmentId: "" })).toEqual({ patch: { departmentId: null }, historized: true });
    expect(diffOf(p, { ...valuesOf(p), roleId: "r9" })).toEqual({ patch: { roleId: "r9" }, historized: true });
  });

  it("initiales d'avatar", () => {
    expect(initialsOf("Léa Martin")).toBe("LM");
    expect(initialsOf("prenom.nom@x.test")).toBe("PN");
    expect(initialsOf("Madonna")).toBe("MA");
  });
});

describe("erreurs de l'API traduites et droits", () => {
  it("PERSON_HISTORY_LOCKED porte le dernier jour verrouillé", () => {
    expect(errorOf({ code: "PERSON_HISTORY_LOCKED", params: { lockedThrough: "2026-09-30" } }, (d) => `le ${d}`)).toEqual({ key: "people.error.history_locked", values: { date: "le 2026-09-30" } });
  });
  it("chaque code connu a son message, les autres retombent sur le message générique", () => {
    expect(errorOf({ code: "FORBIDDEN", params: {} }).key).toBe("people.error.forbidden");
    expect(errorOf({ code: "VERSION_CONFLICT", params: {} }).key).toBe("people.error.conflict");
    expect(errorOf({ code: "REFERENCE_IN_USE", params: {} }).key).toBe("people.error.in_use");
    expect(errorOf({ code: "ALREADY_EXISTS", params: {} }).key).toBe("people.error.exists");
    expect(errorOf({ code: "PERSON_DEACTIVATION_INVALID_REPLACEMENT", params: {} }).key).toBe("people.error.replacement");
    expect(errorOf({ code: "INTERNAL_ERROR", params: {} }).key).toBe("people.error.other");
  });
  it("écriture : owner, admin, project_manager ; member et guest lisent", () => {
    const as = (role: Me["role"]) => canEditPeople({ role } as Me);
    expect([as("owner"), as("admin"), as("project_manager")]).toEqual([true, true, true]);
    expect([as("member"), as("guest")]).toEqual([false, false]);
  });
});

describe("jours fériés (réglages)", () => {
  const h = (id: string, name: string, date: string, country: string | null) => ({ id, version: 1, name, date, country, departmentId: null, hoursOff: null });
  const list = [h("1", "Noël", "2026-12-25", "FR"), h("2", "Fête nationale", "2026-07-14", "FR"), h("3", "Thanksgiving", "2026-11-26", "US"), h("4", "Fermeture", "2026-12-31", null)];
  it("filtre par pays, trie par date, liste les pays présents", () => {
    expect(holidaysOf(list, "FR").map((x) => x.name)).toEqual(["Fête nationale", "Noël"]);
    expect(holidaysOf(list, NO_COUNTRY).map((x) => x.name)).toEqual(["Fermeture"]);
    expect(holidaysOf(list, "").map((x) => x.id)).toEqual(["2", "3", "1", "4"]);
    expect(countriesOf(list)).toEqual(["FR", "US"]);
  });
  it("valide nom, date, pays et heures chômées", () => {
    expect(validateHoliday({ name: "", date: "", country: "FRA", hoursOff: "30" })).toEqual({
      name: "settings.holidays.error.name", date: "settings.holidays.error.date", country: "settings.holidays.error.country", hoursOff: "settings.holidays.error.hours",
    });
    expect(validateHoliday({ name: "X", date: "2026-02-30", country: "", hoursOff: "" }).date).toBeDefined();
    expect(validateHoliday({ name: "X", date: "2026-13-45", country: "", hoursOff: "" }).date).toBeDefined();
    expect(validateHoliday({ name: "X", date: "2026-02-28", country: "", hoursOff: "" })).toEqual({});
    expect(holidayInputOf({ name: " X ", date: "2026-05-01", country: "fr", hoursOff: "3,5" })).toEqual({ name: "X", date: "2026-05-01", country: "FR", hoursOff: 3.5 });
    expect(holidayInputOf({ name: "X", date: "2026-05-01", country: "", hoursOff: "" })).toEqual({ name: "X", date: "2026-05-01", country: null, hoursOff: null });
  });
});
