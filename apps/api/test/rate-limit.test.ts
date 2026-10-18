// Limite de débit : limiteur à fenêtre glissante (horloge injectée), puis serveur complet (POST du ticket, upgrade) et configuration.
import { request } from "node:http";
import { ApiError, REALTIME_PATH, REALTIME_RETRY_AFTER_SECONDS, REALTIME_TICKET_PATH } from "@wnext/contracts";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRateLimiter, dispatch, loadConfig, startServer, type Db, type HttpDeps, type RunningServer } from "../src/index";

const clock = (start = 1_800_000_000_000) => { const f = Object.assign(() => f.t, { t: start }); return f; };

describe("createRateLimiter", () => {
  it("autorise `limit` tentatives par fenêtre puis refuse avec l'attente en secondes", () => {
    const now = clock();
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now });
    expect([rl.hit("a"), rl.hit("a"), rl.hit("a")]).toEqual([0, 0, 0]);
    expect(rl.hit("a")).toBe(60);
    now.t += 10_000;
    expect(rl.hit("a")).toBe(50); // la plus ancienne tentative sort de la fenêtre dans 50 s
  });
  it("fenêtre glissante : une place se libère exactement quand la plus ancienne tentative sort", () => {
    const now = clock();
    const rl = createRateLimiter({ limit: 2, windowMs: 10_000, now });
    rl.hit("a");
    now.t += 4_000;
    rl.hit("a");
    now.t += 5_999; // 9,999 s après la première : encore dans la fenêtre
    expect(rl.hit("a")).toBe(1);
    now.t += 1; // 10 s pile : la première sort (bornes : > t - fenêtre)
    expect(rl.hit("a")).toBe(0);
    expect(rl.hit("a")).toBeGreaterThan(0); // la deuxième (t0+4 s) et la nouvelle occupent la fenêtre
  });
  it("une tentative refusée n'est pas comptée : l'attente annoncée est exacte, pas prolongée par l'insistance", () => {
    const now = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 10_000, now });
    rl.hit("a");
    for (let i = 0; i < 50; i++) { now.t += 100; expect(rl.hit("a")).toBeGreaterThan(0); }
    now.t = 1_800_000_000_000 + 10_000;
    expect(rl.hit("a")).toBe(0);
  });
  it("l'attente est arrondie au-dessus et vaut au moins 1 s", () => {
    const now = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 10_000, now });
    rl.hit("a");
    now.t += 9_999;
    expect(rl.hit("a")).toBe(1);
    now.t += 0;
    const rl2 = createRateLimiter({ limit: 1, windowMs: 10_500, now });
    rl2.hit("b");
    now.t += 100;
    expect(rl2.hit("b")).toBe(11); // 10,4 s -> 11
  });
  it("les clés sont indépendantes", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock() });
    expect(rl.hit("a")).toBe(0);
    expect(rl.hit("b")).toBe(0);
    expect(rl.hit("a")).toBeGreaterThan(0);
    expect(rl.hit("b")).toBeGreaterThan(0);
  });
  it("limite 0 ou négative : désactivée", () => {
    for (const limit of [0, -1]) {
      const rl = createRateLimiter({ limit, windowMs: 60_000, now: clock() });
      for (let i = 0; i < 100; i++) expect(rl.hit("a")).toBe(0);
    }
  });
  it("mémoire bornée : au-delà de maxKeys, la clé la moins récemment vue est oubliée (et repart de zéro)", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock(), maxKeys: 2 });
    rl.hit("a");
    rl.hit("b");
    rl.hit("a"); // refusée, mais "a" devient la plus récemment vue
    rl.hit("c"); // évince "b"
    expect(rl.hit("b")).toBe(0); // oubliée
    expect(rl.hit("c")).toBeGreaterThan(0); // encore suivie
  });
});

