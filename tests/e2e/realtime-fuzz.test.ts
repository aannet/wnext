// Robustesse du WebSocket temps réel : messages malformés (JSON invalide, binaire, trop gros, mauvaise version, curseurs
// hostiles, champs en trop, rafales). Invariants : le serveur ne lève aucune erreur interne, chaque réponse respecte le
// contrat (RealtimeServerMessage), et une session saine ouverte en parallèle continue de recevoir les changements.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { REALTIME_PATH, REALTIME_PROTOCOL_VERSION, RealtimeServerMessage } from "@wnext/contracts";
import { devAuthenticate, startServer, type Db, type RunningServer } from "../../apps/api/src/index";

let pg: PGlite;
let srv: RunningServer;
const internal: unknown[] = [];
const dev = { "x-dev-account-id": "1", "x-dev-user-id": "1", "x-dev-role": "admin" };

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync("schema.sql", "utf8"));
  await pg.exec("INSERT INTO users (email) VALUES ('u@x.test'); INSERT INTO accounts (name) VALUES ('A'); INSERT INTO departments (account_id, name) VALUES (1, 'D0');");
  const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
  srv = await startServer({
    db, authenticate: devAuthenticate, pollIntervalMs: 30, maxPerAccount: 500,
    rateLimits: { windowSeconds: 60, ticketsPerUser: 1e6, ticketsPerAccount: 1e6, upgradesPerAccount: 1e6 },
    onError: (e) => internal.push(e),
  });
}, 120_000);
afterAll(async () => { await srv?.close(); await pg?.close(); }, 60_000);

const v = REALTIME_PROTOCOL_VERSION;

/** Ouvre un socket, envoie `frames`, collecte les messages et le code de fermeture (ou rien au bout de `ms`). */
async function probe(frames: (string | Buffer)[], ms = 300) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${REALTIME_PATH}`, { headers: dev });
  const got: unknown[] = [];
  let closed: number | null = null;
  ws.on("message", (d) => got.push(JSON.parse(d.toString("utf8"))));
  const done = new Promise<void>((res) => ws.on("close", (code) => { closed = code; res(); }));
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  for (const f of frames) ws.send(f);
  await Promise.race([done, new Promise((r) => setTimeout(r, ms))]);
  if (ws.readyState === WebSocket.OPEN) ws.close();
  await done;
  return { got, closed };
}

const BAD: (string | Buffer)[] = [
  "", "{", "null", "[]", "42", "\"subscribe\"", "{}",
  JSON.stringify({ v, type: "subscribe" }),
  JSON.stringify({ v: 999, type: "subscribe", cursor: "0" }),
  JSON.stringify({ v, type: "unknown", cursor: "0" }),
  JSON.stringify({ v, type: "subscribe", cursor: "-1" }),
  JSON.stringify({ v, type: "subscribe", cursor: "abc" }),
  JSON.stringify({ v, type: "subscribe", cursor: 0 }),
  JSON.stringify({ v, type: "subscribe", cursor: "1".repeat(16) }),
  JSON.stringify({ v, type: "subscribe", cursor: "0", extra: true }),
  JSON.stringify({ v, type: "subscribe", cursor: "0\u0000" }),
  JSON.stringify({ __proto__: { polluted: true }, v, type: "subscribe", cursor: "0" }),
  Buffer.from([0, 1, 2, 255]),
  "x".repeat(70_000), // au-delà de maxPayload
];

it("messages malformés : réponses conformes au contrat, aucune erreur interne", async () => {
  for (const frame of BAD) {
    const { got } = await probe([frame]);
    for (const m of got) expect(RealtimeServerMessage.safeParse(m).success, JSON.stringify({ frame: String(frame).slice(0, 60), m })).toBe(true);
  }
  expect(internal).toEqual([]);
}, 120_000);

it("message au-delà de maxPayload : fermeture 1009 (faute du client, pas une erreur interne)", async () => {
  internal.length = 0;
  const { closed } = await probe(["x".repeat(70_000)]);
  expect(closed).toBe(1009);
  expect(internal).toEqual([]);
}, 30_000);

it("curseur du futur, double abonnement, rafale : refus propres, une seule session abonnée", async () => {
  const future = await probe([JSON.stringify({ v, type: "subscribe", cursor: "999999999" })]);
  expect(future.got).toContainEqual(expect.objectContaining({ type: "error", code: "SCHEDULE_CURSOR_INVALID" }));
  const burst = await probe(Array.from({ length: 50 }, () => JSON.stringify({ v, type: "subscribe", cursor: "0" })), 500);
  expect(burst.got.filter((m) => (m as { type: string }).type === "ready")).toHaveLength(1);
  expect(burst.got.filter((m) => (m as { code?: string }).code === "VALIDATION_FAILED")).toHaveLength(49);
  expect(internal).toEqual([]);
}, 60_000);

it("pendant qu'on bombarde le serveur, une session saine continue de recevoir les changements", async () => {
  const healthy = new WebSocket(`ws://127.0.0.1:${srv.port}${REALTIME_PATH}`, { headers: dev });
  const got: { type: string; changes?: { entity: string }[] }[] = [];
  healthy.on("message", (d) => got.push(JSON.parse(d.toString("utf8"))));
  await new Promise<void>((res) => healthy.once("open", () => res()));
  healthy.send(JSON.stringify({ v, type: "subscribe", cursor: "0" }));
  const noise = Promise.all(Array.from({ length: 20 }, (_, i) => probe([BAD[i % BAD.length]!, BAD[(i * 7) % BAD.length]!])));
  await fetch(`http://127.0.0.1:${srv.port}/api/v1/departments`, { method: "POST", headers: { ...dev, "content-type": "application/json" }, body: JSON.stringify({ name: "D1" }) });
  await noise;
  const end = Date.now() + 5000;
  while (!got.some((m) => m.type === "changes" && m.changes!.some((c) => c.entity === "departments")) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(got.some((m) => m.type === "ready")).toBe(true);
  expect(got.filter((m) => m.type === "changes").flatMap((m) => m.changes!).filter((c) => c.entity === "departments").length).toBeGreaterThanOrEqual(2);
  healthy.close();
  expect(internal).toEqual([]);
}, 60_000);
