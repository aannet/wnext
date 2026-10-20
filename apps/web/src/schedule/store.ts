// Magasin client du Schedule, pur et sans framework : fusionne les fenêtres chargées (GET /schedule, par blocs de
// viewport.loadChunks), applique le flux temps réel (références seules : entité, id, version, ADR-003 §5) et porte les
// mutations optimistes (ADR-002 §5 : aucune attente visible, échec = retour arrière).
//  * Une entité n'est remplacée que par une version strictement plus récente : l'ordre d'arrivée (fenêtre en retard,
//    changement en avance) ne fait jamais reculer l'état.
//  * Une suppression laisse une pierre tombale : un chargement tardif ne ressuscite pas l'entité (ids jamais réutilisés).
//  * Un changement plus récent que l'état local donne une entité à recharger (GET par id) ; le magasin ne fait aucun appel.
//  * Les entités hors Schedule (clients, tâches, jalons, équipe) sont rendues telles quelles à l'appelant. Les phases
//    (BR-37, avertissement de dates) en font partie depuis qu'elles sont transportées par GET /schedule.
import type { Change, ChangeEntity, ScheduleResponse } from "@wnext/contracts";

type Row<K extends keyof ScheduleResponse> = NonNullable<ScheduleResponse[K]> extends readonly (infer T)[] ? T : never;

interface Entities {
  people: Row<"people">;
  allocations: Row<"allocations">;
  timeoffs: Row<"timeoffs">;
  holidays: Row<"holidays">;
  projects: Row<"projects">;
  phases: Row<"phases">;
  timeoff_types: Row<"timeoffTypes">;
  departments: Row<"departments">;
  roles: Row<"roles">;
}
export type Kind = keyof Entities;
export type EntityOf<K extends Kind> = Entities[K] & { id: string; version: number };
export type Tables = { readonly [K in Kind]: ReadonlyMap<string, EntityOf<K>> };

const KINDS: readonly Kind[] = ["people", "allocations", "timeoffs", "holidays", "projects", "phases", "timeoff_types", "departments", "roles"];
const FIELD: Record<Kind, keyof ScheduleResponse> = {
  people: "people", allocations: "allocations", timeoffs: "timeoffs", holidays: "holidays", projects: "projects", phases: "phases",
  timeoff_types: "timeoffTypes", departments: "departments", roles: "roles",
};

interface Pending { kind: Kind; id: string; before: unknown; after: unknown }

export interface ScheduleStore {
  tables: Tables;
  account: ScheduleResponse["account"] | null;
  /** Fenêtres déjà chargées (clé = `from..to`). */
  windows: ReadonlySet<string>;
  /** Entités supprimées (`kind:id`) : jamais réinsérées. */
  tombstones: ReadonlySet<string>;
  pending: ReadonlyMap<string, Pending>;
}

export const emptyStore = (): ScheduleStore => ({
  tables: Object.fromEntries(KINDS.map((k) => [k, new Map()])) as unknown as Tables,
  account: null, windows: new Set(), tombstones: new Set(), pending: new Map(),
});

export const isKind = (e: ChangeEntity): e is Kind => (KINDS as readonly string[]).includes(e);
const tomb = (kind: Kind, id: string) => `${kind}:${id}`;

function withTable<K extends Kind>(s: ScheduleStore, kind: K, f: (m: Map<string, EntityOf<K>>) => void): ScheduleStore {
  const m = new Map(s.tables[kind] as ReadonlyMap<string, EntityOf<K>>);
  f(m);
  return { ...s, tables: { ...s.tables, [kind]: m } };
}

/** Insère ou remplace si la version est strictement plus récente (ou l'entité absente) ; ignore une entité supprimée. */
export function upsert<K extends Kind>(s: ScheduleStore, kind: K, e: EntityOf<K>): ScheduleStore {
  const cur = s.tables[kind].get(e.id) as EntityOf<K> | undefined;
  if (s.tombstones.has(tomb(kind, e.id)) || (cur && cur.version >= e.version)) return s;
  return withTable(s, kind, (m) => m.set(e.id, e));
}

export function remove(s: ScheduleStore, kind: Kind, id: string): ScheduleStore {
  const next = withTable(s, kind, (m) => m.delete(id));
  return { ...next, tombstones: new Set([...s.tombstones, tomb(kind, id)]) };
}

/** Fusionne une page de GET /schedule. */
export function ingestSchedule(s: ScheduleStore, r: ScheduleResponse): ScheduleStore {
  let out: ScheduleStore = { ...s, account: r.account, windows: new Set([...s.windows, `${r.window.from}..${r.window.to}`]) };
  // `phases` est optionnel au contrat (serveur plus ancien) : absent = rien à fusionner.
  for (const kind of KINDS) for (const e of (r[FIELD[kind]] ?? []) as EntityOf<Kind>[]) out = upsert(out, kind, e as never);
  return out;
}

export const hasWindow = (s: ScheduleStore, w: { from: string; to: string }) => s.windows.has(`${w.from}..${w.to}`);

