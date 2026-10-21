// Logique pure de l'écran Personnes (lot L-F2) : filtres de la liste, horaire hebdomadaire (7 valeurs, index 0 = lundi, affichage
// selon le début de semaine du compte), validation du formulaire, résumé de l'horaire, traduction des erreurs de l'API en clés de
// messages, droits d'écriture. Aucune dépendance à React : testable seule.
import type { Me } from "@wnext/contracts";
import type { DirError, Department, PeopleType, Person, Role } from "../data/people-source";
import type { MessageKey } from "../i18n";

export const PEOPLE_TYPES: readonly PeopleType[] = ["employee", "contractor", "placeholder"];
export const TYPE_KEY: Record<PeopleType, MessageKey> = {
  employee: "people.type.employee", contractor: "people.type.contractor", placeholder: "people.type.placeholder",
};
export const DEFAULT_HOURS: readonly number[] = [8, 8, 8, 8, 8, 0, 0];

/** Écriture sur les personnes : owner, admin et project_manager ; member et guest lisent. L'API reste seule juge (403). */
export const canEditPeople = (me: Me) => me.role === "owner" || me.role === "admin" || me.role === "project_manager";

// --- Filtres --------------------------------------------------------------------------------------------------------------
export type StateFilter = "active" | "inactive" | "all";
export interface PeopleFilters { search: string; departmentId: string; roleId: string; type: "" | PeopleType; state: StateFilter }
export const NO_PEOPLE_FILTERS: PeopleFilters = { search: "", departmentId: "", roleId: "", type: "", state: "active" };
/** Valeur du filtre équipe ou rôle pour « sans équipe », « sans rôle ». */
export const NONE = "none";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const matches = (filter: string, id: string | null) => !filter || (filter === NONE ? id === null : id === filter);

/** Liste filtrée et triée par nom (actives par défaut : les désactivées se demandent). */
export function filterPeople(people: readonly Person[], f: PeopleFilters): Person[] {
  const q = fold(f.search.trim());
  return people
    .filter((p) => {
      if (f.state === "active" ? !p.active : f.state === "inactive" ? p.active : false) return false;
      if (f.type && p.peopleType !== f.type) return false;
      if (!matches(f.departmentId, p.departmentId) || !matches(f.roleId, p.roleId)) return false;
      return !q || fold(p.name).includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export const refName = (list: readonly (Department | Role)[], id: string | null) => (id === null ? "" : (list.find((x) => x.id === id)?.name ?? ""));

// --- Horaire hebdomadaire -------------------------------------------------------------------------------------------------
/** Index ISO (0 = lundi) des 7 jours dans l'ordre d'affichage, en commençant par le jour de début de semaine du compte (1 = lundi ... 7). */
export function weekOrder(weekStart: number): number[] {
  const first = Math.min(7, Math.max(1, Math.trunc(weekStart) || 1)) - 1;
  return Array.from({ length: 7 }, (_, k) => (first + k) % 7);
}

/** Nom du jour d'un index ISO (0 = lundi), dans la langue de l'interface. */
export function weekdayName(index: number, locale: string, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + index))); // 2024-01-01 : lundi
}

/** Heures par semaine et nombre de jours travaillés. */
export function weeklySummary(hours: readonly number[]): { total: number; days: number } {
  return { total: Math.round(hours.reduce((s, h) => s + h, 0) * 100) / 100, days: hours.filter((h) => h > 0).length };
}

export const sameWeek = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((h, i) => h === b[i]);

/** Saisie d'un jour (texte, virgule ou point décimal) : nombre entre 0 et 24, sinon null. Vide = 0. */
export function parseHours(text: string): number | null {
  const s = text.trim().replace(",", ".");
  if (s === "") return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 24 ? Math.round(n * 100) / 100 : null;
}

/** Les 7 saisies (index ISO) en heures ; null si l'une est invalide. */
export function parseWeek(texts: readonly string[]): number[] | null {
  const out = texts.map(parseHours);
  return out.every((h): h is number => h !== null) ? out : null;
}

export const hoursTexts = (hours: readonly number[]): string[] => hours.map((h) => String(h));

