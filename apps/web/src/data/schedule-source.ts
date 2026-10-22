// Source de données du Schedule : relie la vue (viewport du moteur) au magasin pur (schedule/store) et à l'API réelle.
// Pure et sans framework : client HTTP généré et WebSocket injectés, testable avec un fetch simulé.
//  * Fenêtre visible -> loadChunks (blocs de 28 jours, préchargement de chaque côté : une largeur de vue, au moins un bloc)
//    -> blocs absents (hasWindow) regroupés par mergeChunks -> GET /schedule en suivant nextCursor jusqu'au bout ->
//    ingestSchedule -> snapshot de toute la plage chargée (l'écran y construit son modèle par tranches).
//  * Défilement continu : `data` ne change (nouvel objet) que si le magasin change. Une nouvelle vue, même dans une autre
//    tranche, sur des blocs déjà chargés garde le même objet : l'écran ne reconstruit son modèle qu'une fois (le sien).
//  * Une requête en vol couvre ses blocs : un second appel ne la répète pas. Les pages d'une requête sont intégrées
//    ensemble à la fin : un bloc n'est marqué chargé que si toutes ses pages sont arrivées.
//  * Époque : une réinitialisation (resync du temps réel, arrêt) invalide les requêtes en cours ; leurs réponses sont ignorées.
//  * Temps réel (optionnel) : createRealtimeClient + ticketFrom. Le curseur de départ est le plus ancien changeCursor des
//    réponses du visible (rejouer un changement déjà vu est inoffensif). Sur `changes` : applyChanges ; s'il reste des
//    entités plus récentes à recharger, on recharge le visible (les messages ne portent pas de dates : impossible de savoir
//    quels blocs sont concernés), on oublie les autres blocs (rechargés au prochain passage) et on retire les entités
//    toujours en retard après rechargement (sorties du visible). Sur `resync` : magasin neuf, rechargement du visible.
//  * Erreurs : codes stables de @wnext/contracts (jamais de texte) ; l'écran les traduit.
//  * Écritures (gestes, ADR-002 §5) : état optimiste tout de suite, puis PATCH (If-Match = version lue) ou découpe d'une
//    occurrence. Succès : la réponse remplace l'optimiste ; refus ou réseau : retour arrière (et relecture de l'allocation
//    sur VERSION_CONFLICT / NOT_FOUND). Tant qu'une écriture est en vol, les rechargements demandés par le temps réel sont
//    différés : l'écho de sa propre écriture (même version que la réponse) n'est alors jamais relu, rien ne clignote.
//  * Congés et allocations créées / supprimées (record-edits) : même chemin optimiste ; une création rend l'id du serveur.
//  * Pop-in du créneau (RT-014 à RT-016) : changement de projet (le projet d'arrivée, connu par listProjects, entre dans le
//    magasin pour colorer le bloc), création de groupe (BR-26, POST /allocation-groups : N lignes optimistes, tout ou rien),
//    projet modifié ailleurs dans l'écran (couleur, RT-018) appliqué tout de suite aux blocs. « Tout le groupe » (BR-26,
//    RT-042) : chaque ligne du groupe présente dans le magasin est optimiste ; les lignes hors fenêtre sont lues avant
//    l'écriture (allocations du projet) pour que l'annulation connaisse leur état d'avant ; PATCH /allocations/{id}/group
//    avec la version de la ligne désignée ; toute la réponse entre au magasin ; refus : retour arrière de toutes les
//    lignes (et relecture de chacune sur conflit). Découpe vers un projet absent du magasin : projet d'arrivée ajouté.
import { ErrorCode, type ApiError, type ScheduleResponse } from "@wnext/contracts";
import { addDays, loadChunks, mergeChunks, neighborDays, type Viewport } from "@wnext/engine";
import type { createClient } from "../api/client.gen";
import { RealtimeAuthError, createRealtimeClient, ticketFrom, type RealtimeClient, type RealtimeClientOptions, type RealtimeStatus } from "../realtime/client";
import {
  applyChanges, applyOptimistic, confirmOptimistic, emptyStore, hasWindow, ingestSchedule, isKind, remove, rollbackOptimistic, snapshot, upsert,
  type Kind, type ScheduleStore, type Tables,
} from "../schedule/store";
import type { AllocationGroupCreate } from "../api/client.gen";
import {
  localSplit, patched, toApiPatch, toGroupBody, toSplitBody, type Allocation, type AllocationEdit, type AllocationGroupEdit, type EditOutcome, type GroupEditOutcome,
  type ScheduleEditor,
} from "./allocation-edits";
import { allocationFromCreate, groupMembers, patchedTimeoff, timeoffFromCreate, type CreateOutcome, type RecordEditor } from "./record-edits";
import { summaryFromParams, type TeamRemovalEditor } from "./team-removal";

