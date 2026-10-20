// Sources de vues : API (client simulé : requêtes, If-Match, pagination, codes d'erreur) et démo (règles et persistance).
import { describe, expect, it, vi } from "vitest";
import type { SavedView } from "@wnext/contracts";
import { createClient, type FetchResponse } from "../src/api/client.gen";
import { createApiViewsSource, createDemoViewsSource, demoSeedViews } from "../src/data/views-source";

const view = (over: Partial<SavedView> = {}): SavedView => ({ id: "1", version: 1, kind: "schedule", name: "V", filters: {}, shared: false, position: 0, ownerId: "9", canManage: true, ...over });

function apiWith(respond: (req: { method: string; url: string; headers: Record<string, string>; body?: unknown }) => { status: number; body?: unknown }) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetch = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> => {
    const req = { method: init.method, url, headers: init.headers ?? {}, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(req);
    const r = respond(req);
    return { status: r.status, json: async () => r.body };
  };
  return { source: createApiViewsSource(createClient({ baseUrl: "", fetch })), calls };
}

describe("createApiViewsSource", () => {
  it("liste toutes les pages (kind=schedule), suit le curseur", async () => {
    const { source, calls } = apiWith((req) => req.url.includes("cursor=c2")
      ? { status: 200, body: { items: [view({ id: "2" })], page: { nextCursor: null, total: 2 } } }
      : { status: 200, body: { items: [view({ id: "1" })], page: { nextCursor: "c2", total: 2 } } });
    const r = await source.list();
    expect(r.ok && r.value.map((v) => v.id)).toEqual(["1", "2"]);
    expect(calls[0]!.url).toContain("kind=schedule");
    expect(calls[1]!.url).toContain("cursor=c2");
  });

  it("crée (POST, kind schedule), modifie et supprime avec If-Match = version lue", async () => {
    const { source, calls } = apiWith((req) => (req.method === "DELETE" ? { status: 204 } : { status: req.method === "POST" ? 201 : 200, body: view({ version: 2 }) }));
    expect((await source.create({ name: "V", filters: { zoom: "week" }, shared: true })).ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/v1/saved-views", body: { kind: "schedule", name: "V", filters: { zoom: "week" }, shared: true } });
    await source.update(view({ id: "7", version: 3 }), { name: "W" });
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "/api/v1/saved-views/7", headers: { "If-Match": '"3"' }, body: { name: "W" } });
    expect(await source.remove(view({ id: "7", version: 4 }))).toEqual({ ok: true, value: null });
    expect(calls[2]).toMatchObject({ method: "DELETE", url: "/api/v1/saved-views/7", headers: { "If-Match": '"4"' } });
  });

  it("rend le code stable du contrat ; 5xx sans corps ou exception réseau : INTERNAL_ERROR", async () => {
    const conflict = apiWith(() => ({ status: 409, body: { code: "ALREADY_EXISTS", params: {}, requestId: "r" } }));
    expect(await conflict.source.create({ name: "V", filters: {}, shared: false })).toEqual({ ok: false, error: "ALREADY_EXISTS" });
    const forbidden = apiWith(() => ({ status: 403 }));
    expect(await forbidden.source.update(view(), { shared: true })).toEqual({ ok: false, error: "FORBIDDEN" });
    const boom = createApiViewsSource(createClient({ baseUrl: "", fetch: vi.fn().mockRejectedValue(new Error("réseau")) }));
    expect(await boom.list()).toEqual({ ok: false, error: "INTERNAL_ERROR" });
  });

  it("reload : la vue, ou null si elle n'existe plus", async () => {
    expect(await apiWith(() => ({ status: 200, body: view({ id: "5" }) })).source.reload("5")).toMatchObject({ id: "5" });
    expect(await apiWith(() => ({ status: 404, body: { code: "NOT_FOUND", params: {}, requestId: "r" } })).source.reload("5")).toBeNull();
  });
});

describe("createDemoViewsSource", () => {
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

  it("part de la graine, crée, renomme, supprime avec contrôle de nom et de version", async () => {
    const s = createDemoViewsSource(demoSeedViews(), memory());
    const created = await s.create({ name: "Ma vue", filters: { roleIds: ["1"] }, shared: false });
    expect(created.ok && created.value).toMatchObject({ name: "Ma vue", version: 1, canManage: true, shared: false });
    expect(await s.create({ name: "Ma vue", filters: {}, shared: false })).toEqual({ ok: false, error: "ALREADY_EXISTS" });
    const v = (created as { value: SavedView }).value;
    expect(await s.update(v, { name: "Projet A" })).toEqual({ ok: false, error: "ALREADY_EXISTS" });
    const renamed = await s.update(v, { name: "Renommée" });
    expect(renamed.ok && renamed.value.version).toBe(2);
    expect(await s.update(v, { name: "Périmée" })).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    expect(await s.remove(v)).toEqual({ ok: false, error: "VERSION_CONFLICT" });
    expect(await s.remove((renamed as { value: SavedView }).value)).toEqual({ ok: true, value: null });
    expect(await s.reload(v.id)).toBeNull();
  });

  it("une vue partagée d'un autre n'est pas modifiable (canManage faux : FORBIDDEN)", async () => {
    const s = createDemoViewsSource(demoSeedViews(), memory());
    const other = demoSeedViews().find((x) => !x.canManage)!;
    expect(await s.update(other, { name: "x" })).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await s.remove(other)).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("persiste dans le stockage : une nouvelle source (rechargement) retrouve les vues ; stockage absent ou illisible toléré", async () => {
    const storage = memory();
    await createDemoViewsSource(demoSeedViews(), storage).create({ name: "Gardée", filters: {}, shared: false });
    const again = await createDemoViewsSource(demoSeedViews(), storage).list();
    expect(again.ok && again.value.map((v) => v.name)).toContain("Gardée");
    storage.setItem("wnext.demo.views.v1", "{pas du json");
    const broken = await createDemoViewsSource(demoSeedViews(), storage).list();
    expect(broken.ok && broken.value).toHaveLength(3);
    expect((await createDemoViewsSource(demoSeedViews(), undefined).list()).ok).toBe(true);
  });
});
