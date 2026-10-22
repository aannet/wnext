// Modèle de la palette de recherche du Planning (RT-038) : filtre côté client, sans casse ni accents, sur les listes déjà
// chargées (personnes de la réponse du Schedule, projets du compte). Logique pure : l'interface est dans search-ui.
//  * Tous les mots tapés doivent se retrouver dans le nom, dans n'importe quel ordre.
//  * Ordre : nom exact (normalisé), puis nom qui commence par la requête entière (« personne 2 » : Personne 20 avant Personne 102),
//    puis par son premier mot, puis début d'un mot du nom, puis le reste ; à rang égal, nom le plus court, puis ordre naturel
//    (Intl.Collator numérique : 2 avant 10) ; requête vide : ordre naturel seul.
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

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function ranked<T extends { name: string }>(list: readonly T[], tokens: string[], limit: number): T[] {
  const first = tokens[0];
  const whole = tokens.join(" ");
  const scored: { item: T; rank: number; folded: string }[] = [];
  for (const item of list) {
    const folded = fold(item.name);
    if (!tokens.every((t) => folded.includes(t))) continue;
    const squeezed = folded.split(/\s+/).filter(Boolean).join(" ");
    const rank = !first ? 2
      : squeezed === whole ? 0
      : squeezed.startsWith(whole) ? 1
      : folded.startsWith(first) ? 2
      : folded.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(first)) ? 3 : 4;
    scored.push({ item, rank, folded });
  }
  scored.sort((a, b) => a.rank - b.rank || (first ? a.folded.length - b.folded.length : 0) || collator.compare(a.folded, b.folded));
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
