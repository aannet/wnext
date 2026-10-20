// Notifications in-app (FR-10, US-7.3) côté écran : même interface pour l'API et pour la démo (?demo=1, sans réseau).
//  * API : GET /notifications, POST .../read, POST .../read-all, GET/PUT /notification-preferences (client généré).
//  * Temps réel : le message `notifications` ne porte que le compteur ; `pushUnread` le reçoit (schedule-source -> realtime/client)
//    et recharge la liste si elle a déjà été affichée.
//  * Un échec laisse l'état précédent et lève `error` (traduit par l'écran) ; l'action suivante l'efface.
import type { Notification, NotificationType } from "@wnext/contracts";
import type { NotificationPreference } from "../api/client.gen";
import type { createClient } from "../api/client.gen";

export interface NotificationsState {
  /** Les plus récentes d'abord (première page). */
  items: Notification[];
  unreadCount: number;
  /** null tant qu'elles n'ont pas été lues. */
  preferences: NotificationPreference[] | null;
  loaded: boolean;
  error: boolean;
}

export interface NotificationsSource {
  getState(): NotificationsState;
  subscribe(listener: () => void): () => void;
  /** Recharge la liste et le compteur. */
  refresh(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  loadPreferences(): Promise<void>;
  setPreference(type: NotificationType, enabled: boolean): Promise<void>;
  /** Compteur poussé par le temps réel. */
  pushUnread(unreadCount: number): void;
}

/** Opérations élémentaires ; null = échec (réseau ou refus). */
interface Backend {
  list(): Promise<{ items: Notification[]; unreadCount: number } | null>;
  read(id: string): Promise<Notification | null>;
  readAll(): Promise<number | null>;
  preferences(): Promise<NotificationPreference[] | null>;
  setPreference(type: NotificationType, enabled: boolean): Promise<NotificationPreference[] | null>;
}

const PAGE = 50;

function createSource(backend: Backend): NotificationsSource {
  let state: NotificationsState = { items: [], unreadCount: 0, preferences: null, loaded: false, error: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<NotificationsState>) => { state = { ...state, ...patch }; for (const l of [...listeners]) l(); };
  const guard = async <T>(p: Promise<T | null>, apply: (v: T) => Partial<NotificationsState>) => {
    let v: T | null;
    try { v = await p; } catch { v = null; }
    set(v === null ? { error: true } : { ...apply(v), error: false });
  };
  // Époque de l'état : avancée au départ de chaque liste et à chaque marquage ou compteur poussé. Une liste revenue alors que l'époque
  // a bougé est périmée (partie avant un marquage, doublée par une liste plus récente) : ignorée, sinon elle ressusciterait des non lues.
  let epoch = 0;
  const bump = <T>(p: Promise<T>) => p.finally(() => { epoch++; });
  const source: NotificationsSource = {
    getState: () => state,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    async refresh() {
      const mine = ++epoch;
      let r: Awaited<ReturnType<Backend["list"]>>;
      try { r = await backend.list(); } catch { r = null; }
      if (mine !== epoch) return;
      set(r === null ? { error: true } : { items: r.items, unreadCount: r.unreadCount, loaded: true, error: false });
    },
    markRead: (id) => guard(bump(backend.read(id)), (n) => {
      const was = state.items.find((x) => x.id === id);
      return { items: state.items.map((x) => (x.id === id ? n : x)), unreadCount: Math.max(0, state.unreadCount - (was && was.readAt === null && n.readAt !== null ? 1 : 0)) };
    }),
    markAllRead: () => guard(bump(backend.readAll()), (unreadCount) => ({ unreadCount, items: state.items.map((x) => (x.readAt === null ? { ...x, readAt: new Date().toISOString() } : x)) })),
    loadPreferences: () => guard(backend.preferences(), (preferences) => ({ preferences })),
    setPreference: (type, enabled) => guard(backend.setPreference(type, enabled), (preferences) => ({ preferences })),
    pushUnread(unreadCount) {
      if (unreadCount === state.unreadCount) return;
      epoch++;
      set({ unreadCount });
      if (state.loaded) void source.refresh();
    },
  };
  return source;
}

type Api = Pick<ReturnType<typeof createClient>, "listNotifications" | "markNotificationRead" | "markAllNotificationsRead" | "getNotificationPreferences" | "updateNotificationPreferences">;

export function createApiNotificationsSource(api: Api): NotificationsSource {
  return createSource({
    async list() { const r = await api.listNotifications({ limit: PAGE }); return r.ok ? { items: r.data.items, unreadCount: r.data.unreadCount } : null; },
    async read(id) { const r = await api.markNotificationRead({ path: { id } }); return r.ok ? r.data : null; },
    async readAll() { const r = await api.markAllNotificationsRead(); return r.ok ? r.data.unreadCount : null; },
    async preferences() { const r = await api.getNotificationPreferences(); return r.ok ? r.data.items : null; },
    async setPreference(type, enabled) { const r = await api.updateNotificationPreferences({ body: { items: [{ type, enabled }] } }); return r.ok ? r.data.items : null; },
  });
}

/** Démo : notifications locales, mêmes règles (marquage idempotent, préférences par type, trois types toujours listés). */
export function createDemoNotificationsSource(seed: Notification[]): NotificationsSource {
  let items = [...seed];
  const prefs = new Map<NotificationType, boolean>();
  const types: NotificationType[] = ["allocation_changed", "timeoff_decided", "edit_conflict"];
  const unread = () => items.filter((n) => n.readAt === null).length;
  const preferences = () => types.map((type) => ({ type, enabled: prefs.get(type) ?? true }));
  const stamp = () => new Date().toISOString();
  return createSource({
    list: async () => ({ items, unreadCount: unread() }),
    async read(id) {
      const n = items.find((x) => x.id === id);
      if (!n) return null;
      const read = n.readAt === null ? { ...n, readAt: stamp() } : n;
      items = items.map((x) => (x.id === id ? read : x));
      return read;
    },
    async readAll() { const at = stamp(); items = items.map((x) => (x.readAt === null ? { ...x, readAt: at } : x)); return 0; },
    preferences: async () => preferences(),
    async setPreference(type, enabled) { prefs.set(type, enabled); return preferences(); },
  });
}

/** Quelques notifications de démonstration, relatives à `today` (YYYY-MM-DD) : deux non lues, une lue. */
export function demoNotifications(today: string, now: Date = new Date()): Notification[] {
  const zero = { created: 0, updated: 0, deleted: 0, approved: 0, declined: 0 };
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return [
    { id: "demo-n3", type: "allocation_changed", entity: "allocations", entityId: "demo-a1", actor: { id: "demo-u2", name: "Camille Durand" },
      counts: { ...zero, created: 2, updated: 1 }, startDate: today, currentVersion: null, createdAt: ago(5), readAt: null },
    { id: "demo-n2", type: "timeoff_decided", entity: "timeoffs", entityId: "demo-t1", actor: { id: "demo-u2", name: "Camille Durand" },
      counts: { ...zero, approved: 1 }, startDate: today, currentVersion: null, createdAt: ago(90), readAt: null },
    { id: "demo-n1", type: "edit_conflict", entity: "allocations", entityId: "demo-a2", actor: { id: "demo-u3", name: "Lou Martin" },
      counts: zero, startDate: null, currentVersion: 3, createdAt: ago(60 * 26), readAt: ago(60 * 25) },
  ];
}