// --- Formulaires ----------------------------------------------------------------------------------------------------------
export interface PersonValues {
  name: string;
  peopleType: PeopleType;
  departmentId: string; // "" = aucune
  roleId: string;
  country: string; // "" = aucun
  hours: string[]; // 7 saisies, index ISO
}
export type PersonField = "name" | "country" | "hours";
export type PersonErrors = Partial<Record<PersonField, MessageKey>>;

export const newPersonValues = (): PersonValues => ({ name: "", peopleType: "employee", departmentId: "", roleId: "", country: "", hours: hoursTexts(DEFAULT_HOURS) });
export const valuesOf = (p: Person): PersonValues => ({
  name: p.name, peopleType: p.peopleType, departmentId: p.departmentId ?? "", roleId: p.roleId ?? "", country: p.country ?? "", hours: hoursTexts(p.workDaysHours),
});

export function validatePerson(v: PersonValues): PersonErrors {
  const e: PersonErrors = {};
  if (!v.name.trim()) e.name = "people.form.error.name";
  if (v.country.trim() && !/^[A-Za-z]{2}$/.test(v.country.trim())) e.country = "people.form.error.country";
  if (!parseWeek(v.hours)) e.hours = "people.form.error.hours";
  return e;
}

export interface PersonChange {
  name?: string;
  peopleType?: PeopleType;
  departmentId?: string | null;
  roleId?: string | null;
  country?: string | null;
  workDaysHours?: number[];
}
/** Champs modifiés (PATCH n'envoie que ce qui change). `historized` : l'horaire, l'équipe ou le rôle change (modification datée, BR-19). */
export function diffOf(p: Person, v: PersonValues): { patch: PersonChange; historized: boolean } {
  const patch: PersonChange = {};
  if (v.name.trim() !== p.name) patch.name = v.name.trim();
  if (v.peopleType !== p.peopleType) patch.peopleType = v.peopleType;
  if ((v.departmentId || null) !== p.departmentId) patch.departmentId = v.departmentId || null;
  if ((v.roleId || null) !== p.roleId) patch.roleId = v.roleId || null;
  const country = v.country.trim().toUpperCase() || null;
  if (country !== p.country) patch.country = country;
  const hours = parseWeek(v.hours);
  if (hours && !sameWeek(hours, p.workDaysHours)) patch.workDaysHours = hours;
  return { patch, historized: "workDaysHours" in patch || "departmentId" in patch || "roleId" in patch };
}

/** Avatar : initiales des deux premiers mots du nom. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s.@_-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[1]!].map((w) => [...w][0]!) : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}

// --- Erreurs de l'API -----------------------------------------------------------------------------------------------------
export interface ErrorMessage { key: MessageKey; values?: Record<string, string> }
/** Message d'une erreur d'écriture. `day` met en forme une date ISO (dernier jour verrouillé de PERSON_HISTORY_LOCKED). */
export function errorOf(error: DirError, day: (iso: string) => string = (s) => s): ErrorMessage {
  switch (error.code) {
    case "PERSON_HISTORY_LOCKED": return { key: "people.error.history_locked", values: { date: day(String(error.params.lockedThrough ?? "")) } };
    case "VERSION_CONFLICT": return { key: "people.error.conflict" };
    case "FORBIDDEN": return { key: "people.error.forbidden" };
    case "ALREADY_EXISTS": return { key: "people.error.exists" };
    case "REFERENCE_IN_USE": return { key: "people.error.in_use" };
    case "VALIDATION_FAILED": return { key: "people.error.validation" };
    case "NOT_FOUND": return { key: "people.error.not_found" };
    case "UNAUTHENTICATED": return { key: "people.error.unauthenticated" };
    case "RATE_LIMITED": return { key: "people.error.rate_limited" };
    case "PERSON_DEACTIVATION_INVALID_REPLACEMENT": return { key: "people.error.replacement" };
    default: return { key: "people.error.other" };
  }
}

/** Exemple de code pays montré dans les champs « pays » (code ISO 3166-1 alpha-2, pas une chaîne traduisible). */
export const COUNTRY_EXAMPLE = "FR";
