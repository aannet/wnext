// Fetch d'authentification : fournisseur d'en-têtes asynchrone (dev : x-dev-* ; OIDC : Authorization: Bearer),
// et sur 401 une seule tentative de renouvellement avant de rendre la réponse (puis nouvelle connexion en OIDC).
import { describe, expect, it } from "vitest";
import { createClient, type Fetcher } from "../src/api/client.gen";
import { createAuthFetch, devAuthHeaders, devAuthProvider, oidcAuthProvider } from "../src/data/auth-fetch";

const ENV = { VITE_DEV_ACCOUNT_ID: "1", VITE_DEV_USER_ID: "1", VITE_DEV_ROLE: "admin" };

function recorder(statuses: number[] = []) {
  const seen: { url: string; init: Parameters<Fetcher>[1] }[] = [];
  const base: Fetcher = async (url, init) => { seen.push({ url, init }); return { status: statuses.shift() ?? 200, json: async () => ({}) }; };
  return { seen, base };
}

/** Session OIDC simulée : jeton courant, refresh qui réussit ou non, login compté. */
function fakeSession(refreshOk: boolean) {
  const s = { token: "at-1" as string | null, refreshes: 0, logins: 0 };
  return {
    s,
    session: {
      getAccessToken: async () => s.token,
      refresh: async () => { s.refreshes++; if (refreshOk) s.token = `at-${s.refreshes + 1}`; else s.token = null; return refreshOk; },
      login: async () => { s.logins++; },
    },
  };
}

describe("auth-fetch, mode dev", () => {
  it("ajoute l'identité de développement sans écraser les en-têtes du client généré", async () => {
    const r = recorder();
    const api = createClient({ baseUrl: "", fetch: createAuthFetch(devAuthProvider(ENV), r.base) });
    await api.getSchedule({ from: "2026-10-01", to: "2026-10-28" });
    expect(r.seen[0]!.url).toBe("/api/v1/schedule?from=2026-10-01&to=2026-10-28");
    expect(r.seen[0]!.init.headers).toEqual({ accept: "application/json", "x-dev-account-id": "1", "x-dev-user-id": "1", "x-dev-role": "admin" });
    expect(r.seen[0]!.init.method).toBe("GET");
  });

  it("configuration incomplète : aucune identité (l'API répondra 401), pas de nouvel essai", async () => {
    expect(devAuthHeaders({ VITE_DEV_ACCOUNT_ID: "1", VITE_DEV_ROLE: "admin" })).toEqual({});
    const r = recorder([401]);
    const res = await createAuthFetch(devAuthProvider({}), r.base)("/api/v1/health", { method: "GET" });
    expect(res.status).toBe(401);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.init).toEqual({ method: "GET", headers: {} });
  });
});

describe("auth-fetch, mode OIDC", () => {
  it("pose Authorization: Bearer avec le jeton courant", async () => {
    const r = recorder();
    const { session } = fakeSession(true);
    await createAuthFetch(oidcAuthProvider(session), r.base)("/api/v1/realtime/ticket", { method: "POST", headers: { accept: "application/json" } });
    expect(r.seen[0]!.init.headers).toEqual({ accept: "application/json", authorization: "Bearer at-1" });
  });

  it("401 : un refresh puis la même requête rejouée avec le nouveau jeton (corps compris)", async () => {
    const r = recorder([401, 200]);
    const { s, session } = fakeSession(true);
    const res = await createAuthFetch(oidcAuthProvider(session), r.base)("/api/v1/allocations/1", { method: "PATCH", body: "{\"x\":1}" });
    expect(res.status).toBe(200);
    expect(s.refreshes).toBe(1);
    expect(r.seen.map((x) => x.init.headers?.authorization)).toEqual(["Bearer at-1", "Bearer at-2"]);
    expect(r.seen[1]!.init.body).toBe("{\"x\":1}");
  });

  it("401 encore après le refresh : réponse rendue, pas de boucle ni de redirection", async () => {
    const r = recorder([401, 401]);
    const { s, session } = fakeSession(true);
    expect((await createAuthFetch(oidcAuthProvider(session), r.base)("/x", { method: "GET" })).status).toBe(401);
    expect([r.seen.length, s.refreshes, s.logins]).toEqual([2, 1, 0]);
  });

  it("refresh refusé : nouvelle connexion demandée, 401 rendu", async () => {
    const r = recorder([401]);
    const { s, session } = fakeSession(false);
    expect((await createAuthFetch(oidcAuthProvider(session), r.base)("/x", { method: "GET" })).status).toBe(401);
    expect([r.seen.length, s.refreshes, s.logins]).toEqual([1, 1, 1]);
  });

  it("refresh refusé avec onSessionLost : l'écran est prévenu (session expirée), pas de redirection, 401 rendu", async () => {
    const r = recorder([401]);
    const { s, session } = fakeSession(false);
    let lost = 0;
    expect((await createAuthFetch(oidcAuthProvider(session, () => { lost++; }), r.base)("/x", { method: "GET" })).status).toBe(401);
    expect([r.seen.length, s.refreshes, s.logins, lost]).toEqual([1, 1, 0, 1]);
  });

  it("sans jeton : aucune en-tête Authorization", async () => {
    const r = recorder();
    const { s, session } = fakeSession(true);
    s.token = null;
    await createAuthFetch(oidcAuthProvider(session), r.base)("/x", { method: "GET" });
    expect(r.seen[0]!.init.headers).toEqual({});
  });
});
