// Modèle de la palette de recherche du Planning (RT-038) : filtre côté client, sans casse ni accents, sur les listes déjà
// chargées (personnes de la réponse du Schedule, projets du compte). Logique pure : l'interface est dans search-ui.
//  * Tous les mots tapés doivent se retrouver dans le nom, dans n'importe quel ordre.
//  * Ordre : nom qui commence par le premier mot, puis début d'un mot du nom, puis le reste ; à égalité, ordre alphabétique.
//  * Requête vide : les premiers de chaque groupe. Groupes vides omis.
export interface SearchPerson { id: string; name: string }
export interface SearchProject { id: string; name: string; color: string | null }

export type SearchItem =
  | { kind: "person"; key: string; id: string; name: string; /** Écartée par les filtres du Planning : la choisir les retire. */ hidden: boolean }
  | { kind: "project"; key: string; id: string; name: string; color: string | null };

export interface SearchGroup { kind: "people" | "projects"; items: SearchItem[] }

export interface SearchInput {
  people: readonly SearchPerson[];
  projects: readonly SearchProject[];
  /** Personnes qui ne sont pas dans les lignes affichées (filtres actifs). */
  hiddenIds: ReadonlySet<string>;
  query: string;
  /** Plafond par groupe (défaut 8). */
  limit?: number;
}

export const SEARCH_LIMIT = 8;

export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

function ranked<T extends { name: string }>(list: readonly T[], tokens: string[], limit: number): T[] {
  const first = tokens[0];
  const scored: { item: T; rank: number; folded: string }[] = [];
  for (const item of list) {
    const folded = fold(item.name);
    if (!tokens.every((t) => folded.includes(t))) continue;
    const rank = !first || folded.startsWith(first) ? 0 : folded.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(first)) ? 1 : 2;
    scored.push({ item, rank, folded });
  }
  scored.sort((a, b) => a.rank - b.rank || (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.item);
}

export function searchEntries({ people, projects, hiddenIds, query, limit = SEARCH_LIMIT }: SearchInput): SearchGroup[] {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  const groups: SearchGroup[] = [
    { kind: "people", items: ranked(people, tokens, limit).map((p) => ({ kind: "person" as const, key: `person:${p.id}`, id: p.id, name: p.name, hidden: hiddenIds.has(p.id) })) },
    { kind: "projects", items: ranked(projects, tokens, limit).map((p) => ({ kind: "project" as const, key: `project:${p.id}`, id: p.id, name: p.name, color: p.color })) },
  ];
  return groups.filter((g) => g.items.length > 0);
}
