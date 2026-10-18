// Serveur complet (HTTP + WebSocket) sur un port réel, base PGlite : upgrade authentifié, rattrapage, flux direct,
// rejet des connexions non autorisées, arrêt propre.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { RealtimeServerMessage } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { devAuthenticate, startServer, type Db, type RunningServer } from "../src/index";

let pg: PGlite;
let srv: RunningServer;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const headers = (account = "1") => ({ "x-dev-account-id": account, "x-dev-user-id": "1", "x-dev-role": "admin" });
const url = (path: string) => `127.0.0.1:${srv.port}${path}`;

function http(method: string, path: string, h: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers: { ...h, "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : undefined }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Ouvre un WebSocket et expose les messages reçus (validés contre le contrat) avec une attente par prédicat. */
function connect(h: Record<string, string>) {
  const ws = new WebSocket(`ws://${url("/api/v1/realtime")}`, { headers: h });
  const got: RealtimeServerMessage[] = [];
  ws.on("message", (d) => got.push(RealtimeServerMessage.parse(JSON.parse(d.toString()))));
  const opened = new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`))); });
  const until = async (pred: () => boolean) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25)); expect(pred()).toBe(true); };
  const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
  return { ws, got, opened, until, closed };
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('u@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Alice'), (2, 'Intrus');
    INSERT INTO projects (account_id, name) VALUES (1, 'P'), (2, 'Q');
  `);
  srv = await startServer({ db, authenticate: devAuthenticate, pollIntervalMs: 30, heartbeatMs: 60_000, onError: () => {} });
}, 120_000);
afterAll(async () => { await srv?.close(); await pg?.close(); }, 60_000);

