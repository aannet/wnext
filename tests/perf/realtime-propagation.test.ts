// Mesure de propagation temps réel (strategy.md §1, P2 : « p95 < 1 s à 50 clients ») sans k6 : vrai PostgreSQL
// (embedded-postgres), vrai serveur HTTP + WebSocket, réveil par LISTEN/NOTIFY (scrutation de secours à 5 s, donc
// hors du chemin mesuré), 50 clients web réels (apps/web, createRealtimeClient) sur un même compte.
// Latence = réception du changement par un client − début de la requête d'écriture (borne haute : inclut l'écriture HTTP).
// Hors make check (lent) : npm run perf:realtime. Paramètres : PERF_CLIENTS (50), PERF_WRITES (40), PERF_GAP_MS (100).
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { createClient } from "../../apps/web/src/api/client.gen";
import { createRealtimeClient, ticketFrom, type RealtimeStatus, type SocketLike } from "../../apps/web/src/realtime/client";
import { devAuthenticate, pgNotifier, startServer, type RunningServer } from "../../apps/api/src/index";
import { startCluster, type Cluster } from "../concurrency/pg-harness";

const CLIENTS = Number(process.env.PERF_CLIENTS ?? 50);
const WRITES = Number(process.env.PERF_WRITES ?? 40);
const GAP_MS = Number(process.env.PERF_GAP_MS ?? 100);
const BUDGET_P95_MS = 1000;

let c: Cluster;
let srv: RunningServer;
let accountId: string;
let userId: string;

beforeAll(async () => {
  c = await startCluster();
  userId = String((await c.admin.query("INSERT INTO users (email) VALUES ('perf@x.test') RETURNING id")).rows[0].id);
  accountId = String((await c.admin.query("INSERT INTO accounts (name) VALUES ('Perf') RETURNING id")).rows[0].id);
  srv = await startServer({
    db: c.db,
    authenticate: devAuthenticate,
    pollIntervalMs: 5_000,
    maxPerAccount: CLIENTS + 10,
    rateLimits: { windowSeconds: 60, ticketsPerUser: 10_000, ticketsPerAccount: 10_000, upgradesPerAccount: 10_000 },
    notifier: pgNotifier({ createClient: () => new pg.Client({ connectionString: c.url }) }),
    onError: () => {},
  });
}, 120_000);

afterAll(async () => {
  await srv?.close();
  await c?.stop();
}, 60_000);

const headers = () => ({ "x-dev-account-id": accountId, "x-dev-user-id": userId, "x-dev-role": "admin" });
const http = () => `http://127.0.0.1:${srv.port}`;
const api = () => createClient({ baseUrl: http(), fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...headers() } }) as never });

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};

it(`p95 de propagation < ${BUDGET_P95_MS} ms à ${CLIENTS} clients`, async () => {
  const arrivals = new Map<string, number[]>(); // entity_id -> heures de réception
  const live = new Set<number>();
  const clients = Array.from({ length: CLIENTS }, (_, i) => {
    const client = createRealtimeClient({
      wsBase: `ws://127.0.0.1:${srv.port}`,
      getTicket: ticketFrom(api()),
      loadCursor: async () => {
        const res = await api().getSchedule({ from: "2026-03-02", to: "2026-03-06" });
        if (!res.ok || !("changeCursor" in res.data)) throw new Error("schedule");
        return res.data.changeCursor;
      },
      onChanges: (changes) => {
        const now = performance.now();
        for (const ch of changes) {
          const k = String(ch.id);
          (arrivals.get(k) ?? arrivals.set(k, []).get(k)!).push(now);
        }
      },
      onStatus: (s: RealtimeStatus) => { if (s === "live") live.add(i); },
      openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    });
    client.start();
    return client;
  });
  const deadline = Date.now() + 30_000;
  while (live.size < CLIENTS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(live.size).toBe(CLIENTS);

  const sent = new Map<string, number>();
  for (let w = 0; w < WRITES; w++) {
    const t0 = performance.now();
    const res = await fetch(`${http()}/api/v1/departments`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ name: `D${w}` }) });
    expect(res.status).toBe(201);
    sent.set(String((await res.json()).id), t0);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const settle = Date.now() + 10_000;
  const complete = () => [...sent.keys()].every((k) => (arrivals.get(k)?.length ?? 0) >= CLIENTS);
  while (!complete() && Date.now() < settle) await new Promise((r) => setTimeout(r, 20));
  for (const cl of clients) cl.stop();

  const lat: number[] = [];
  let missing = 0;
  for (const [k, t0] of sent) {
    const got = arrivals.get(k) ?? [];
    missing += Math.max(0, CLIENTS - got.length);
    for (const t of got) lat.push(t - t0);
  }
  const result = {
    clients: CLIENTS, writes: WRITES, samples: lat.length, missing,
    p50: Math.round(quantile(lat, 0.5)), p95: Math.round(quantile(lat, 0.95)), p99: Math.round(quantile(lat, 0.99)), max: Math.round(Math.max(...lat)),
  };
  console.log(`propagation temps réel : ${JSON.stringify(result)}`);
  expect(missing).toBe(0);
  expect(result.p95).toBeLessThan(BUDGET_P95_MS);
}, 180_000);