export interface ChangesResult {
  store: ScheduleStore;
  /** Entités à recharger par id (insert / update plus récent que l'état local), sans doublon. */
  refetch: { kind: Kind; id: string }[];
  /** Changements hors Schedule (clients, tâches, jalons, équipe), à router par l'appelant. */
  other: Change[];
}

export function applyChanges(s: ScheduleStore, changes: readonly Change[]): ChangesResult {
  let store = s;
  const refetch = new Map<string, { kind: Kind; id: string }>();
  const other: Change[] = [];
  for (const c of changes) {
    if (!isKind(c.entity)) { other.push(c); continue; }
    const kind = c.entity;
    if (c.op === "delete") {
      store = remove(store, kind, c.id);
      refetch.delete(tomb(kind, c.id));
      continue;
    }
    const cur = store.tables[kind].get(c.id);
    if (store.tombstones.has(tomb(kind, c.id)) || (cur && c.version !== null && cur.version >= c.version)) continue;
    refetch.set(tomb(kind, c.id), { kind, id: c.id });
  }
  return { store, refetch: [...refetch.values()], other };
}

// ---------- optimiste ----------

/** Applique une mutation locale avant la réponse du serveur ; `after` null = suppression. */
export function applyOptimistic<K extends Kind>(s: ScheduleStore, mutationId: string, kind: K, id: string, after: EntityOf<K> | null): ScheduleStore {
  if (s.pending.has(mutationId)) throw new Error(`DUPLICATE_MUTATION: ${mutationId}`);
  const before = s.tables[kind].get(id) ?? null;
  const next = withTable(s, kind, (m) => (after === null ? m.delete(id) : m.set(id, after)));
  return { ...next, pending: new Map([...s.pending, [mutationId, { kind, id, before, after }]]) };
}

/** Le serveur a accepté : on garde sa version (réponse de l'écriture), ou on marque la suppression. */
export function confirmOptimistic<K extends Kind>(s: ScheduleStore, mutationId: string, server: EntityOf<K> | null): ScheduleStore {
  const p = s.pending.get(mutationId);
  if (!p) return s;
  const pending = new Map(s.pending);
  pending.delete(mutationId);
  let out: ScheduleStore = { ...s, pending };
  if (server === null) return remove(out, p.kind, p.id);
  if (server.id !== p.id) {
    // Création : l'id temporaire du client laisse place à celui du serveur.
    out = withTable(out, p.kind, (m) => { if (m.get(p.id) === p.after) m.delete(p.id); });
    return upsert(out, p.kind, server as never);
  }
  // La réponse remplace l'état optimiste même à version égale (l'optimiste porte encore l'ancienne version).
  return withTable(out, p.kind, (m) => { const cur = m.get(p.id); if (!cur || cur === p.after || cur.version <= server.version) m.set(p.id, server as never); });
}

/** Le serveur a refusé (409, 403, réseau) : retour à l'état d'avant, sauf si une version serveur plus récente est arrivée entre-temps. */
export function rollbackOptimistic(s: ScheduleStore, mutationId: string): ScheduleStore {
  const p = s.pending.get(mutationId);
  if (!p) return s;
  const pending = new Map(s.pending);
  pending.delete(mutationId);
  const cur = s.tables[p.kind].get(p.id) ?? null;
  if (cur !== p.after) return { ...s, pending }; // déjà remplacée par le serveur
  const out = withTable(s, p.kind, (m) => (p.before === null ? m.delete(p.id) : m.set(p.id, p.before as never)));
  return { ...out, pending };
}

// ---------- lecture ----------

// Ordre naturel des noms (« Personne 2 » avant « Personne 10 »).
const byName = new Intl.Collator(undefined, { numeric: true });

/**
 * Vue « réponse de Schedule » d'une fenêtre, pour réutiliser scheduleToEngineInput (capacité, utilisation, conflits).
 * Calculée localement : `changeCursor` et `page` n'y ont pas de sens (le curseur temps réel vit dans le client temps réel).
 */
export function snapshot(s: ScheduleStore, from: string, to: string): ScheduleResponse {
  if (!s.account) throw new Error("STORE_EMPTY: aucune fenêtre chargée");
  const all = <K extends Kind>(k: K) => [...s.tables[k].values()] as EntityOf<K>[];
  const allocations = all("allocations").filter((a) => a.startDate <= to && (a.repeatState === "none" ? a.endDate : (a.repeatEndDate ?? a.endDate)) >= from);
  const projectIds = new Set(allocations.map((a) => a.projectId));
  return {
    window: { from, to },
    changeCursor: "0",
    page: { nextCursor: null, total: s.tables.people.size },
    account: s.account,
    people: all("people").sort((a, b) => byName.compare(a.name, b.name) || a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    allocations,
    timeoffs: all("timeoffs").filter((t) => t.startDate <= to && t.endDate >= from),
    holidays: all("holidays").filter((h) => h.date >= from && h.date <= to),
    projects: all("projects").filter((p) => projectIds.has(p.id)),
    phases: all("phases").filter((p) => projectIds.has(p.projectId)),
    timeoffTypes: all("timeoff_types"),
    departments: all("departments"),
    roles: all("roles"),
  };
}
