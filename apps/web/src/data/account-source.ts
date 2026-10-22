// Réglages du compte (RT-041) : deux sources de même interface, comme pour les autres écrans.
//  * createApiAccountSource : GET /api/v1/account, PATCH avec If-Match = version lue.
//  * createDemoAccountSource (?demo=1) : en mémoire, mêmes règles que l'API (version, fuseau connu, semaine 1-7, seuil 1-100).
// Pas de diffusion temps réel du compte : l'appelant relit /me et met à jour le Planning après une écriture réussie.
import type { AccountPatch, AccountSettings, Me, ScheduleResponse } from "@wnext/contracts";
import type { createClient } from "../api/client.gen";
import type { DirError, DirResult } from "./people-source";
import { errorCodeOf } from "./schedule-source";

export interface AccountSource {
  get(): Promise<DirResult<AccountSettings>>;
  /** If-Match = current.version ; VERSION_CONFLICT porte params.currentVersion. */
  update(current: AccountSettings, patch: AccountPatch): Promise<DirResult<AccountSettings>>;
}

const fail = (code: DirError["code"], params: DirError["params"] = {}): { ok: false; error: DirError } => ({ ok: false, error: { code, params } });

type Raw<T> = Promise<{ ok: true; data: T } | { ok: false; status: number; error: unknown }>;
async function call<T>(run: () => Raw<T>): Promise<DirResult<T>> {
  try {
    const r = await run();
    if (r.ok) return { ok: true, value: r.data };
    const params = (r.error as { params?: DirError["params"] } | null | undefined)?.params;
    return fail(errorCodeOf(r.status, r.error), params && typeof params === "object" ? params : {});
  } catch {
    return fail("INTERNAL_ERROR");
  }
}

export function createApiAccountSource(api: Pick<ReturnType<typeof createClient>, "getAccount" | "updateAccount">): AccountSource {
  return {
    get: () => call(() => api.getAccount()),
    update: (current, patch) => call(() => api.updateAccount({ headers: { "If-Match": `"${current.version}"` }, body: patch })),
  };
}

/** Fuseaux connus du navigateur (liste IANA canonique) ; UTC y est ajouté s'il manque (valeur par défaut du compte). */
export function timeZones(): string[] {
  const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return list.includes("UTC") ? [...list] : [...list, "UTC"].sort();
}

export function createDemoAccountSource(initial: AccountSettings): AccountSource {
  let cur: AccountSettings = { ...initial, capacityThresholds: { ...initial.capacityThresholds } };
  const zones = new Set(timeZones());
  return {
    get: async () => ({ ok: true, value: cur }),
    async update(current, patch) {
      if (current.version !== cur.version) return fail("VERSION_CONFLICT", { currentVersion: cur.version });
      if (!Object.keys(patch).length) return fail("VALIDATION_FAILED", { field: "body" });
      if (patch.timezone !== undefined && !zones.has(patch.timezone)) return fail("VALIDATION_FAILED", { field: "timezone" });
      if (patch.weekStart !== undefined && !(Number.isInteger(patch.weekStart) && patch.weekStart >= 1 && patch.weekStart <= 7)) return fail("VALIDATION_FAILED", { field: "weekStart" });
      const under = patch.capacityThresholds?.underPercent;
      if (under !== undefined && !(under >= 1 && under <= 100)) return fail("VALIDATION_FAILED", { field: "capacityThresholds" });
      cur = {
        ...cur, ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}), ...(patch.weekStart !== undefined ? { weekStart: patch.weekStart } : {}),
        ...(patch.defaultLocale !== undefined ? { defaultLocale: patch.defaultLocale } : {}),
        capacityThresholds: under === undefined ? cur.capacityThresholds : { underPercent: under }, version: cur.version + 1,
      };
      return { ok: true, value: cur };
    },
  };
}

/** Compte de GET /me à jour des réglages écrits (sans attendre la relecture). */
export const meAccountOf = (s: AccountSettings): Me["account"] => ({ id: s.id, name: s.name, timezone: s.timezone, weekStart: s.weekStart, defaultLocale: s.defaultLocale });
/** Compte de la réponse du Schedule (semaine, seuil, fuseau). */
export const scheduleAccountOf = (s: AccountSettings): ScheduleResponse["account"] => ({ weekStart: s.weekStart, capacityThresholds: { underPercent: s.capacityThresholds.underPercent }, timezone: s.timezone });
