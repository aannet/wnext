// Contrat temps réel : forme des messages, cohérence delete/version, absence de données métier.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import { Change, REALTIME_RETRY_AFTER_SECONDS, REALTIME_UPGRADE_STATUS, RealtimeClientMessage, RealtimeServerMessage } from "@wnext/contracts";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;
const upd = { seq: "5", entity: "allocations", id: "9", op: "update", version: 3 };

describe("Change", () => {
  it("accepte insert/update avec version, delete sans", () => {
    expect(ok(Change, upd)).toBe(true);
    expect(ok(Change, { ...upd, op: "delete", version: null })).toBe(true);
  });
  it.each([
    ["delete avec version", { ...upd, op: "delete" }],
    ["update sans version", { ...upd, version: null }],
    ["entité inconnue", { ...upd, entity: "users" }],
    ["seq non numérique", { ...upd, seq: "abc" }],
    ["version 0", { ...upd, version: 0 }],
  ])("refuse : %s", (_n, v) => expect(ok(Change, v)).toBe(false));
});

describe("messages", () => {
  it("client : seul subscribe existe (pas d'écriture par le canal)", () => {
    expect(ok(RealtimeClientMessage, { v: 1, type: "subscribe", cursor: "0" })).toBe(true);
    expect(ok(RealtimeClientMessage, { v: 1, type: "subscribe", cursor: "-1" })).toBe(false);
    expect(ok(RealtimeClientMessage, { v: 1, type: "create", cursor: "0" })).toBe(false);
    expect(ok(RealtimeClientMessage, { v: 2, type: "subscribe", cursor: "0" })).toBe(false);
  });
  it("serveur : changes / ready / resync / error", () => {
    expect(ok(RealtimeServerMessage, { v: 1, type: "changes", changes: [upd], cursor: "5", hasMore: false })).toBe(true);
    expect(ok(RealtimeServerMessage, { v: 1, type: "ready", cursor: "5" })).toBe(true);
    expect(ok(RealtimeServerMessage, { v: 1, type: "resync", reason: "cursor_expired", head: "9" })).toBe(true);
    expect(ok(RealtimeServerMessage, { v: 1, type: "error", code: "SCHEDULE_CURSOR_INVALID", params: {} })).toBe(true);
  });
  it.each([
    ["lot vide", { v: 1, type: "changes", changes: [], cursor: "5", hasMore: false }],
    ["code d'erreur inconnu", { v: 1, type: "error", code: "NOPE", params: {} }],
    ["type inconnu", { v: 1, type: "data", cursor: "1" }],
    ["version de protocole inconnue", { v: 2, type: "ready", cursor: "1" }],
    ["raison libre", { v: 1, type: "resync", reason: "too old", head: "9" }],
  ])("serveur refuse : %s", (_n, v) => expect(ok(RealtimeServerMessage, v)).toBe(false));
  it("ne transporte aucune donnée métier : champs inconnus retirés au parse", () => {
    const r = RealtimeServerMessage.parse({ v: 1, type: "changes", changes: [{ ...upd, hoursPerDay: 8, email: "a@b.c" }], cursor: "5", hasMore: false });
    expect(JSON.stringify(r)).not.toMatch(/hoursPerDay|email/);
  });
});

describe("refus à l'upgrade", () => {
  it("statuts et attente minimale figés par le contrat (le client s'y adosse)", () => {
    expect(REALTIME_UPGRADE_STATUS).toEqual({ unauthenticated: 401, tooManyConnections: 429 });
    expect(Number.isInteger(REALTIME_RETRY_AFTER_SECONDS) && REALTIME_RETRY_AFTER_SECONDS > 0).toBe(true);
  });
});