const alloc = { personId: "1", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-03", load: { mode: "hours", hoursPerDay: 4 } };

describe("serveur HTTP + WebSocket", () => {
  it("HTTP : la santé répond, un en-tête d'identité absent donne 401", async () => {
    expect((await http("GET", "/api/v1/health", {})).status).toBe(200);
    const r = await http("GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06", {});
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("UNAUTHENTICATED");
  });

  it("une écriture REST arrive en direct sur le WebSocket abonné", async () => {
    const c0 = (await http("GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06", headers())).json.changeCursor as string;
    const a = connect(headers());
    await a.opened;
    a.ws.send(JSON.stringify({ v: 1, type: "subscribe", cursor: c0 }));
    await a.until(() => a.got.some((m) => m.type === "ready"));
    const created = await http("POST", "/api/v1/allocations", headers(), alloc);
    expect(created.status).toBe(201);
    await a.until(() => a.got.some((m) => m.type === "changes"));
    expect(a.got.find((m) => m.type === "changes")).toMatchObject({ changes: [{ entity: "allocations", id: created.json.id, op: "insert", version: 1 }] });
    a.ws.close();
  });

  it("un second compte ne reçoit rien de ce compte", async () => {
    const b = connect(headers("2"));
    await b.opened;
    const c0 = (await http("GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06", headers("2"))).json.changeCursor as string;
    b.ws.send(JSON.stringify({ v: 1, type: "subscribe", cursor: c0 }));
    await b.until(() => b.got.some((m) => m.type === "ready"));
    await http("POST", "/api/v1/allocations", headers("1"), alloc);
    await new Promise((r) => setTimeout(r, 200));
    expect(b.got.map((m) => m.type)).toEqual(["ready"]);
    b.ws.close();
  });

  it("curseur expiré : resync puis fermeture normale (1000)", async () => {
    await pg.exec("UPDATE account_change_seq SET purged_through = seq WHERE account_id = 1");
    const c = connect(headers());
    await c.opened;
    c.ws.send(JSON.stringify({ v: 1, type: "subscribe", cursor: "1" }));
    expect(await c.closed).toBe(1000);
    expect(c.got.map((m) => m.type)).toEqual(["resync"]);
    await pg.exec("UPDATE account_change_seq SET purged_through = 0 WHERE account_id = 1");
  });

  it.each([
    ["sans identité", {}, "401"],
    ["rôle inconnu", { ...headers(), "x-dev-role": "root" }, "401"],
    ["compte non numérique", { ...headers("1 OR 1=1") }, "401"],
  ])("upgrade refusé : %s", async (_n, h, status) => {
    await expect(connect(h as Record<string, string>).opened).rejects.toThrow(`HTTP ${status}`);
  });

  it("upgrade sur un autre chemin : 404", async () => {
    const ws = new WebSocket(`ws://${url("/autre")}`, { headers: headers() });
    await expect(new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); ws.once("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`))); })).rejects.toThrow("HTTP 404");
  });

  it("message binaire ou trop gros : refusé sans casser le serveur", async () => {
    const c = connect(headers());
    await c.opened;
    c.ws.send(Buffer.from([1, 2, 3]));
    await c.until(() => c.got.some((m) => m.type === "error"));
    expect(c.got[0]).toMatchObject({ type: "error", code: "VALIDATION_FAILED" });
    c.ws.send("x".repeat(10_000)); // > maxPayload : la connexion est coupée (1009)
    expect(await c.closed).toBe(1009);
    expect((await http("GET", "/api/v1/health", {})).status).toBe(200);
  });

  it("arrêt propre : ferme les WebSocket ouverts (1001) puis le serveur", async () => {
    const own = await startServer({ db, authenticate: devAuthenticate, pollIntervalMs: 30, onError: () => {} });
    const ws = new WebSocket(`ws://127.0.0.1:${own.port}/api/v1/realtime`, { headers: headers() });
    const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
    await new Promise((res) => ws.once("open", res));
    await own.close();
    expect(await closed).toBe(1001);
    await expect(http("GET", "/api/v1/health", {})).resolves.toBeDefined(); // l'autre serveur (srv) répond toujours
  });

  describe("plafond de connexions par compte", () => {
    let small: RunningServer;
    const open = (port: number, h: Record<string, string>) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`, { headers: h });
      const result = new Promise<{ ws: WebSocket; status?: number; retryAfter?: string }>((res) => {
        ws.once("open", () => res({ ws }));
        ws.once("unexpected-response", (_r, resp) => res({ ws, status: resp.statusCode, retryAfter: String(resp.headers["retry-after"]) }));
        ws.once("error", () => {}); // la socket coupée après le refus
      });
      return result;
    };
    const closeAndWait = (ws: WebSocket) => new Promise<void>((res) => { ws.once("close", () => res()); ws.close(); });
    const poll = async (pred: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

    beforeAll(async () => { small = await startServer({ db, authenticate: devAuthenticate, pollIntervalMs: 30, maxPerAccount: 2, onError: () => {} }); });
    afterAll(async () => { await small?.close(); });

    it("la 3e connexion du compte reçoit 429 + Retry-After ; l'autre compte n'est pas touché ; une place libérée se réutilise", async () => {
      const a1 = await open(small.port, headers());
      const a2 = await open(small.port, headers());
      expect(a1.status).toBeUndefined();
      expect(a2.status).toBeUndefined();
      const a3 = await open(small.port, headers());
      expect(a3.status).toBe(429);
      expect(a3.retryAfter).toBe("5");
      const b1 = await open(small.port, headers("2"));
      expect(b1.status).toBeUndefined(); // plafond par compte, pas global
      await closeAndWait(a1.ws);
      let again: Awaited<ReturnType<typeof open>> | undefined;
      expect(await poll(async () => { again = await open(small.port, headers()); if (again.status === undefined) return true; return false; })).toBe(true);
      await Promise.all([a2.ws, b1.ws, again!.ws].map(closeAndWait));
    });

    it("upgrades simultanés : jamais plus que le plafond n'est accepté, et les refusés ne consomment rien", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => open(small.port, headers())));
      expect(results.filter((r) => r.status === undefined)).toHaveLength(2);
      expect(results.filter((r) => r.status === 429)).toHaveLength(6);
      await Promise.all(results.filter((r) => r.status === undefined).map((r) => closeAndWait(r.ws)));
      let ok: Awaited<ReturnType<typeof open>> | undefined;
      expect(await poll(async () => { ok = await open(small.port, headers()); return ok.status === undefined; })).toBe(true); // rien n'a fui
      await closeAndWait(ok!.ws);
    });

    it("une authentification refusée ne réserve aucune place", async () => {
      for (let i = 0; i < 5; i++) expect((await open(small.port, {})).status).toBe(401);
      const a1 = await open(small.port, headers());
      const a2 = await open(small.port, headers());
      expect([a1.status, a2.status]).toEqual([undefined, undefined]);
      await Promise.all([a1.ws, a2.ws].map(closeAndWait));
    });
  });
});
