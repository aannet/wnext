import { REALTIME_PROTOCOL_VERSION, RealtimeClientMessage, type RealtimeServerMessage } from "@wnext/contracts";
import { readChanges } from "./changes";
import type { Db, RequestContext } from "./db";
import { ApiFailure } from "./failure";

// Session temps réel (contrat : packages/contracts/src/realtime.ts), indépendante du transport : elle reçoit des
// messages texte et émet des messages via `send`. Le WebSocket/SSE n'est qu'un adaptateur par-dessus.
// Le contexte (compte, utilisateur) est fixé à la création, depuis la session authentifiée : jamais depuis un message.
// Le flux direct est un sondage de change_log via readChanges (poll) ; LISTEN/NOTIFY pourra le remplacer sans changer le contrat.

export interface RealtimeSession {
  /** Traite un message du client (texte JSON). Les messages sont traités l'un après l'autre. */
  receive(raw: string): Promise<void>;
  /** Émet les changements apparus depuis le dernier curseur (sans effet avant `ready`). */
  poll(): Promise<void>;
  close(): void;
}

export interface RealtimeOptions {
  db: Db;
  ctx: RequestContext;
  send: (message: RealtimeServerMessage) => void;
  /** Période du sondage automatique en ms ; absent = pas de minuteur (appeler `poll`). */
  pollIntervalMs?: number;
  pageSize?: number;
  /** Appelé une fois quand la session s'arrête (close, resync, erreur de curseur ou interne) : le transport ferme alors son canal. */
  onEnd?: () => void;
}

const v = REALTIME_PROTOCOL_VERSION;

export function createRealtimeSession(opts: RealtimeOptions): RealtimeSession {
  let cursor: string | null = null; // null = pas encore abonné
  let live = false;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  const send = (m: RealtimeServerMessage) => { if (!closed) opts.send(m); };
  const fail = (code: Extract<RealtimeServerMessage, { type: "error" }>["code"], params: Record<string, string | number | boolean> = {}) => send({ v, type: "error", code, params });
  // Les opérations s'enchaînent : un sondage ne chevauche ni un autre sondage ni l'abonnement.
  const serial = (fn: () => Promise<void>) => (queue = queue.then(fn, fn));

  /** Envoie les changements après `cursor` par lots ; faux si la session s'est arrêtée (expiration, erreur). */
  async function drain(): Promise<boolean> {
    for (;;) {
      let r;
      try {
        r = await readChanges(opts.db, opts.ctx, cursor!, opts.pageSize);
      } catch (e) {
        if (e instanceof ApiFailure) fail(e.code, e.params);
        else fail("INTERNAL_ERROR");
        stop();
        return false;
      }
      if (r.status === "expired") {
        send({ v, type: "resync", reason: "cursor_expired", head: r.head });
        stop();
        return false;
      }
      if (r.changes.length) {
        cursor = r.changes[r.changes.length - 1]!.seq;
        send({ v, type: "changes", changes: r.changes as never, cursor, hasMore: r.hasMore });
      }
      if (!r.hasMore) return true;
    }
  }

  function stop() {
    if (closed) return;
    live = false;
    closed = true;
    opts.onEnd?.();
    if (timer) clearInterval(timer);
  }

  async function subscribe(after: string) {
    cursor = after;
    if (!(await drain())) return;
    live = true;
    send({ v, type: "ready", cursor: cursor! });
    if (opts.pollIntervalMs) timer = setInterval(() => void session.poll(), opts.pollIntervalMs);
  }

  const session: RealtimeSession = {
    receive: (raw) => serial(async () => {
      if (closed) return;
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return fail("VALIDATION_FAILED"); }
      const msg = RealtimeClientMessage.safeParse(json);
      if (!msg.success) return fail("VALIDATION_FAILED");
      if (cursor !== null) return fail("VALIDATION_FAILED", { reason: "already_subscribed" });
      await subscribe(msg.data.cursor);
    }),
    poll: () => serial(async () => { if (live && !closed) await drain(); }),
    close: () => { stop(); },
  };
  return session;
}
