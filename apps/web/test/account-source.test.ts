// Réglages du compte (RT-041) : sources API et démo (If-Match, codes du contrat, règles de l'API rejouées en démo) et report d'une
// écriture sur le Planning (accountChanged : semaine, seuil et fuseau à jour tout de suite, puis relecture du Schedule).
import type { AccountSettings, ScheduleResponse } from "@wnext/contracts";
import { viewAt } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createApiAccountSource, createDemoAccountSource, meAccountOf, scheduleAccountOf, timeZones } from "../src/data/account-source";
import { createDemoSource } from "../src/data/demo-source";
import { createScheduleSource } from "../src/data/schedule-source";
import { demoSchedule } from "../src/demo";

const settings: AccountSettings = { id: "1", version: 4, name: "A", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr", capacityThresholds: { underPercent: 80 } };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

describe("source API", () => {
  it("GET puis PATCH avec If-Match = version lue ; erreur : code et params du contrat", async () => {
    const calls: Array<{ method: string; headers: Record<string, string>; body?: unknown }> = [];
    let reply: { status: number; body: unknown } = { status: 200, body: settings };
    const fetch = async (_url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> => {
      calls.push({ method: init?.method ?? "GET", headers: init?.headers ?? {}, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      return { status: reply.status, json: async () => reply.body };
    };
    const src = createApiAccountSource(createClient({ baseUrl: "", fetch }));
    expect(await src.get()).toEqual({ ok: true, value: settings });
    reply = { status: 200, body: { ...settings, version: 5, weekStart: 7 } };
    expect(await src.update(settings, { weekStart: 7 })).toEqual({ ok: true, value: { ...settings, version: 5, weekStart: 7 } });
    expect(calls[1]).toMatchObject({ method: "PATCH", headers: { "If-Match": '"4"' }, body: { weekStart: 7 } });
    reply = { status: 409, body: { code: "VERSION_CONFLICT", params: { currentVersion: 6 }, requestId: "r" } };
    expect(await src.update(settings, { weekStart: 2 })).toEqual({ ok: false, error: { code: "VERSION_CONFLICT", params: { currentVersion: 6 } } });
  });
});

describe("source démo", () => {
  it("version, fuseau connu, semaine et seuil bornés, comme l'API", async () => {
    const src = createDemoAccountSource(settings);
    expect(await src.update({ ...settings, version: 3 }, { weekStart: 2 })).toEqual({ ok: false, error: { code: "VERSION_CONFLICT", params: { currentVersion: 4 } } });
    expect(await src.update(settings, { timezone: "Mars/Olympus_Mons" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", params: { field: "timezone" } } });
    expect(await src.update(settings, { capacityThresholds: { underPercent: 0 } })).toMatchObject({ ok: false, error: { params: { field: "capacityThresholds" } } });
    expect(await src.update(settings, {})).toMatchObject({ ok: false, error: { params: { field: "body" } } });
    const r = await src.update(settings, { timezone: "UTC", weekStart: 7, capacityThresholds: { underPercent: 50 } });
    expect(r).toEqual({ ok: true, value: { ...settings, version: 5, timezone: "UTC", weekStart: 7, capacityThresholds: { underPercent: 50 } } });
    expect(await src.get()).toEqual(r);
  });
  it("fuseaux : liste IANA du navigateur, UTC compris", () => {
    const z = timeZones();
    expect(z).toContain("Europe/Paris");
    expect(z).toContain("UTC");
  });
  it("projections vers /me et vers le Schedule", () => {
    expect(meAccountOf(settings)).toEqual({ id: "1", name: "A", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr" });
    expect(scheduleAccountOf(settings)).toEqual({ weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" });
  });
});

describe("Planning après écriture du compte (accountChanged)", () => {
  const next: ScheduleResponse["account"] = { weekStart: 7, capacityThresholds: { underPercent: 50 }, timezone: "America/New_York" };

  it("démo : semaine, seuil et fuseau du Planning à jour tout de suite", () => {
    const src = createDemoSource(demoSchedule("2026-10-20", 4));
    src.accountChanged!(next);
    expect(src.getState().data!.account).toEqual(next);
  });

  it("API : compte à jour tout de suite, puis le Schedule est relu au prochain démarrage", async () => {
    const urls: string[] = [];
    const fetch = async (url: string): Promise<FetchResponse> => {
      urls.push(url);
      const q = new URL(url, "http://x").searchParams;
      const body: ScheduleResponse = {
        window: { from: q.get("from")!, to: q.get("to")! }, changeCursor: "5", page: { nextCursor: null, total: 0 },
        account: urls.length > 1 ? next : { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
        people: [], allocations: [], timeoffs: [], holidays: [], projects: [], timeoffTypes: [], departments: [], roles: [],
      };
      return { status: 200, json: async () => body };
    };
    const src = createScheduleSource({ api: createClient({ baseUrl: "", fetch }) });
    src.setViewport(viewAt("2026-10-19", "day", 960));
    src.start();
    await flush();
    const loaded = urls.length;
    expect(loaded).toBeGreaterThan(0);
    src.stop();
    src.accountChanged!(next);
    expect(src.getState().data!.account).toEqual(next);
    src.start();
    await flush();
    expect(urls.length).toBeGreaterThan(loaded);
    expect(src.getState().data!.account).toEqual(next);
  });
});
