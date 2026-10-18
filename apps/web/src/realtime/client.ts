import { REALTIME_PATH, REALTIME_PROTOCOL_VERSION, REALTIME_RETRY_AFTER_SECONDS, REALTIME_TICKET_PARAM, RealtimeServerMessage, type Change, type RealtimeTicket } from "@wnext/contracts";

// Client du temps réel : se connecte, se réabonne depuis son curseur, se reconnecte seul avec attente croissante et aléa.
// Il applique la conduite documentée dans packages/contracts/src/realtime.ts :
//  * un ticket NEUF à chaque tentative (jamais réutilisé) ;
//  * 401 sur la demande de ticket -> arrêt et `onUnauthenticated` (se ré-authentifier, pas de boucle) ;
//  * échec avant l'ouverture (429 plafond, 500, réseau) -> attente d'au moins REALTIME_RETRY_AFTER_SECONDS puis croissante avec aléa.
//    Un navigateur ne voit ni le statut ni `Retry-After` d'un upgrade refusé : le plancher du contrat est donc appliqué à tout échec d'ouverture ;
//  * `resync` ou curseur invalide -> `loadCursor` (recharger la fenêtre, GET /schedule, rendre son `changeCursor`) puis réabonnement ;
//  * le temps réel n'est qu'un confort de fraîcheur : pendant l'attente, l'affichage continue sur les dernières données.
// Aucune dépendance au navigateur : WebSocket, minuteurs et aléa sont injectés (tests déterministes).

/** Sous-ensemble de WebSocket utilisé ; un WebSocket du navigateur ou de `ws` convient. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type RealtimeStatus = "connecting" | "live" | "waiting" | "stopped";

/** À lever par `getTicket` quand l'API répond 401 : la session n'est plus valable, inutile de réessayer. */
export class RealtimeAuthError extends Error {
  constructor() {
    super("non authentifié");
    this.name = "RealtimeAuthError";
  }
}

/** À lever par `getTicket` sur un 429 : l'API demande d'attendre `retryAfterSeconds` avant de redemander un ticket. */
export class RealtimeRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`trop de tickets, réessayer dans ${retryAfterSeconds} s`);
    this.name = "RealtimeRateLimitedError";
  }
}

export interface RealtimeClientOptions {
  /** Base WebSocket, ex. `wss://app.example.test` (le chemin vient du contrat). */
  wsBase: string;
  /** Demande un ticket neuf (POST /api/v1/realtime/ticket). Lever `RealtimeAuthError` sur 401. */
  getTicket(): Promise<RealtimeTicket>;
  /** Fournit un curseur de départ : charger la fenêtre (GET /schedule), l'afficher, rendre son `changeCursor`. Rappelé après un `resync`. */
  loadCursor(): Promise<string>;
  /** Lot de changements (références seulement) ; `cursor` est déjà mémorisé. Le client recharge les entités dont sa copie est plus ancienne. */
  onChanges(changes: Change[], cursor: string): void;
  onStatus?(status: RealtimeStatus): void;
  /** La session n'est plus authentifiée : le client s'est arrêté. */
  onUnauthenticated?(): void;
  /** Journal des échecs (réseau, message illisible, erreur du serveur) : jamais bloquant. */
  onError?(err: unknown): void;
  openSocket?(url: string): SocketLike;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** [0,1[ ; défaut Math.random. */
  random?(): number;
  now?(): number;
  /** Attente de base (défaut 1 s) et plafond (défaut 30 s) de l'attente croissante. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Délai pour ouvrir ET recevoir `ready` (défaut 10 s). */
  connectTimeoutMs?: number;
  /** Une connexion vive depuis au moins ce temps remet l'attente à zéro (défaut 10 s). */
  stableMs?: number;
}

export interface RealtimeClient {
  start(): void;
  stop(): void;
}

export function createRealtimeClient(opts: RealtimeClientOptions): RealtimeClient {
  // Globaux du navigateur, typés ici : le tsconfig du web n'embarque ni les types DOM ni ceux de Node.
  const g = globalThis as unknown as { WebSocket: new (url: string) => SocketLike; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  const open = opts.openSocket ?? ((url: string) => new g.WebSocket(url));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => g.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => g.clearTimeout(h));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const connectTimeout = opts.connectTimeoutMs ?? 10_000;
  const stable = opts.stableMs ?? 10_000;
  const floorMs = REALTIME_RETRY_AFTER_SECONDS * 1000;

  let running = false;
  let generation = 0; // invalide les rappels d'une tentative abandonnée
  let attempts = 0;
  let cursor: string | null = null;
  let socket: SocketLike | null = null;
  let timer: unknown;
  let status: RealtimeStatus = "stopped";

  const setStatus = (s: RealtimeStatus) => { if (s !== status) { status = s; opts.onStatus?.(s); } };
  const clear = () => { if (timer !== undefined) { clearTimer(timer); timer = undefined; } };
  const report = (err: unknown) => { try { opts.onError?.(err); } catch { /* le journal ne doit jamais casser le client */ } };

  /** Attente croissante avec aléa (moitié fixe, moitié aléatoire) ; `floor` = plancher du contrat après un échec d'ouverture. */
  const delay = (floor: number) => {
    const ceiling = Math.min(max, base * 2 ** Math.min(attempts, 20));
    return Math.max(floor, Math.floor(ceiling / 2 + random() * (ceiling / 2)));
  };

  function schedule(gen: number, floor: number) {
    if (!running || gen !== generation) return;
    setStatus("waiting");
    clear();
    const ms = delay(floor);
    attempts++;
    timer = setTimer(() => { timer = undefined; void attempt(); }, ms);
  }

  /** Ferme la tentative en cours sans déclencher sa propre reprise. */
  function drop() {
    generation++;
    clear();
    const s = socket;
    socket = null;
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(); } catch { /* déjà fermé */ } }
  }