type Client = ReturnType<typeof createClient>;
/** Lecture obligatoire ; écritures optionnelles (absentes : les gestes rendent UNSUPPORTED). */
export type ScheduleApi = Pick<Client, "getSchedule" | "createRealtimeTicket"> & Partial<Pick<Client, "getAllocation" | "updateAllocation" | "splitAllocation" | "updateAllocationGroup" | "listProjectAllocations">>
  & Partial<Pick<Client, "createTimeoff" | "updateTimeoff" | "deleteTimeoff" | "createAllocation" | "deleteAllocation" | "listLoggedTime" | "listProjects">>
  & Partial<Pick<Client, "getTeamRemovalSummary" | "removeFromTeam" | "createAllocationGroup">>;
export type SourceErrorCode = ApiError["code"];

export interface ScheduleSourceState {
  /** Vue « réponse de Schedule » de la fenêtre visible ; null tant que rien n'est chargé. */
  data: ScheduleResponse | null;
  /** Au moins une requête en cours. */
  loading: boolean;
  /** Dernière erreur de chargement (effacée au prochain succès). */
  error: SourceErrorCode | null;
  /** État du temps réel ; « stopped » sans temps réel. */
  realtime: RealtimeStatus;
}

export interface ScheduleSourceOptions {
  api: ScheduleApi;
  /** Personnes par page de GET /schedule (défaut 200, max 500 côté API). */
  pageLimit?: number;
  /** Jours préchargés de chaque côté du visible (défaut : une largeur de vue, au moins un bloc). */
  prefetchDays?: number;
  /** Absent : pas de temps réel (chargements seuls). */
  realtime?: Pick<RealtimeClientOptions, "wsBase" | "openSocket" | "setTimer" | "clearTimer" | "random" | "now" | "onError" | "onNotifications">;
}

/** Projet proposé à la saisie rapide et à la pop-in (liste complète du compte, pas seulement ceux de la fenêtre). */
export interface ProjectRef { id: string; name: string }

export type ScheduleProjectPatch = ScheduleResponse["projects"][number];

/** Création multi-personnes (BR-26) : ids des lignes créées, dans l'ordre des membres. */
export type GroupOutcome = { ok: true; ids: string[] } | Exclude<CreateOutcome, { ok: true }>;

export interface ScheduleSource extends ScheduleEditor, RecordEditor, TeamRemovalEditor {
  /** Tous les projets du compte (GET /projects, paginé), gardés pour la session ; rafraîchis sur l'événement temps réel « projects ». */
  listProjects(): Promise<ProjectRef[]>;
  /** Avertit quand la liste des projets a changé (le cache est alors vidé : relire avec listProjects). */
  onProjectsChange(listener: () => void): () => void;
  /**
   * Projet créé ou modifié ailleurs (écran Projets, couleur depuis la pop-in d'un bloc) : appliqué tout de suite aux blocs. Sur
   * l'API, seulement s'il est plus récent que celui du magasin (l'écho temps réel, même version, n'est alors pas relu).
   */
  projectChanged?(project: ScheduleProjectPatch): void;
  /** Allocation multi-personnes (BR-26) : une ligne par personne, tout ou rien. */
  createAllocationGroup(body: AllocationGroupCreate): Promise<GroupOutcome>;
  /** Démo seulement : personnes, équipes (départements), rôles, types de congé et fériés écrits depuis Personnes ou Réglages. */
  directoryChanged?(kind: "people" | "departments" | "roles" | "timeoff_types" | "holidays", entity: { id: string; version: number }): void;
  directoryRemoved?(kind: "people" | "departments" | "roles" | "timeoff_types" | "holidays", id: string): void;
  /**
   * Réglages du compte écrits (Réglages > Compte, RT-041 ; pas de temps réel pour le compte) : semaine, seuil et fuseau appliqués
   * tout de suite ; sur l'API, les requêtes en vol sont écartées et les blocs chargés oubliés, pour que le Schedule soit relu
   * (tout de suite si le Planning est affiché, sinon à son retour).
   */
  accountChanged?(account: ScheduleResponse["account"]): void;
  /** Démo seulement : désactivation d'une personne (BR-31), allocations futures réaffectées ou supprimées. */
  personDeactivated?(personId: string, asOf: string, disposition: "reassign" | "delete" | undefined, replacementId: string | undefined): void;
  getState(): ScheduleSourceState;
  subscribe(listener: () => void): () => void;
  /** Nouvelle vue (défilement, zoom, navigation) : charge les blocs manquants si la source est démarrée. */
  setViewport(v: Viewport): void;
  /**
   * Changements venus d'ailleurs (temps réel) : version plus récente que l'état local une fois ses propres écritures
   * terminées, ou suppression d'une entité encore présente. Jamais pour l'écho de ses propres écritures (historique
   * d'annulation : seules les actions qui touchent ces entités sont invalidées).
   */
  onForeignChange(listener: (kind: Kind, ids: string[]) => void): () => void;
  start(): void;
  stop(): void;
}

