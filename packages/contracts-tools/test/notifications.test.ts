// Contrat des notifications in-app (FR-10, US-7.3) : formes, préférences, routes documentées, message temps réel minimal.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { Notification, NotificationList, NotificationListQuery, NotificationPreferencesUpdate, NotificationType, RealtimeServerMessage, routes } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;
const counts = { created: 3, updated: 0, deleted: 0, approved: 0, declined: 0 };
const n = {
  id: "7", type: "allocation_changed", entity: "allocations", entityId: "12", actor: { id: "2", name: "Bea" }, counts,
  startDate: "2026-03-02", currentVersion: null, createdAt: "2026-10-20T08:00:00.000Z", readAt: null,
};

describe("Notification", () => {
  it("accepte les trois types ; auteur et dates nullables", () => {
    expect(NotificationType.options).toEqual(["allocation_changed", "timeoff_decided", "edit_conflict"]);
    expect(ok(Notification, n)).toBe(true);
    expect(ok(Notification, { ...n, type: "edit_conflict", entity: "people", startDate: null, currentVersion: 4, actor: null })).toBe(true);
    expect(ok(Notification, { ...n, actor: { id: "2", name: null }, readAt: "2026-10-20T09:00:00.000Z" })).toBe(true);
  });
  it.each([
    ["type inconnu", { ...n, type: "mail" }],
    ["entité hors liste", { ...n, entity: "users" }],
    ["compteur négatif", { ...n, counts: { ...counts, created: -1 } }],
    ["compteur manquant", { ...n, counts: { created: 1 } }],
  ])("refuse : %s", (_n, v) => expect(ok(Notification, v)).toBe(false));
  it("ne transporte aucune donnée métier sensible : champs inconnus retirés au parse", () => {
    const r = Notification.parse({ ...n, hoursPerDay: 8, costRate: 90, email: "a@b.c" });
    expect(JSON.stringify(r)).not.toMatch(/hoursPerDay|costRate|email/);
  });
  it("liste : compteur de non lues obligatoire ; filtre unread booléen", () => {
    expect(ok(NotificationList, { items: [n], page: { nextCursor: null, total: 1 }, unreadCount: 1 })).toBe(true);
    expect(ok(NotificationList, { items: [n], page: { nextCursor: null, total: 1 } })).toBe(false);
    expect(ok(NotificationListQuery, { unread: true, limit: 20 })).toBe(true);
    expect(ok(NotificationListQuery, { unread: "oui" })).toBe(false);
  });
});

describe("NotificationPreferencesUpdate", () => {
  it("accepte un ou plusieurs types distincts ; refuse vide, répété, inconnu", () => {
    expect(ok(NotificationPreferencesUpdate, { items: [{ type: "edit_conflict", enabled: false }] })).toBe(true);
    expect(ok(NotificationPreferencesUpdate, { items: [] })).toBe(false);
    expect(ok(NotificationPreferencesUpdate, { items: [{ type: "edit_conflict", enabled: false }, { type: "edit_conflict", enabled: true }] })).toBe(false);
    expect(ok(NotificationPreferencesUpdate, { items: [{ type: "digest", enabled: false }] })).toBe(false);
  });
});

describe("routes et temps réel", () => {
  it("cinq opérations, 401 documenté partout, 404 sur le marquage d'une notification d'autrui", () => {
    const ops = routes.filter((r) => r.path.startsWith("/api/v1/notification"));
    expect(ops.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "get /api/v1/notification-preferences", "get /api/v1/notifications", "post /api/v1/notifications/read-all",
      "post /api/v1/notifications/{id}/read", "put /api/v1/notification-preferences",
    ]);
    for (const r of ops) expect(r.responses[401]).toBeDefined();
    expect(ops.find((r) => r.operationId === "markNotificationRead")!.responses[404]).toBeDefined();
    const spec = buildSpec() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/v1/notifications", "/api/v1/notifications/{id}/read", "/api/v1/notification-preferences"]));
  });
  it("message notifications : le seul compteur", () => {
    expect(ok(RealtimeServerMessage, { v: 1, type: "notifications", unreadCount: 3 })).toBe(true);
    expect(ok(RealtimeServerMessage, { v: 1, type: "notifications", unreadCount: -1 })).toBe(false);
    const r = RealtimeServerMessage.parse({ v: 1, type: "notifications", unreadCount: 1, items: [n] });
    expect(JSON.stringify(r)).not.toMatch(/items|allocation/);
  });
});
