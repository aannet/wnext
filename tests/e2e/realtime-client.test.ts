// Bout en bout : le client temps réel (apps/web) contre le vrai serveur (apps/api) sur PGlite, avec le client HTTP généré pour le ticket.
// Prouve la chaîne ticket -> upgrade -> abonnement -> diffusion, la reprise après coupure et l'attente après un refus 429.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createClient } from "../../apps/web/src/api/client.gen";
import { createRealtimeClient, ticketFrom, type RealtimeStatus, type SocketLike } from "../../apps/web/src/realtime/client";
import { devAuthenticate, startServer, type Db, type RunningServer } from "../../apps/api/src/index";
import type { Change } from "@wnext/contracts";

let pg: PGlite;
let srv: RunningServer;
const dev = { "x-dev-account-id": "1", "x-dev-user-id": "1", "x-dev-role": "admin" };
const http = () => `http://127.0.0.1:${srv.port}`;
const api = () => createClient({ baseUrl: http(), fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...dev } }) as never });

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync("schema.sql", "utf8"));
  await pg.exec("INSERT INTO users (email) VALUES ('u@x.test'); INSERT INTO accounts (name) VALUES ('A');");
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  srv = await startServer({ db, authenticate: devAuthenticate, pollIntervalMs: 50, maxPerAccount: 1 });
}, 120_000);
afterAll(async () => { await srv?.close(); await pg?.close(); }, 60_000);

async function waitFor(pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(pred()).toBe(true);
}
let n = 0;
const createDepartment = () => fetch(`${http()}/api/v1/departments`, { method: "POST", headers: { ...dev, "content-type": "application/json" }, body: JSON.stringify({ name: `D${++n}` }) }).then((r) => r.json());

function connectClient() {
  const sockets: WebSocket[] = [];
  const got: Change[] = [];
  const statuses: RealtimeStatus[] = [];
  const delays: number[] = [];
  let loads = 0;
  const client = createRealtimeClient({
    wsBase: `ws://127.0.0.1:${srv.port}`,
    getTicket: ticketFrom(api()),
    loadCursor: async () => {
      loads++;
      const res = await api().getSchedule({ from: "2026-03-02", to: "2026-03-06" });
      if (!res.ok || !("changeCursor" in res.data)) throw new Error("schedule");
      return res.data.changeCursor;
    },
    onChanges: (c) => got.push(...c),
    onStatus: (s) => statuses.push(s),
    openSocket: (url) => { const ws = new WebSocket(url); sockets.push(ws); return ws as unknown as SocketLike; },
    // attentes réduites pour le test ; les délais demandés sont conservés pour vérification
    setTimer: (fn, ms) => { delays.push(ms); return setTimeout(fn, Math.min(ms, 60)); },
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return { client, sockets, got, statuses, delays, loads: () => loads };
}

describe("client temps réel <-> serveur", () => {
  it("diffuse les changements, reprend après une coupure sans perte ni doublon, et attend après un 429", async () => {
    const c = connectClient();
    c.client.start();
    await waitFor(() => c.statuses.includes("live"));

    await createDepartment();
    await waitFor(() => c.got.length === 1);
    expect(c.got[0]).toMatchObject({ entity: "departments", op: "insert" });

    // coupure réseau : le client se reconnecte seul (ticket neuf) ; un changement survenu pendant la coupure est rattrapé
    c.sockets[0]!.terminate();
    await createDepartment();
    await waitFor(() => c.got.length === 2);
    expect(new Set(c.got.map((x) => x.seq)).size).toBe(2); // pas de doublon
    expect(c.loads()).toBe(1); // reprise par curseur, sans recharger la fenêtre
    expect(c.sockets.length).toBeGreaterThanOrEqual(2);

    // plafond de 1 connexion par compte : un second client est refusé en 429, attend au moins le plancher du contrat, puis entre quand la place se libère
    const second = connectClient();
    second.client.start();
    await waitFor(() => second.statuses.includes("waiting"));
    expect(second.delays.some((d) => d >= 5000)).toBe(true);
    expect(second.statuses).not.toContain("live");
    c.client.stop();
    await waitFor(() => second.statuses.includes("live"));
    second.client.stop();
  }, 30_000);

  it("une session non authentifiée s'arrête sans boucler", async () => {
    let unauth = 0;
    const bad = createClient({ baseUrl: http(), fetch: (url, init) => fetch(url, init) as never });
    const client = createRealtimeClient({
      wsBase: `ws://127.0.0.1:${srv.port}`,
      getTicket: ticketFrom(bad),
      loadCursor: async () => "0",
      onChanges: () => {},
      onUnauthenticated: () => unauth++,
    });
    client.start();
    await waitFor(() => unauth === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(unauth).toBe(1);
  });
});