type Range = { from: string; to: string };
const keyOf = (r: Range) => `${r.from}..${r.to}`;
const ERROR_CODES = new Set<string>(ErrorCode.options);

/** Échec d'une requête : code du contrat (corps de l'erreur) ou, à défaut, déduit du statut HTTP. */
export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
    this.name = "SourceError";
  }
}
class StaleError extends Error {}

export function errorCodeOf(status: number, body: unknown): SourceErrorCode {
  const code = (body as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && ERROR_CODES.has(code)) return code as SourceErrorCode;
  return status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR";
}

const minCursor = (cs: readonly string[]) => cs.reduce((a, b) => (BigInt(b) < BigInt(a) ? b : a), cs[0] ?? "0");

export function createScheduleSource(opts: ScheduleSourceOptions): ScheduleSource {
  const pageLimit = opts.pageLimit ?? 200;
  const prefetchOf = (v: Viewport) => opts.prefetchDays ?? neighborDays(v);
  const listeners = new Set<() => void>();

  let store: ScheduleStore = emptyStore();
  let epoch = 0;
  let started = false;
  let viewport: Viewport | null = null;
  /** Bloc -> requête en vol qui le couvre (résout le changeCursor de ses pages). */
  let inflight = new Map<string, Promise<string>>();
  let active = 0;
  let refetching: Promise<void> | null = null;
  let refetchAgain = false;
  let state: ScheduleSourceState = { data: null, loading: false, error: null, realtime: "stopped" };
  let rt: RealtimeClient | null = null;

  function set(patch: Partial<ScheduleSourceState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  }

  const chunks = (): Range[] => (viewport ? loadChunks(viewport, store.account?.weekStart ?? 1, prefetchOf(viewport)) : []);

  /** Plage chargée : des fenêtres du magasin, de la plus ancienne à la plus récente (null : rien de chargé). */
  function loaded(): Range | null {
    const ws = [...store.windows].map((k) => k.split("..") as [string, string]);
    if (!ws.length) return null;
    return { from: ws.reduce((m, [f]) => (f < m ? f : m), ws[0]![0]), to: ws.reduce((m, [, t]) => (t > m ? t : m), ws[0]![1]) };
  }

  /** Snapshot du dernier magasin vu : un magasin inchangé redonne le même objet. */
  let shown: { store: ScheduleStore; data: ScheduleResponse } | null = null;

  /** Recalcule le snapshot si le magasin a changé ; un magasin vidé (resync en cours) garde l'affichage précédent. */
  function refresh(patch: Partial<ScheduleSourceState> = {}) {
    const r = loaded();
    if (store.account && r && shown?.store !== store) shown = { store, data: snapshot(store, r.from, r.to) };
    const data = store.account && r ? shown!.data : state.data;
    set({ ...patch, data, loading: active > 0 });
  }

  async function fetchAll(range: Range, ep: number): Promise<ScheduleResponse[]> {
    const pages: ScheduleResponse[] = [];
    let cursor: string | undefined;
    do {
      const res = await opts.api.getSchedule({ from: range.from, to: range.to, limit: pageLimit, cursor });
      if (ep !== epoch) throw new StaleError();
      if (!res.ok) throw new SourceError(errorCodeOf(res.status, res.error));
      pages.push(res.data);
      cursor = res.data.page.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  }

  /** Lance une requête (toutes pages) pour `range`, couvrant `covered` ; intègre au magasin si l'époque n'a pas changé. */
  function request(range: Range, covered: Range[]): Promise<string> {
    const ep = epoch;
    active++;
    let p!: Promise<string>;
    p = (async () => {
      try {
        let pages: ScheduleResponse[];
        try {
          pages = await fetchAll(range, ep);
        } catch (err) {
          if (err instanceof StaleError || ep !== epoch) throw new StaleError();
          throw err instanceof SourceError ? err : new SourceError("INTERNAL_ERROR"); // réseau, corps illisible
        }
        for (const page of pages) store = ingestSchedule(store, page);
        store = { ...store, windows: new Set([...store.windows, ...covered.map(keyOf)]) };
        return minCursor(pages.map((x) => x.changeCursor));
      } finally {
        active--;
        if (ep === epoch) for (const c of covered) if (inflight.get(keyOf(c)) === p) inflight.delete(keyOf(c));
      }
    })();
    const settle = (patch: Partial<ScheduleSourceState>) => (ep === epoch ? refresh(patch) : set({ loading: active > 0 }));
    p.then(() => settle({ error: null }), (err) => settle(err instanceof SourceError ? { error: err.code } : {}));
    for (const c of covered) inflight.set(keyOf(c), p);
    return p;
  }

  /** Demande les blocs de la vue ; `force` ignore le cache et les requêtes en vol. Rend une promesse par bloc à attendre. */
  function load(force: boolean): Promise<string>[] {
    const all = chunks();
    const need = force ? all : all.filter((c) => !hasWindow(store, c) && !inflight.has(keyOf(c)));
    for (const r of mergeChunks(need)) request(r, need.filter((c) => c.from >= r.from && c.to <= r.to));
    const out = all.flatMap((c) => inflight.get(keyOf(c)) ?? []);
    if (need.length) refresh();
    return out;
  }

  const quiet = (ps: Promise<unknown>[]) => { for (const p of ps) p.catch(() => {}); };

  /** Magasin neuf et rechargement complet du visible ; rend le plus ancien changeCursor (départ du temps réel). */
  async function reload(): Promise<string> {
    epoch++;
    inflight = new Map();
    store = emptyStore();
    try {
      return minCursor(await Promise.all(load(true)));
    } catch (err) {
      if (err instanceof SourceError && err.code === "UNAUTHENTICATED") throw new RealtimeAuthError();
      throw err;
    }
  }

  /** Entités plus récentes annoncées : recharge le visible, oublie les autres blocs, retire celles restées en retard. */
  function refetch(stale: Map<string, { kind: Kind; id: string; version: number }>) {
    const ep = epoch;
    const visible = new Set(chunks().map(keyOf));
    store = { ...store, windows: new Set([...store.windows].filter((k) => visible.has(k))) };
    return Promise.all(load(true)).then(() => {
      if (ep !== epoch) return;
      let tables = store.tables;
      for (const { kind, id, version } of stale.values()) {
        const cur = tables[kind].get(id);
        if (cur && cur.version < version) {
          const m = new Map(tables[kind] as ReadonlyMap<string, unknown>);
          m.delete(id); // hors du visible : sera relu avec son bloc (pas de pierre tombale, l'entité existe toujours)
          tables = { ...tables, [kind]: m } as Tables;
        }
      }
      store = { ...store, tables };
      refresh();
    });
  }

  let pendingStale = new Map<string, { kind: Kind; id: string; version: number }>();
  function scheduleRefetch() {
    if (refetching) { refetchAgain = true; return; }
    const stale = pendingStale;
    pendingStale = new Map();
    refetching = refetch(stale).catch(() => {}).finally(() => {
      refetching = null;
      if (refetchAgain) { refetchAgain = false; scheduleRefetch(); }
    });
  }

  // Projets du compte : lus page par page une fois par session (échec : pas de cache, nouvel essai à la demande).
  let projectsCache: Promise<ProjectRef[]> | null = null;
  const projectListeners = new Set<() => void>();
  /** Derniers projets lus (forme du Schedule) : le projet d'arrivée d'une écriture entre dans le magasin. */
  const knownProjects = new Map<string, ScheduleProjectPatch>();
  async function fetchProjects(): Promise<ProjectRef[]> {
    const out: ProjectRef[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await opts.api.listProjects!({ limit: pageLimit, ...(cursor ? { cursor } : {}) });
      if (!res.ok) throw new SourceError(errorCodeOf(res.status, res.error));
      for (const p of res.data.items) {
        const { projectManagerId: _m, clientId: _c, tags: _t, notes: _n, managerUserIds: _u, ...shape } = p;
        knownProjects.set(p.id, shape);
      }
      out.push(...res.data.items.map((p) => ({ id: p.id, name: p.name })));
      cursor = res.data.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }
  function listProjects(): Promise<ProjectRef[]> {
    if (!opts.api.listProjects) return Promise.resolve([]);
    const p = (projectsCache ??= fetchProjects());
    p.catch(() => { if (projectsCache === p) projectsCache = null; });
    return p;
  }
  function projectsChanged() {
    projectsCache = null;
    for (const l of projectListeners) l();
  }

  const foreignListeners = new Set<(kind: Kind, ids: string[]) => void>();
  function foreign(entries: Iterable<{ kind: Kind; id: string }>) {
    const by = new Map<Kind, string[]>();
    for (const e of entries) by.set(e.kind, [...(by.get(e.kind) ?? []), e.id]);
    for (const [kind, ids] of by) for (const l of foreignListeners) l(kind, ids);
  }

  function onChanges(changes: Parameters<RealtimeClientOptions["onChanges"]>[0]) {
    if (changes.some((c) => c.entity === "projects")) projectsChanged();
    // Suppression étrangère : ni pierre tombale (suppression confirmée), ni suppression en attente sur la même entité (l'écho
    // NOTIFY de notre DELETE peut devancer la réponse HTTP ; le prendre pour étranger purgerait l'historique d'annulation).
    const ourDelete = (kind: string, id: string) => [...store.pending.values()].some((p) => p.kind === kind && p.id === id && p.after === null);
    foreign(changes.filter((c) => c.op === "delete" && isKind(c.entity) && !store.tombstones.has(`${c.entity}:${c.id}`) && !ourDelete(c.entity, c.id))
      .map((c) => ({ kind: c.entity as Kind, id: c.id })));
    const r = applyChanges(store, changes);
    store = r.store;
    for (const e of r.refetch) {
      const version = changes.filter((c) => c.entity === e.kind && c.id === e.id).reduce((v, c) => Math.max(v, c.version ?? 0), 0);
      const k = `${e.kind}:${e.id}`;
      pendingStale.set(k, { ...e, version: Math.max(version, pendingStale.get(k)?.version ?? 0) });
    }
    if (r.refetch.length && store.pending.size === 0) { foreign(r.refetch); scheduleRefetch(); }
    refresh();
  }

  /** Fin d'une écriture : rechargements différés, sauf les entités désormais à jour (écho de ses propres écritures). */
  function settled() {
    refresh();
    if (store.pending.size > 0) return;
    for (const [k, e] of pendingStale) {
      const cur = store.tables[e.kind].get(e.id);
      if (cur && cur.version >= e.version) pendingStale.delete(k);
    }
    if (pendingStale.size) { foreign(pendingStale.values()); scheduleRefetch(); }
  }

  let seq = 0;
  const busy = (id: string) => [...store.pending.values()].some((p) => p.kind === "allocations" && p.id === id);
  const fail = (error: Exclude<EditOutcome, { ok: true }>["error"], reason?: string): Exclude<EditOutcome, { ok: true }> =>
    reason === undefined ? { ok: false, error } : { ok: false, error, reason };

  /** Relit une allocation après un refus (autre version ou supprimée) ; un échec de relecture est sans suite. */
  async function reread(id: string) {
    if (!opts.api.getAllocation) return;
    const ep = epoch;
    try {
      const res = await opts.api.getAllocation({ path: { id } });
      if (ep !== epoch) return;
      if (res.ok) store = upsert(store, "allocations", res.data);
      else if (res.status === 404) store = remove(store, "allocations", id);
      refresh();
    } catch { /* réseau : le prochain chargement corrigera */ }
  }

  type Res<T> = { ok: true; data: T } | { ok: false; status: number; error: unknown };
  /** Appel d'écriture : confirme (onOk) ou retour arrière des mutations `ids`, puis code stable. */
  async function write<T>(ids: string[], call: () => Promise<Res<T>>, onOk: (d: T) => void): Promise<EditOutcome> {
    let res: Res<T>;
    try {
      res = await call();
    } catch {
      for (const m of ids) store = rollbackOptimistic(store, m);
      settled();
      return fail("NETWORK");
    }
    if (res.ok) {
      onOk(res.data);
      settled();
      return { ok: true };
    }
    for (const m of ids) store = rollbackOptimistic(store, m);
    settled();
    const reason = (res.error as { params?: { reason?: unknown } } | null)?.params?.reason;
    return fail(errorCodeOf(res.status, res.error), typeof reason === "string" ? reason : undefined);
  }

  /** Projet d'une écriture absent du magasin : repris des projets lus (sinon le bloc n'aurait ni nom ni couleur). */
  function ensureProject(projectId: string | undefined) {
    if (projectId === undefined || store.tables.projects.has(projectId)) return;
    const p = knownProjects.get(projectId);
    if (p) store = upsert(store, "projects", { ...p });
  }

  async function updateAllocation(id: string, patch: AllocationEdit): Promise<EditOutcome> {
    const cur = store.tables.allocations.get(id);
    const api = opts.api.updateAllocation;
    if (!api) return fail("UNSUPPORTED");
    if (!cur) return fail("NOT_FOUND");
    if (busy(id)) return fail("BUSY");
    ensureProject(patch.projectId);
    const m = `edit-${++seq}`;
    store = applyOptimistic(store, m, "allocations", id, patched(cur, patch));
    refresh();
    const out = await write([m], () => api({ path: { id }, headers: { "If-Match": `"${cur.version}"` }, body: toApiPatch(patch) }),
      (d) => { store = confirmOptimistic(store, m, d); });
    if (!out.ok && (out.error === "VERSION_CONFLICT" || out.error === "NOT_FOUND")) await reread(id);
    return out;
  }

  /**
   * Lignes du groupe de `a` absentes du magasin (hors de la fenêtre chargée) : lecture préalable des allocations de son projet
   * sur 400 jours autour d'elle (pas de lecture de groupe dans l'API). Échec ou page refusée : ce qui a été lu.
   */
  async function groupOutside(a: Allocation, known: ReadonlySet<string>): Promise<Allocation[]> {
    const list = opts.api.listProjectAllocations;
    const out: Allocation[] = [];
    if (!list) return out;
    const query = { from: addDays(a.startDate, -199), to: addDays(a.startDate, 200), limit: 500 };
    let cursor: string | undefined;
    try {
      for (let guard = 0; guard < 100; guard++) {
        const res = await list({ path: { projectId: a.projectId }, query: cursor ? { ...query, cursor } : query });
        if (!res.ok) break;
        out.push(...res.data.items.filter((x) => x.groupId === a.groupId && !known.has(x.id)));
        cursor = res.data.page.nextCursor ?? undefined;
        if (!cursor) break;
      }
    } catch { /* réseau : les lignes non lues seront « inconnues » */ }
    return out;
  }

  async function updateAllocationGroup(id: string, patch: AllocationGroupEdit): Promise<GroupEditOutcome> {
    const cur = store.tables.allocations.get(id);
    const api = opts.api.updateAllocationGroup;
    if (!api) return fail("UNSUPPORTED");
    if (!cur || cur.groupId === null) return fail("NOT_FOUND");
    const lines = [...store.tables.allocations.values()].filter((a) => a.groupId === cur.groupId);
    if (lines.some((a) => busy(a.id))) return fail("BUSY");
    ensureProject(patch.projectId);
    const n = ++seq;
    const ms = lines.map((a, i) => {
      const m = `group-edit-${n}-${i}`;
      store = applyOptimistic(store, m, "allocations", a.id, patched(a, patch));
      return m;
    });
    refresh();
    let before: Allocation[] = lines;
    let unknown: string[] = [];
    const out = await write(ms, async () => {
      before = [...lines, ...await groupOutside(cur, new Set(lines.map((a) => a.id)))];
      return api({ path: { id }, headers: { "If-Match": `"${cur.version}"` }, body: toGroupBody(patch) });
    }, (d) => {
      const byId = new Map(d.items.map((x) => [x.id, x]));
      // Une ligne absente de la réponse (sortie du groupe entre-temps) garde son état d'avant : la relecture la corrigera.
      lines.forEach((a, i) => { store = byId.has(a.id) ? confirmOptimistic(store, ms[i]!, byId.get(a.id)!) : rollbackOptimistic(store, ms[i]!); });
      // Toute la réponse entre au magasin : une ligne ramenée dans la fenêtre s'affiche, les autres restent hors du snapshot.
      const mine = new Set(lines.map((a) => a.id));
      for (const x of d.items) if (!mine.has(x.id)) store = upsert(store, "allocations", x);
      const read = new Set(before.map((a) => a.id));
      before = before.filter((a) => byId.has(a.id));
      unknown = d.items.filter((x) => !read.has(x.id)).map((x) => x.id);
    });
    if (!out.ok && (out.error === "VERSION_CONFLICT" || out.error === "NOT_FOUND")) for (const a of lines) await reread(a.id);
    return out.ok ? { ok: true, before, unknown } : out;
  }

  async function splitOccurrence(id: string, index: number, patch: AllocationEdit): Promise<EditOutcome> {
    const cur = store.tables.allocations.get(id);
    const api = opts.api.splitAllocation;
    if (!api) return fail("UNSUPPORTED");
    if (!cur) return fail("NOT_FOUND");
    if (busy(id)) return fail("BUSY");
    const n = ++seq;
    const local = localSplit(cur, index, patch, (k) => `tmp-${n}-${k}`);
    if (local.ok) ensureProject(patch.projectId);
    if (!local.ok) return fail(local.error, local.reason);
    const s = local.split;
    const [mb, mo, ma] = [`split-${n}-b`, `split-${n}-o`, `split-${n}-a`];
    store = applyOptimistic(store, mb, "allocations", id, s.before);
    store = applyOptimistic(store, mo, "allocations", s.occurrence.id, s.occurrence);
    const ids = [mb, mo];
    if (s.after) { store = applyOptimistic(store, ma, "allocations", s.after.id, s.after); ids.push(ma); }
    refresh();
    const out = await write(ids, () => api({ path: { id }, headers: { "If-Match": `"${cur.version}"` }, body: toSplitBody(s.occurrenceDate, patch) }),
      (d) => {
        store = confirmOptimistic(store, mb, d.before ?? null);
        store = confirmOptimistic(store, mo, d.occurrence ?? null);
        if (s.after) store = confirmOptimistic(store, ma, d.after ?? null);
        else if (d.after) store = upsert(store, "allocations", d.after);
      });
    if (!out.ok && (out.error === "VERSION_CONFLICT" || out.error === "NOT_FOUND")) await reread(id);
    return out;
  }

  const busyOn = (kind: Kind, id: string) => [...store.pending.values()].some((p) => p.kind === kind && p.id === id);
  const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });

  /** Création optimiste (id temporaire) puis POST ; rend l'id du serveur. */
  async function create<K extends "timeoffs" | "allocations", T extends { id: string }>(
    kind: K, local: (tmp: string) => unknown, call: () => Promise<Res<T>>,
  ): Promise<CreateOutcome> {
    const n = ++seq;
    const m = `create-${n}`;
    store = applyOptimistic(store, m, kind, `tmp-${kind}-${n}`, local(`tmp-${kind}-${n}`) as never);
    refresh();
    let id = "";
    const out = await write([m], call, (d) => { store = confirmOptimistic(store, m, d as never); id = d.id; });
    return out.ok ? { ok: true, id } : out;
  }

  /** Mise à jour (after) ou suppression (null) optimiste avec If-Match. */
  async function change<T>(kind: "timeoffs" | "allocations", id: string, after: (cur: never) => unknown, call: (version: number) => Promise<Res<T>> | undefined): Promise<EditOutcome> {
    const cur = store.tables[kind].get(id);
    if (!cur) return fail("NOT_FOUND");
    if (busyOn(kind, id)) return fail("BUSY");
    const m = `${kind}-${++seq}`;
    const next = after(cur as never);
    store = applyOptimistic(store, m, kind, id, next as never);
    refresh();
    return write([m], () => call(cur.version)!, (d) => { store = confirmOptimistic(store, m, next === null ? null : (d as never)); });
  }

  const records: RecordEditor = {
    async createTimeoff(body) {
      const api = opts.api.createTimeoff;
      return api ? create("timeoffs", (tmp) => timeoffFromCreate(body, tmp), () => api({ body })) : fail("UNSUPPORTED");
    },
    async updateTimeoff(id, patch) {
      const api = opts.api.updateTimeoff;
      return api ? change("timeoffs", id, (t) => patchedTimeoff(t, patch), (v) => api({ path: { id }, headers: ifMatch(v), body: patch })) : fail("UNSUPPORTED");
    },
    async deleteTimeoff(id) {
      const api = opts.api.deleteTimeoff;
      return api ? change("timeoffs", id, () => null, (v) => api({ path: { id }, headers: ifMatch(v) })) : fail("UNSUPPORTED");
    },
    async createAllocation(body) {
      const api = opts.api.createAllocation;
      if (api) ensureProject(body.projectId);
      return api ? create("allocations", (tmp) => allocationFromCreate(body, tmp), () => api({ body })) : fail("UNSUPPORTED");
    },
    async deleteAllocation(id) {
      const api = opts.api.deleteAllocation;
      return api ? change("allocations", id, () => null, (v) => api({ path: { id }, headers: ifMatch(v) })) : fail("UNSUPPORTED");
    },
    async loggedTime(personId, from, to) {
      if (!opts.api.listLoggedTime) return null;
      try {
        const res = await opts.api.listLoggedTime({ personId, from, to });
        return res.ok ? res.data.items.map((l) => ({ personId: l.personId, day: l.workDate, hours: l.hours })) : null;
      } catch {
        return null;
      }
    },
  };

  // BR-10 : jamais optimiste (suppression irréversible, confirmée) ; succès : les allocations de la personne sur le projet
  // quittent le magasin avec pierre tombale (l'écho temps réel des suppressions n'est donc pas un changement étranger).
  const removal: TeamRemovalEditor = {
    async teamRemovalSummary(projectId, personId) {
      const api = opts.api.getTeamRemovalSummary;
      if (!api) return fail("UNSUPPORTED");
      try {
        const res = await api({ path: { projectId, personId } });
        return res.ok ? { ok: true, summary: res.data } : fail(errorCodeOf(res.status, res.error));
      } catch {
        return fail("NETWORK");
      }
    },
    async removeFromTeam(projectId, personId, confirmation) {
      const api = opts.api.removeFromTeam;
      if (!api) return fail("UNSUPPORTED");
      let res: Awaited<ReturnType<typeof api>>;
      try {
        res = await api({ path: { projectId, personId }, body: { confirmation } });
      } catch {
        return fail("NETWORK");
      }
      if (!res.ok) {
        const summary = summaryFromParams((res.error as { params?: unknown } | null)?.params);
        return { ...fail(errorCodeOf(res.status, res.error)), ...(summary && { summary }) };
      }
      for (const a of [...store.tables.allocations.values()]) {
        if (a.projectId === projectId && a.personId === personId) store = remove(store, "allocations", a.id);
      }
      refresh();
      const { removedAllocations, removedLogs, removedLogHours } = res.data;
      return { ok: true, removedAllocations, removedLogs, removedLogHours };
    },
  };

  async function createAllocationGroup(body: AllocationGroupCreate): Promise<GroupOutcome> {
    const api = opts.api.createAllocationGroup;
    if (!api) return fail("UNSUPPORTED");
    ensureProject(body.projectId);
    const n = ++seq;
    const ms = groupMembers(body).map((member, i) => {
      const m = `group-${n}-${i}`;
      store = applyOptimistic(store, m, "allocations", `tmp-group-${n}-${i}`, allocationFromCreate(member, `tmp-group-${n}-${i}`) as never);
      return m;
    });
    refresh();
    let ids: string[] = [];
    const out = await write(ms, () => api({ body }), (d) => {
      ms.forEach((m, i) => { store = confirmOptimistic(store, m, (d.items[i] ?? null) as never); });
      ids = d.items.map((x) => x.id);
    });
    return out.ok ? { ok: true, ids } : out;
  }

  return {
    ...records,
    ...removal,
    createAllocationGroup,
    projectChanged(p) {
      const cur = store.tables.projects.get(p.id);
      if (!cur || cur.version >= p.version) return;
      store = upsert(store, "projects", { ...p });
      refresh();
    },
    accountChanged(account) {
      // Les réponses parties avant l'écriture portent l'ancien compte : nouvelle époque, elles sont ignorées à l'arrivée.
      epoch++;
      inflight = new Map();
      if (store.account) {
        store = { ...store, account };
        refresh();
      }
      store = { ...store, windows: new Set() };
      if (started) quiet(load(false));
    },
    listProjects,
    onProjectsChange(l) {
      projectListeners.add(l);
      return () => projectListeners.delete(l);
    },
    updateAllocation,
    splitOccurrence,
    updateAllocationGroup,
    onForeignChange(l) {
      foreignListeners.add(l);
      return () => foreignListeners.delete(l);
    },
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setViewport(v) {
      viewport = v;
      if (started) quiet(load(false));
    },
    start() {
      if (started) return;
      started = true;
      if (!opts.realtime) {
        quiet(load(false));
        return;
      }
      rt = createRealtimeClient({
        ...opts.realtime,
        getTicket: ticketFrom(opts.api),
        loadCursor: reload,
        onChanges,
        onStatus: (s) => set({ realtime: s }),
        onUnauthenticated: () => set({ error: "UNAUTHENTICATED" }),
      });
      rt.start();
    },
    stop() {
      started = false;
      epoch++;
      inflight = new Map();
      rt?.stop();
      rt = null;
    },
  };
}