  async function attempt() {
    if (!running) return;
    const gen = ++generation;
    setStatus("connecting");
    let ticket: RealtimeTicket;
    try {
      if (cursor === null) cursor = await opts.loadCursor();
      if (!running || gen !== generation) return;
      ticket = await opts.getTicket();
    } catch (err) {
      if (!running || gen !== generation) return;
      if (err instanceof RealtimeAuthError) {
        stop();
        opts.onUnauthenticated?.();
        return;
      }
      report(err);
      const asked = err instanceof RealtimeRateLimitedError ? err.retryAfterSeconds * 1000 : 0;
      return schedule(gen, Math.max(floorMs, asked));
    }
    if (!running || gen !== generation) return;

    let opened = false;
    let liveAt = 0;
    let wasLive = false;
    let reload = false; // resync ou curseur invalide : repartir d'un chargement complet
    let ended = false;
    const finish = (floor: number) => {
      if (ended || gen !== generation) return;
      ended = true;
      drop();
      if (wasLive && now() - liveAt >= stable) attempts = 0; // la connexion a tenu : repartir d'une petite attente
      if (reload) cursor = null;
      schedule(generation, floor);
    };
    // Le compte de tentatives et le plancher ne dépendent que de ce qui s'est passé : jamais ouvert -> plancher du contrat.
    const url = `${opts.wsBase}${REALTIME_PATH}?${REALTIME_TICKET_PARAM}=${encodeURIComponent(ticket.ticket)}`;
    let s: SocketLike;
    try {
      s = open(url);
    } catch (err) {
      report(err);
      return schedule(gen, floorMs);
    }
    socket = s;
    timer = setTimer(() => { timer = undefined; report(new Error("délai de connexion dépassé")); finish(floorMs); }, connectTimeout);
    s.onopen = () => {
      if (gen !== generation) return;
      opened = true;
      s.send(JSON.stringify({ v: REALTIME_PROTOCOL_VERSION, type: "subscribe", cursor }));
    };
    s.onmessage = (ev) => {
      if (gen !== generation) return;
      let msg: RealtimeServerMessage;
      try {
        msg = RealtimeServerMessage.parse(JSON.parse(String(ev.data)));
      } catch (err) {
        report(err); // protocole inconnu ou message corrompu : on repart d'une connexion propre
        return finish(floorMs);
      }
      if (msg.type === "ready") {
        clear();
        liveAt = now();
        wasLive = true;
        cursor = msg.cursor;
        setStatus("live");
      } else if (msg.type === "changes") {
        cursor = msg.cursor;
        try {
          opts.onChanges(msg.changes, msg.cursor);
        } catch (err) {
          report(err); // le consommateur a échoué sur ce lot : ses données sont peut-être incomplètes, on repart d'un chargement complet
          reload = true;
          finish(0);
        }
      } else if (msg.type === "resync") {
        reload = true; // le serveur ferme ensuite ; on recharge sans attendre davantage
      } else if (msg.type === "error") {
        report(new Error(`erreur du serveur : ${msg.code}`));
        if (msg.code === "SCHEDULE_CURSOR_INVALID") reload = true;
      }
    };
    s.onerror = () => { /* le détail passe par onclose */ };
    s.onclose = () => {
      if (gen !== generation) return;
      // Fermé avant ready : refus d'upgrade (429/500/401 invisibles du navigateur) ou réseau -> plancher du contrat.
      // Fermé après ready : coupure ordinaire (ou resync demandé) -> reprise avec l'attente croissante seule.
      finish(wasLive || (opened && reload) ? 0 : floorMs);
    };
  }

  function stop() {
    running = false;
    drop();
    setStatus("stopped");
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempts = 0;
      cursor = null;
      void attempt();
    },
    stop,
  };
}

/** Structure minimale du client généré qui nous sert : `createClient(...)` de api/client.gen la satisfait. */
export interface TicketApi {
  createRealtimeTicket(): Promise<{ ok: true; status: number; data: RealtimeTicket } | { ok: false; status: number; error: unknown }>;
}

/** Adapte le client généré en `getTicket` : 401 -> `RealtimeAuthError`, 429 -> `RealtimeRateLimitedError` (attente demandée), toute autre erreur est transitoire. */
export function ticketFrom(api: TicketApi): () => Promise<RealtimeTicket> {
  return async () => {
    const res = await api.createRealtimeTicket();
    if (res.ok) return res.data;
    if (res.status === 401) throw new RealtimeAuthError();
    if (res.status === 429) {
      const seconds = Number((res.error as { params?: { retryAfterSeconds?: unknown } } | null)?.params?.retryAfterSeconds);
      if (Number.isFinite(seconds) && seconds > 0) throw new RealtimeRateLimitedError(seconds);
    }
    throw new Error(`ticket refusé : HTTP ${res.status}`);
  };
}
