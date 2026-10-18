import { withContext, type Db, type RequestContext } from "./db";
import { readChangeHead } from "./schedule";

// Sondage partagé du temps réel : un seul minuteur pour tout le processus, et une seule lecture de la tête du journal
// (account_change_seq, une ligne) par compte et par période, quel que soit le nombre de sessions du compte.
// Les sessions ne relisent change_log que lorsque la tête a bougé : le coût au repos passe de O(sessions) transactions
// à O(comptes) lectures d'une ligne. LISTEN/NOTIFY pourra remplacer le minuteur en appelant le même `wake` du compte.

export interface ChangeHub {
  /** Abonne une session au compte de `ctx` ; `wake` est appelé quand la tête du journal a changé (et une fois à l'abonnement). */
  subscribe(ctx: RequestContext, wake: () => void): () => void;
  close(): void;
}

interface Entry {
  ctx: RequestContext;
  wakes: Set<() => void>;
  /** null = inconnu : le prochain passage réveille tout le monde (nouvel abonné, ou lecture précédente en échec). */
  head: string | null;
}

export function createChangeHub(opts: { db: Db; intervalMs: number; onError?: (err: unknown) => void }): ChangeHub {
  const accounts = new Map<string, Entry>();
  let running = false;
  let closed = false;

  async function tick() {
    if (running) return; // un passage lent ne se superpose pas au suivant
    running = true;
    try {
      await Promise.all([...accounts.values()].map(async (entry) => {
        try {
          const head = await withContext(opts.db, entry.ctx, (tx) => readChangeHead(tx, entry.ctx.accountId));
          if (head === entry.head) return;
          entry.head = head;
          for (const wake of [...entry.wakes]) wake();
        } catch (err) {
          entry.head = null; // on ne sait plus : réveiller au prochain passage réussi
          opts.onError?.(err);
        }
      }));
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();

  return {
    subscribe(ctx, wake) {
      if (closed) return () => {};
      let entry = accounts.get(ctx.accountId);
      if (!entry) accounts.set(ctx.accountId, (entry = { ctx, wakes: new Set(), head: null }));
      entry.head = null; // l'arrivant a pu lire le journal avant la dernière tête vue : un réveil de rattrapage au prochain passage
      entry.wakes.add(wake);
      const e = entry;
      return () => {
        e.wakes.delete(wake);
        if (e.wakes.size === 0 && accounts.get(ctx.accountId) === e) accounts.delete(ctx.accountId);
      };
    },
    close() {
      closed = true;
      clearInterval(timer);
      accounts.clear();
    },
  };
}
