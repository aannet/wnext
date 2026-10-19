// Source de données du Schedule : relie la vue (viewport du moteur) au magasin pur (schedule/store) et à l'API réelle.
// Pure et sans framework : client HTTP généré et WebSocket injectés, testable avec un fetch simulé.
//  * Fenêtre visible -> loadChunks (blocs de 28 jours, préchargement de chaque côté) -> blocs absents (hasWindow) regroupés
//    par mergeChunks -> GET /schedule en suivant nextCursor jusqu'au bout -> ingestSchedule -> snapshot(visible).
//  * Une requête en vol couvre ses blocs : un second appel ne la répète pas. Les pages d'une requête sont intégrées
//    ensemble à la fin : un bloc n'est marqué chargé que si toutes ses pages sont arrivées.
//  * Époque : une réinitialisation (resync du temps réel, arrêt) invalide les requêtes en cours ; leurs réponses sont ignorées.
//  * Temps réel (optionnel) : createRealtimeClient + ticketFrom. Le curseur de départ est le plus ancien changeCursor des
//    réponses du visible (rejouer un changement déjà vu est inoffensif). Sur `changes` : applyChanges ; s'il reste des
//    entités plus récentes à recharger, on recharge le visible (les messages ne portent pas de dates : impossible de savoir
//    quels blocs sont concernés), on oublie les autres blocs (rechargés au prochain passage) et on retire les entités
//    toujours en retard après rechargement (sorties du visible). Sur `resync` : magasin neuf, rechargement du visible.
//  * Erreurs : codes stables de @wnext/contracts (jamais de texte) ; l'écran les traduit.
import { ErrorCode, type ApiError, type ScheduleResponse } from "@wnext/contracts";
import { loadChunks, mergeChunks, visibleRange, type Viewport } from "@wnext/engine";
import type { createClient } from "../api/client.gen";
import { RealtimeAuthError, createRealtimeClient, ticketFrom, type RealtimeClient, type RealtimeClientOptions, type RealtimeStatus } from "../realtime/client";
import { applyChanges, emptyStore, hasWindow, ingestSchedule, snapshot, type Kind, type ScheduleStore, type Tables } from "../schedule/store";

export type ScheduleApi = Pick<ReturnType<typeof createClient>, "getSchedule" | "createRealtimeTicket">;
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
  /** Jours préchargés de chaque côté du visible (défaut : un bloc). */
  prefetchDays?: number;
  /** Absent : pas de temps réel (chargements seuls). */
  realtime?: Pick<RealtimeClientOptions, "wsBase" | "openSocket" | "setTimer" | "clearTimer" | "random" | "now" | "onError">;
}

export interface ScheduleSource {
  getState(): ScheduleSourceState;
  subscribe(listener: () => void): () => void;
  /** Nouvelle vue (défilement, zoom, navigation) : charge les blocs manquants si la source est démarrée. */
  setViewport(v: Viewport): void;
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
  const prefetch = opts.prefetchDays ?? 28;
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

  /** Recalcule la vue visible ; un magasin vidé (resync en cours) garde l'affichage précédent. */
  function refresh(patch: Partial<ScheduleSourceState> = {}) {
    const data = store.account && viewport ? snapshot(store, visibleRange(viewport).from, visibleRange(viewport).to) : state.data;
    set({ ...patch, data, loading: active > 0 });
  }

  const chunks = (): Range[] => (viewport ? loadChunks(viewport, store.account?.weekStart ?? 1, prefetch) : []);

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

  function onChanges(changes: Parameters<RealtimeClientOptions["onChanges"]>[0]) {
    const r = applyChanges(store, changes);
    store = r.store;
    for (const e of r.refetch) {
      const version = changes.filter((c) => c.entity === e.kind && c.id === e.id).reduce((v, c) => Math.max(v, c.version ?? 0), 0);
      pendingStale.set(`${e.kind}:${e.id}`, { ...e, version });
    }
    if (r.refetch.length) scheduleRefetch();
    refresh();
  }

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setViewport(v) {
      viewport = v;
      if (started) quiet(load(false));
      refresh();
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