describe("loadConfig : limites de débit", () => {
  const base = { DATABASE_URL: "postgres://x" };
  it("défauts sûrs", () => {
    expect(loadConfig(base).rateLimits).toEqual({ windowSeconds: 60, ticketsPerUser: 30, ticketsPerAccount: 300, upgradesPerAccount: 120 });
  });
  it("surcharge par l'environnement ; 0 désactive une limite", () => {
    const c = loadConfig({ ...base, RATE_LIMIT_WINDOW_SECONDS: "10", TICKET_RATE_PER_USER: "5", TICKET_RATE_PER_ACCOUNT: "0", WS_UPGRADE_RATE_PER_ACCOUNT: "7" });
    expect(c.rateLimits).toEqual({ windowSeconds: 10, ticketsPerUser: 5, ticketsPerAccount: 0, upgradesPerAccount: 7 });
  });
  it("chacune des trois limites accepte 0 (désactivée)", () => {
    const c = loadConfig({ ...base, TICKET_RATE_PER_USER: "0", TICKET_RATE_PER_ACCOUNT: "0", WS_UPGRADE_RATE_PER_ACCOUNT: "0" });
    expect(c.rateLimits).toMatchObject({ ticketsPerUser: 0, ticketsPerAccount: 0, upgradesPerAccount: 0 });
  });
  it.each([["RATE_LIMIT_WINDOW_SECONDS", "0"], ["RATE_LIMIT_WINDOW_SECONDS", "3601"], ["TICKET_RATE_PER_USER", "-1"], ["TICKET_RATE_PER_USER", "abc"], ["WS_UPGRADE_RATE_PER_ACCOUNT", "1000001"]])("%s=%s est refusé", (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
  });
});

// ---- Couche HTTP seule (dispatch) : réponse 429 conforme au contrat ----
describe("POST ticket : réponse 429", () => {
  const ctxOf = (h: Record<string, string | string[] | undefined>) => (h.authorization ? { accountId: "1", userId: String(h.authorization), role: "member" as const } : null);
  const tickets = { issue: () => ({ ticket: "A".repeat(43), expiresInSeconds: 30 }) };
  const noDb: Db = { transaction: async () => { throw new Error("pas de base"); } };
  const mk = (perUser: number, perAccount: number, now = clock()): HttpDeps => ({
    db: noDb, authenticate: async (h) => ctxOf(h), tickets, newRequestId: () => "r",
    ticketLimits: { perUser: createRateLimiter({ limit: perUser, windowMs: 60_000, now }), perAccount: createRateLimiter({ limit: perAccount, windowMs: 60_000, now }) },
  });
  const post = (deps: HttpDeps, who?: string) => dispatch(deps, { method: "POST", url: REALTIME_TICKET_PATH, headers: who ? { authorization: who } : {} });

  it("au-delà de la limite par utilisateur : 429 RATE_LIMITED, params.retryAfterSeconds et en-tête Retry-After identiques", async () => {
    const deps = mk(2, 100);
    expect((await post(deps, "u1")).status).toBe(200);
    expect((await post(deps, "u1")).status).toBe(200);
    const r = await post(deps, "u1");
    expect(r.status).toBe(429);
    const body = ApiError.parse(r.body);
    expect(body).toMatchObject({ code: "RATE_LIMITED", params: { retryAfterSeconds: 60 }, requestId: "r" });
    expect(r.headers).toEqual({ "retry-after": "60" });
  });
  it("un autre utilisateur du même compte n'est pas touché par la limite du premier", async () => {
    const deps = mk(1, 100);
    expect((await post(deps, "u1")).status).toBe(200);
    expect((await post(deps, "u1")).status).toBe(429);
    expect((await post(deps, "u2")).status).toBe(200);
  });
  it("la limite par utilisateur est propre à chaque compte : le même utilisateur dans deux comptes a deux quotas", async () => {
    const deps: HttpDeps = { ...mk(1, 100), authenticate: async (h) => (h.authorization ? { accountId: String(h["x-account"]), userId: "u1", role: "member" as const } : null) };
    const as = (account: string) => dispatch(deps, { method: "POST", url: REALTIME_TICKET_PATH, headers: { authorization: "x", "x-account": account } });
    expect((await as("1")).status).toBe(200);
    expect((await as("1")).status).toBe(429);
    expect((await as("2")).status).toBe(200);
  });
  it("limite par compte : plusieurs utilisateurs, mêmes 100 % du compte", async () => {
    const deps = mk(100, 3);
    for (const u of ["u1", "u2", "u3"]) expect((await post(deps, u)).status).toBe(200);
    expect((await post(deps, "u4")).status).toBe(429);
  });
  it("le refus par utilisateur ne consomme pas le quota du compte", async () => {
    const deps = mk(1, 2);
    expect((await post(deps, "u1")).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post(deps, "u1")).status).toBe(429);
    expect((await post(deps, "u2")).status).toBe(200); // le compte n'a servi que 2 fois
  });
  it("l'authentification passe avant la limite : un anonyme reçoit 401 et ne consomme rien", async () => {
    const deps = mk(1, 1);
    for (let i = 0; i < 5; i++) expect((await post(deps)).status).toBe(401);
    expect((await post(deps, "u1")).status).toBe(200);
  });
  it("la fenêtre se vide avec le temps", async () => {
    const now = clock();
    const deps = mk(1, 100, now);
    expect((await post(deps, "u1")).status).toBe(200);
    expect((await post(deps, "u1")).status).toBe(429);
    now.t += 60_000;
    expect((await post(deps, "u1")).status).toBe(200);
  });
  it("sans limiteurs configurés, aucune limite (comportement historique)", async () => {
    const deps: HttpDeps = { db: noDb, authenticate: async (h) => ctxOf(h), tickets, newRequestId: () => "r" };
    for (let i = 0; i < 200; i++) expect((await post(deps, "u1")).status).toBe(200);
  });
  it("les autres réponses n'ont pas d'en-têtes", async () => {
    const r = await post(mk(5, 5), "u1");
    expect(r.headers).toBeUndefined();
  });
});

