// Filtres d'une vue du Schedule, appliqués côté client sur les lignes (personnes) déjà chargées (contrat : ScheduleViewFilters).
//  * ET entre les filtres, OU dans une liste ; un filtre absent ou vide ne filtre rien.
//  * `projectIds` : personnes ayant au moins une allocation à l'un de ces projets dans les données chargées.
//  * Les allocations et congés des personnes écartées sont retirés avec elles (le moteur de grille ne dessine que les lignes gardées).
//  * `peopleSort` : « name » (défaut) garde l'ordre du magasin (par nom) ; « department » et « role » trient par le nom du
//    département ou du rôle (sans valeur en dernier), à égalité l'ordre par nom est conservé (tri stable).
import type { ScheduleResponse, ScheduleViewFilters } from "@wnext/contracts";

export type ViewFilters = ScheduleViewFilters;

const has = (list: readonly string[] | undefined) => (list && list.length ? new Set(list) : null);

/** Nombre de critères de filtrage actifs (listes non vides), pour l'affichage et « vue modifiée ». */
export function activeFilterCount(f: ViewFilters): number {
  return [f.departmentIds, f.roleIds, f.projectIds, f.personIds, f.tags].filter((l) => l && l.length).length;
}

/** Forme canonique (listes vides retirées, identifiants triés) : deux filtres équivalents ont la même forme. */
export function normalizeFilters(f: ViewFilters): ViewFilters {
  const out: ViewFilters = {};
  const list = (k: "departmentIds" | "roleIds" | "projectIds" | "personIds" | "tags") => { const v = f[k]; if (v && v.length) out[k] = [...new Set(v)].sort(); };
  list("departmentIds"); list("roleIds"); list("projectIds"); list("personIds"); list("tags");
  if (f.zoom) out.zoom = f.zoom;
  if (f.peopleSort && f.peopleSort !== "name") out.peopleSort = f.peopleSort;
  return out;
}

export const sameFilters = (a: ViewFilters, b: ViewFilters) => JSON.stringify(normalizeFilters(a)) === JSON.stringify(normalizeFilters(b));

export function applyViewFilters(data: ScheduleResponse, filters: ViewFilters): ScheduleResponse {
  const departments = has(filters.departmentIds);
  const roles = has(filters.roleIds);
  const persons = has(filters.personIds);
  const tags = has(filters.tags);
  const projects = has(filters.projectIds);
  const sort = filters.peopleSort && filters.peopleSort !== "name" ? filters.peopleSort : null;
  if (!departments && !roles && !persons && !tags && !projects && !sort) return data;

  const onProject = projects ? new Set(data.allocations.filter((a) => projects.has(a.projectId)).map((a) => a.personId)) : null;
  let people = data.people.filter((p) =>
    (!departments || (p.departmentId !== null && departments.has(p.departmentId)))
    && (!roles || (p.roleId !== null && roles.has(p.roleId)))
    && (!persons || persons.has(p.id))
    && (!tags || p.tags.some((t) => tags.has(t)))
    && (!onProject || onProject.has(p.id)));
  if (sort) {
    const names = new Map((sort === "department" ? data.departments : data.roles).map((x) => [x.id, x.name]));
    const key = (p: (typeof people)[number]) => names.get((sort === "department" ? p.departmentId : p.roleId) ?? "") ?? null;
    const collator = new Intl.Collator("fr", { sensitivity: "base" });
    people = [...people].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka === kb ? 0 : ka === null ? 1 : kb === null ? -1 : collator.compare(ka, kb);
    });
  }
  const kept = new Set(people.map((p) => p.id));
  return {
    ...data, people,
    allocations: data.allocations.filter((a) => kept.has(a.personId)),
    timeoffs: data.timeoffs.filter((t) => kept.has(t.personId)),
  };
}
