import { withContext, type Db, type RequestContext } from "./db";
import { readChangeHead } from "./schedule";

// Sondage partagé du temps réel : un seul minuteur pour tout le processus, et une seule lecture de la tête du journal
// (account_change_seq, une ligne) par compte et par période, quel que soit le nombre de sessions du compte.
// Les sessions ne relisent change_log que lorsque la tête a bougé : le coût au repos passe de O(sessions) transactions
// à O(comptes) lectures d'une ligne.
// Avec un `ChangeNotifier` (LISTEN/NOTIFY), un changement validé réveille son compte aussitôt ; le minuteur ne sert plus
// que de filet (`fallbackMs`) tant que l'écoute est établie, et reprend sa période normale si elle est coupée.
// Une notification ne porte que l'identifiant du compte : le journal reste la source de vérité (un NOTIFY perdu ne perd rien).
// Notifications in-app (0004) : réveils PAR UTILISATEUR (`subscribeUser`), jamais par compte. Le réveil n'est qu'un signal : la session
// relit son propre compteur sous la RLS du destinataire. Filet : tous les abonnés utilisateur sont réveillés à chaque (re)connexion
// de l'écoute et au plus une fois par `fallbackMs`.

/** Source de notifications « le journal de ce compte a bougé ». Les réveils ne sont qu'un signal : ils peuvent manquer ou être en double. */
export interface ChangeNotifier {
  start(handlers: { onNotify: (accountId: string) => void; onUp: () => void; onDown: () => void; /** Notification in-app pour ce seul utilisateur. */ onUserNotify?: (accountId: string, userId: string) => void }): Promise<void>;
  stop(): Promise<void>;
}

export interface ChangeHub {
  /** Abonne une session au compte de `ctx` ; `wake` est appelé quand la tête du journal a changé (et une fois à l'abonnement). */
  subscribe(ctx: RequestContext, wake: () => void): () => void;
  /** Abonne une session aux réveils de SON utilisateur (compte + utilisateur de `ctx`) : nouvelle notification, marquage lu. */
  subscribeUser(ctx: RequestContext, wake: () => void): () => void;
  close(): void;
}

interface Entry {
  ctx: RequestContext;
  wakes: Set<() => void>;
  /** null = inconnu : le prochain passage réveille tout le monde (nouvel abonné, ou lecture précédente en échec). */
  head: string | null;
  busy: boolean;
  again: boolean;
}

export interface ChangeHubOptions {
  db: Db;
  intervalMs: number;
  notifier?: ChangeNotifier;
  /** Période du filet de sécurité quand l'écoute est établie (défaut 30 s). */
  fallbackMs?: number;
  onError?: (err: unknown) => void;
}

export function createChangeHub(opts: ChangeHubOptions): ChangeHub {
  const accounts = new Map<string, Entry>();
  const users = new Map<string, Set<() => void>>(); // clé `${accountId}:${userId}`
  let closed = false;
  let lastUserSweep = Date.now();
  const wakeUsers = (key?: string) => {
    lastUserSweep = key === undefined ? Date.now() : lastUserSweep;
    for (const [k, wakes] of users) if (key === undefined || k === key) for (const w of [...wakes]) w();
  };

  let listening = false;
  let lastFull = 0;
  const fallbackMs = opts.fallbackMs ?? 30_000;

  /** Lit la tête d'un compte et réveille ses sessions si elle a bougé. Les lectures d'un même compte ne se chevauchent pas : une demande arrivée pendant une lecture en provoque une seconde. */
  async function check(entry: Entry) {
    if (entry.busy) { entry.again = true; return; }
    entry.busy = true;
    try {
      do {
        entry.again = false;
        try {
          const head = await withContext(opts.db, entry.ctx, (tx) => readChangeHead(tx, entry.ctx.accountId));
          if (head === entry.head) continue;
          entry.head = head;
          for (const wake of [...entry.wakes]) wake();
        } catch (err) {
          entry.head = null; // on ne sait plus : réveiller au prochain passage réussi
          opts.onError?.(err);
        }
      } while (entry.again);
    } finally {
      entry.busy = false;
    }
  }

  async function tick(force = false) {
    if (Date.now() - lastUserSweep >= fallbackMs) wakeUsers();
    if (!force && listening && Date.now() - lastFull < fallbackMs) return; // l'écoute porte le flux : seul le filet repasse
    lastFull = Date.now();
    await Promise.all([...accounts.values()].map(check));
  }

  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();

  const started = opts.notifier?.start({
    onNotify: (accountId) => { const e = accounts.get(accountId); if (e) void check(e); },
    onUserNotify: (accountId, userId) => wakeUsers(`${accountId}:${userId}`),
    // À chaque (re)connexion : des notifications ont pu être perdues pendant la coupure, tout le monde relit.
    onUp: () => { listening = true; for (const e of accounts.values()) e.head = null; wakeUsers(); void tick(true); },
    onDown: () => { listening = false; },
  }).catch((err) => opts.onError?.(err));

  return {
    subscribe(ctx, wake) {
      if (closed) return () => {};
      let entry = accounts.get(ctx.accountId);
      if (!entry) accounts.set(ctx.accountId, (entry = { ctx, wakes: new Set(), head: null, busy: false, again: false }));
      entry.head = null; // l'arrivant a pu lire le journal avant la dernière tête vue : un réveil de rattrapage au prochain passage
      entry.wakes.add(wake);
      if (listening) void check(entry); // le minuteur dort : le réveil de rattrapage est immédiat
      const e = entry;
      return () => {
        e.wakes.delete(wake);
        if (e.wakes.size === 0 && accounts.get(ctx.accountId) === e) accounts.delete(ctx.accountId);
      };
    },
    subscribeUser(ctx, wake) {
      if (closed) return () => {};
      const key = `${ctx.accountId}:${ctx.userId}`;
      let set = users.get(key);
      if (!set) users.set(key, (set = new Set()));
      set.add(wake);
      const s = set;
      return () => {
        s.delete(wake);
        if (s.size === 0 && users.get(key) === s) users.delete(key);
      };
    },
    close() {
      closed = true;
      users.clear();
      clearInterval(timer);
      void started?.then(() => opts.notifier?.stop()).catch((err) => opts.onError?.(err));
      accounts.clear();
    },
  };
}
