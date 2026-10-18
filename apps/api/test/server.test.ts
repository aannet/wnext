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
});
