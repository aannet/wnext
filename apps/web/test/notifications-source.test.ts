// Source des notifications in-app (US-7.3) : API (client généré simulé) et démo locale ; compteur poussé par le temps réel.
import { Notification } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createApiNotificationsSource, createDemoNotificationsSource, demoNotifications } from "../src/data/notifications-source";

const TODAY = "2026-10-20";
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const base = demoNotifications(TODAY, new Date("2026-10-20T10:00:00Z"));

describe("démo", () => {
  it("notifications de démonstration conformes au contrat : deux non lues, une lue", () => {
    for (const n of base) expect(Notification.safeParse(n).success).toBe(true);
    expect(base.filter((n) => n.readAt === null)).toHaveLength(2);
  });
  it("refresh, marquer lu (idempotent), tout marquer lu, préférences par type", async () => {
    const s = createDemoNotificationsSource(base);
    let renders = 0;
    s.subscribe(() => renders++);
    await s.refresh();
    expect(s.getState()).toMatchObject({ unreadCount: 2, loaded: true, error: false });
    await s.markRead("demo-n3");
    await s.markRead("demo-n3");
    expect(s.getState().unreadCount).toBe(1);
    expect(s.getState().items.find((n) => n.id === "demo-n3")!.readAt).not.toBeNull();
    await s.markAllRead();
    expect(s.getState().unreadCount).toBe(0);
    expect(s.getState().items.every((n) => n.readAt !== null)).toBe(true);
    await s.loadPreferences();
    expect(s.getState().preferences!.map((p) => p.enabled)).toEqual([true, true, true]);
    await s.setPreference("timeoff_decided", false);
    expect(s.getState().preferences).toEqual([{ type: "allocation_changed", enabled: true }, { type: "timeoff_decided", enabled: false }, { type: "edit_conflict", enabled: true }]);
    expect(renders).toBeGreaterThan(4);
  });
  it("notification inconnue : erreur, état conservé ; l'action suivante l'efface", async () => {
    const s = createDemoNotificationsSource(base);
    await s.refresh();
    await s.markRead("nope");
    expect(s.getState()).toMatchObject({ error: true, unreadCount: 2 });
    await s.refresh();
    expect(s.getState().error).toBe(false);
  });
});

describe("API", () => {
  const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
  const ko = { ok: false as const, status: 500, error: { code: "INTERNAL_ERROR" as const, params: {}, requestId: "r" } };
  function api() {
    const calls: string[] = [];
    let items = base.map((n) => ({ ...n }));
    return {
      calls,
      api: {
        listNotifications: async (q: { limit?: number } = {}) => { calls.push(`list:${q.limit}`); return ok({ items, page: { nextCursor: null, total: items.length }, unreadCount: items.filter((n) => !n.readAt).length }); },
        markNotificationRead: async ({ path }: { path: { id: string } }) => { calls.push(`read:${path.id}`); items = items.map((n) => (n.id === path.id ? { ...n, readAt: "2026-10-20T10:01:00.000Z" } : n)); return ok(items.find((n) => n.id === path.id)!); },
        markAllNotificationsRead: async () => { calls.push("readAll"); return ok({ marked: 2, unreadCount: 0 }); },
        getNotificationPreferences: async () => ko,
        updateNotificationPreferences: async ({ body }: { body: { items: Array<{ type: string; enabled: boolean }> } }) => { calls.push(`prefs:${JSON.stringify(body.items)}`); return ok({ items: [{ type: "allocation_changed" as const, enabled: false }] }); },
      },
    };
  }
  it("appelle le client généré ; un refus lève error sans perdre l'état", async () => {
    const { api: a, calls } = api();
    const s = createApiNotificationsSource(a as never);
    await s.refresh();
    await s.markRead("demo-n2");
    await s.markAllRead();
    await s.setPreference("allocation_changed", false);
    await s.loadPreferences();
    expect(calls).toEqual(["list:50", "read:demo-n2", "readAll", 'prefs:[{"type":"allocation_changed","enabled":false}]']);
    expect(s.getState()).toMatchObject({ unreadCount: 0, error: true, preferences: [{ type: "allocation_changed", enabled: false }] });
  });
  it("temps réel : le compteur poussé met à jour le badge ; liste rechargée seulement si déjà affichée", async () => {
    const { api: a, calls } = api();
    const s = createApiNotificationsSource(a as never);
    s.pushUnread(4);
    expect(s.getState().unreadCount).toBe(4);
    expect(calls).toEqual([]);
    await s.refresh();
    s.pushUnread(7);
    await flush();
    expect(calls).toEqual(["list:50", "list:50"]);
    s.pushUnread(2); // identique au compteur relu : rien
    await flush();
    expect(calls).toHaveLength(2);
  });
  it("panne réseau : error", async () => {
    const s = createApiNotificationsSource({ listNotifications: async () => { throw new TypeError("réseau"); } } as never);
    await s.refresh();
    expect(s.getState().error).toBe(true);
  });
});

describe("courses (réponses dans le désordre)", () => {
  // Client simulé dont chaque liste répond quand le test le décide (réponse figée au moment de l'appel, comme le serveur).
  const deferredApi = () => {
    const pending: Array<() => void> = [];
    let server = { items: base, unreadCount: 2 };
    const api = {
      listNotifications: () => {
        const snapshot = server;
        return new Promise((resolve) => pending.push(() => resolve({ ok: true, data: { items: snapshot.items, page: { nextCursor: null, total: snapshot.items.length }, unreadCount: snapshot.unreadCount } })));
      },
      markAllNotificationsRead: async () => {
        server = { items: base.map((n) => ({ ...n, readAt: n.readAt ?? "2026-10-20T10:05:00.000Z" })), unreadCount: 0 };
        return { ok: true, data: { marked: 2, unreadCount: 0 } };
      },
    };
    return { api, pending };
  };

  it("une liste partie AVANT « tout marquer lu » et revenue après ne ressuscite pas les non lues", async () => {
    const { api: a, pending } = deferredApi();
    const s = createApiNotificationsSource(a as never);
    const stale = s.refresh(); // partie avant le marquage : le serveur a encore 2 non lues
    await s.markAllRead();
    expect(s.getState().unreadCount).toBe(0);
    pending.shift()!();
    await stale;
    expect(s.getState().unreadCount).toBe(0);
    expect(s.getState().items.every((n) => n.readAt !== null)).toBe(true);
  });

  it("deux listes dans le désordre : la plus récente l'emporte ; un compteur poussé après le départ d'une liste l'emporte aussi", async () => {
    const { api: a, pending } = deferredApi();
    const s = createApiNotificationsSource(a as never);
    const first = s.refresh();
    await a.markAllNotificationsRead(); // le serveur change (autre onglet)
    const second = s.refresh();
    pending[1]!();
    await second;
    pending[0]!();
    await first;
    expect(s.getState().unreadCount).toBe(0);
    const third = s.refresh();
    s.pushUnread(5); // plus récent que la liste en vol (qui relance sa propre liste, laissée en attente ici)
    pending[2]!();
    await third;
    expect(s.getState().unreadCount).toBe(5);
  });
});
