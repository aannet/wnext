// Vues sauvegardées du Schedule (FR-10) : deux sources de même interface, comme pour les données du planning.
//  * createApiViewsSource : branchée sur /api/v1/saved-views (client généré) ; PATCH et DELETE portent If-Match = version lue.
//  * createDemoViewsSource (?demo=1) : vues en mémoire, doublées dans le stockage du navigateur (localStorage, s'il est
//    disponible) pour survivre à un rechargement ; mêmes règles de nom (ALREADY_EXISTS) et de version que l'API.
// Les erreurs sont les codes stables du contrat ; l'écran les traduit.
import type { ApiError, SavedView, ScheduleViewFilters } from "@wnext/contracts";
import type { createClient } from "../api/client.gen";
import { errorCodeOf } from "./schedule-source";

export type ViewsErrorCode = ApiError["code"];
export type ViewsResult<T> = { ok: true; value: T } | { ok: false; error: ViewsErrorCode };

export interface ViewsSource {
  list(): Promise<ViewsResult<SavedView[]>>;
  create(input: { name: string; filters: ScheduleViewFilters; shared: boolean }): Promise<ViewsResult<SavedView>>;
  update(view: SavedView, patch: { name?: string; filters?: ScheduleViewFilters; shared?: boolean }): Promise<ViewsResult<SavedView>>;
  remove(view: SavedView): Promise<ViewsResult<null>>;
  /** Relit une vue (après un VERSION_CONFLICT) ; null si elle n'existe plus. */
  reload(id: string): Promise<SavedView | null>;
}

const fail = (error: ViewsErrorCode): { ok: false; error: ViewsErrorCode } => ({ ok: false, error });
const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });
const PAGE = 200;

type ApiLike = Pick<ReturnType<typeof createClient>, "listSavedViews" | "createSavedView" | "getSavedView" | "updateSavedView" | "deleteSavedView">;

export function createApiViewsSource(api: ApiLike): ViewsSource {
  async function call<T>(run: () => Promise<{ ok: true; data: T } | { ok: false; status: number; error: unknown }>): Promise<ViewsResult<T>> {
    try {
      const r = await run();
      return r.ok ? { ok: true, value: r.data } : fail(errorCodeOf(r.status, r.error));
    } catch {
      return fail("INTERNAL_ERROR");
    }
  }
  return {
    async list() {
      const items: SavedView[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const r = await call(() => api.listSavedViews({ kind: "schedule", limit: PAGE, ...(cursor ? { cursor } : {}) }));
        if (!r.ok) return r;
        items.push(...r.value.items);
        if (!r.value.page.nextCursor) break;
        cursor = r.value.page.nextCursor;
      }
      return { ok: true, value: items };
    },
    create: (input) => call(() => api.createSavedView({ body: { kind: "schedule", ...input } })),
    update: (view, patch) => call(() => api.updateSavedView({ path: { id: view.id }, headers: ifMatch(view.version), body: patch })),
    async remove(view) {
      const r = await call(() => api.deleteSavedView({ path: { id: view.id }, headers: ifMatch(view.version) }));
      return r.ok ? { ok: true, value: null } : r;
    },
    async reload(id) {
      const r = await call(() => api.getSavedView({ path: { id } }));
      return r.ok ? r.value : null;
    },
  };
}

// --- Démo --------------------------------------------------------------------------------------------------------------
export interface ViewsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const STORAGE_KEY = "wnext.demo.views.v1";

/** localStorage du navigateur s'il répond (absent ou refusé en navigation privée : on reste en mémoire). */
export function browserStorage(): ViewsStorage | undefined {
  try {
    const s = globalThis.localStorage;
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return undefined;
  }
}

export function createDemoViewsSource(seed: readonly SavedView[], storage: ViewsStorage | undefined = browserStorage()): ViewsSource {
  let views: SavedView[] = [...seed];
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) views = JSON.parse(raw) as SavedView[];
  } catch { /* stockage illisible : on repart de la graine */ }
  let seq = 100;
  const persist = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(views)); } catch { /* quota ou refus : mémoire seule */ } };
  const taken = (name: string, except?: string) => views.some((v) => v.name === name && v.id !== except);
  const find = (v: SavedView) => views.find((x) => x.id === v.id);

  return {
    async list() { return { ok: true, value: views.map((v) => ({ ...v })) }; },
    async create(input) {
      if (taken(input.name)) return fail("ALREADY_EXISTS");
      const v: SavedView = { id: `demo-view-${++seq}`, version: 1, kind: "schedule", name: input.name, filters: input.filters, shared: input.shared, position: 0, ownerId: "demo", canManage: true };
      views = [...views, v];
      persist();
      return { ok: true, value: { ...v } };
    },
    async update(view, patch) {
      const cur = find(view);
      if (!cur) return fail("NOT_FOUND");
      if (!cur.canManage) return fail("FORBIDDEN");
      if (cur.version !== view.version) return fail("VERSION_CONFLICT");
      if (patch.name !== undefined && taken(patch.name, cur.id)) return fail("ALREADY_EXISTS");
      const next: SavedView = { ...cur, ...patch, version: cur.version + 1 };
      views = views.map((v) => (v.id === cur.id ? next : v));
      persist();
      return { ok: true, value: { ...next } };
    },
    async remove(view) {
      const cur = find(view);
      if (!cur) return fail("NOT_FOUND");
      if (!cur.canManage) return fail("FORBIDDEN");
      if (cur.version !== view.version) return fail("VERSION_CONFLICT");
      views = views.filter((v) => v.id !== cur.id);
      persist();
      return { ok: true, value: null };
    },
    async reload(id) { const v = views.find((x) => x.id === id); return v ? { ...v } : null; },
  };
}

/** Vues d'exemple de la démo (départements, rôles et projets de demoSchedule). */
export function demoSeedViews(): SavedView[] {
  const base = { version: 1, kind: "schedule" as const, position: 0, ownerId: "demo" };
  return [
    { ...base, id: "demo-view-1", name: "Design seniors", filters: { departmentIds: ["2"], roleIds: ["1"] }, shared: true, canManage: true },
    { ...base, id: "demo-view-2", name: "Projet A", filters: { projectIds: ["1"], zoom: "week" }, shared: false, canManage: true, position: 1 },
    { ...base, id: "demo-view-3", name: "Équipe Produit par rôle", filters: { departmentIds: ["1"], peopleSort: "role" }, shared: true, canManage: false, ownerId: "autre", position: 2 },
  ];
}
