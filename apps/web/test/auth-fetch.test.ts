// Fetch d'authentification (mode dev) : en-têtes x-dev-* ajoutés à chaque requête, rien si la configuration est incomplète.
import { describe, expect, it } from "vitest";
import { createClient, type Fetcher } from "../src/api/client.gen";
import { createAuthFetch, devAuthHeaders } from "../src/data/auth-fetch";

const ENV = { VITE_DEV_ACCOUNT_ID: "1", VITE_DEV_USER_ID: "1", VITE_DEV_ROLE: "admin" };

function recorder() {
  const seen: { url: string; init: Parameters<Fetcher>[1] }[] = [];
  const base: Fetcher = async (url, init) => { seen.push({ url, init }); return { status: 200, json: async () => ({}) }; };
  return { seen, base };
}

describe("auth-fetch", () => {
  it("ajoute l'identité de développement sans écraser les en-têtes du client généré", async () => {
    const r = recorder();
    const api = createClient({ baseUrl: "", fetch: createAuthFetch(ENV, r.base) });
    await api.getSchedule({ from: "2026-10-01", to: "2026-10-28" });
    expect(r.seen[0]!.url).toBe("/api/v1/schedule?from=2026-10-01&to=2026-10-28");
    expect(r.seen[0]!.init.headers).toEqual({ accept: "application/json", "x-dev-account-id": "1", "x-dev-user-id": "1", "x-dev-role": "admin" });
    expect(r.seen[0]!.init.method).toBe("GET");
  });

  it("configuration incomplète : aucune identité (l'API répondra 401)", async () => {
    expect(devAuthHeaders({ VITE_DEV_ACCOUNT_ID: "1", VITE_DEV_ROLE: "admin" })).toEqual({});
    const r = recorder();
    await createAuthFetch({}, r.base)("/api/v1/health", { method: "GET" });
    expect(r.seen[0]!.init).toEqual({ method: "GET", headers: {} });
  });
});
