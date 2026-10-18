import type { ChangeNotifier } from "./change-hub";

// ChangeNotifier sur LISTEN/NOTIFY de PostgreSQL. Le trigger log_change (schema.sql) émet pg_notify('wnext_changes', <account_id>)
// dans la transaction d'écriture : PostgreSQL ne livre la notification qu'au COMMIT, dans l'ordre, et fusionne les doublons
// d'une même transaction. Une connexion dédiée écoute (hors pool : LISTEN est lié à la session), reconnectée avec attente
// croissante ; à chaque reconnexion le hub relit tout, car les notifications émises pendant la coupure sont perdues.

export const CHANGES_CHANNEL = "wnext_changes";

/** Le sous-ensemble de `pg.Client` utilisé ; permet d'injecter un faux client dans les tests. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", fn: (m: { channel: string; payload?: string | undefined }) => void): unknown;
  on(event: "error" | "end", fn: (err?: Error) => void): unknown;
}

export interface PgNotifierOptions {
  createClient: () => ListenClient;
  /** Attente avant la première nouvelle tentative (doublée à chaque échec, plafonnée à `maxBackoffMs`). */
  backoffMs?: number;
  maxBackoffMs?: number;
  onError?: (err: unknown) => void;
}

export function pgNotifier(opts: PgNotifierOptions): ChangeNotifier {
  const base = opts.backoffMs ?? 500;
  const max = opts.maxBackoffMs ?? 10_000;
  let stopped = false;
  let client: ListenClient | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  return {
    async start(h) {
      let delay = base;
      const connect = async (): Promise<void> => {
        if (stopped) return;
        const c = opts.createClient();
        client = c;
        let down = false;
        const lost = (err?: Error) => {
          if (down || stopped) return; // 'error' puis 'end' se suivent : une seule reprise
          down = true;
          if (err) opts.onError?.(err);
          h.onDown();
          void c.end().catch(() => {});
          retry = setTimeout(() => void connect(), delay);
          delay = Math.min(delay * 2, max);
        };
        c.on("error", lost);
        c.on("end", () => lost());
        c.on("notification", (m) => { if (m.channel === CHANGES_CHANNEL && m.payload && /^\d{1,19}$/.test(m.payload)) h.onNotify(m.payload); });
        try {
          await c.connect();
          await c.query(`LISTEN ${CHANGES_CHANNEL}`);
        } catch (err) {
          lost(err as Error);
          return;
        }
        if (down || stopped) return;
        delay = base;
        h.onUp();
      };
      await connect();
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      await client?.end().catch(() => {});
    },
  };
}