// ---- Serveur complet ----
const noDb: Db = { transaction: async () => { throw new Error("la base ne doit pas servir ici"); } };
const dev = (account = "7", user = "42") => ({ "x-dev-account-id": account, "x-dev-user-id": user, "x-dev-role": "member" });
const servers: RunningServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });
const boot = async (rateLimits: Parameters<typeof startServer>[0]["rateLimits"], extra: Partial<Parameters<typeof startServer>[0]> = {}) => {
  const s = await startServer({ db: noDb, authenticate: async (h) => (h["x-dev-account-id"] ? { accountId: String(h["x-dev-account-id"]), userId: String(h["x-dev-user-id"]), role: "member" } : null), ticketSecret: "0123456789abcdef0123456789abcdef", rateLimits, ...extra });
  servers.push(s);
  return s;
};
const post = (srv: RunningServer, headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, unknown>; json: any }>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port: srv.port, path: REALTIME_TICKET_PATH, method: "POST", headers }, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: d ? JSON.parse(d) : undefined }));
  });
  req.on("error", reject);
  req.end();
});
const upgrade = (srv: RunningServer, headers: Record<string, string>) => new Promise<{ result: string; retryAfter?: string }>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${REALTIME_PATH}`, { headers });
  ws.once("open", () => { ws.close(); resolve({ result: "open" }); });
  ws.once("unexpected-response", (_r, res) => resolve({ result: String(res.statusCode), retryAfter: res.headers["retry-after"] as string | undefined }));
  ws.once("error", () => resolve({ result: "error" }));
});

describe("serveur complet : tickets", () => {
  it("429 avec Retry-After sur le fil, puis la limite d'un autre utilisateur est intacte", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 2, ticketsPerAccount: 100, upgradesPerAccount: 100 });
    expect((await post(s, dev())).status).toBe(200);
    expect((await post(s, dev())).status).toBe(200);
    const r = await post(s, dev());
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ code: "RATE_LIMITED", params: { retryAfterSeconds: 60 } });
    expect(r.headers["retry-after"]).toBe("60");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await post(s, dev("7", "43"))).status).toBe(200);
  });
  it("sans option, les défauts s'appliquent (limite par utilisateur de 30 par minute)", async () => {
    const s = await boot(undefined);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(s, dev("8", "1"))).status;
    expect(last).toBe(429);
  });
});

describe("serveur complet : tentatives de connexion WebSocket", () => {
  it("au-delà de la limite par compte : 429 avec Retry-After au moins égal au plancher du contrat", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 100, ticketsPerAccount: 100, upgradesPerAccount: 2 });
    expect((await upgrade(s, dev())).result).toBe("open");
    expect((await upgrade(s, dev())).result).toBe("open");
    const r = await upgrade(s, dev());
    expect(r.result).toBe("429");
    expect(Number(r.retryAfter)).toBeGreaterThanOrEqual(REALTIME_RETRY_AFTER_SECONDS);
    expect(Number(r.retryAfter)).toBeLessThanOrEqual(60);
  });
  it("fenêtre courte : Retry-After ne descend jamais sous le plancher du contrat", async () => {
    const s = await boot({ windowSeconds: 1, ticketsPerUser: 100, ticketsPerAccount: 100, upgradesPerAccount: 1 });
    expect((await upgrade(s, dev("3"))).result).toBe("open");
    const r = await upgrade(s, dev("3"));
    expect(r.result).toBe("429");
    expect(r.retryAfter).toBe(String(REALTIME_RETRY_AFTER_SECONDS));
  });
  it("la limite est par compte : un autre compte se connecte", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 100, ticketsPerAccount: 100, upgradesPerAccount: 1 });
    expect((await upgrade(s, dev("1"))).result).toBe("open");
    expect((await upgrade(s, dev("1"))).result).toBe("429");
    expect((await upgrade(s, dev("2"))).result).toBe("open");
  });
  it("401 avant la limite : un anonyme ne consomme rien", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 100, ticketsPerAccount: 100, upgradesPerAccount: 1 });
    for (let i = 0; i < 4; i++) expect((await upgrade(s, {})).result).toBe("401");
    expect((await upgrade(s, dev())).result).toBe("open");
  });
  it("un ticket présenté à l'upgrade compte comme une tentative", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 100, ticketsPerAccount: 100, upgradesPerAccount: 1 });
    const t = async () => (await post(s, dev())).json.ticket as string;
    const viaTicket = (ticket: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}${REALTIME_PATH}?ticket=${ticket}`);
      ws.once("open", () => { ws.close(); resolve("open"); });
      ws.once("unexpected-response", (_r, res) => resolve(String(res.statusCode)));
      ws.once("error", () => resolve("error"));
    });
    expect(await viaTicket(await t())).toBe("open");
    expect(await viaTicket(await t())).toBe("429");
  });
  it("la limite de débit est indépendante du plafond de connexions simultanées (429 des deux côtés, mêmes conduites)", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 100, ticketsPerAccount: 100, upgradesPerAccount: 100 }, { maxPerAccount: 1 });
    const held = new WebSocket(`ws://127.0.0.1:${s.port}${REALTIME_PATH}`, { headers: dev("5") });
    await new Promise((r) => held.once("open", r));
    const r = await upgrade(s, dev("5"));
    expect(r.result).toBe("429");
    expect(r.retryAfter).toBe(String(REALTIME_RETRY_AFTER_SECONDS));
    held.close();
  });
  it("limite à 0 : désactivée", async () => {
    const s = await boot({ windowSeconds: 60, ticketsPerUser: 0, ticketsPerAccount: 0, upgradesPerAccount: 0 });
    for (let i = 0; i < 40; i++) expect((await post(s, dev("9"))).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await upgrade(s, dev("9"))).result).toBe("open");
  });
});
