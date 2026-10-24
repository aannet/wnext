#!/usr/bin/env node
// Charge temps réel (npm run load:realtime), HORS make check. Pas de k6 : le protocole (ticket, WebSocket, curseur) est court et
// `ws` est déjà une dépendance ; un script node mesure aussi bien et évite un binaire de plus (voir docs/03-tech/quality/charge-temps-reel.md).
//  1. pile dédiée (scripts/dev-stack.mjs --reset, API :3300, Postgres :54359, dossier tests/load/out/pg, RLS active, AUTH_MODE=dev) ;
//  2. pour chaque palier de clients : N WebSocket abonnés (ticket neuf par client, subscribe depuis le changeCursor du Schedule),
//     puis M PATCH /allocations/{id} à cadence fixe (un écrivain, If-Match) ;
//  3. latence de propagation = réception du changement (id + version) par un client - début de la requête PATCH (borne haute :
//     inclut l'aller-retour HTTP) ; pertes = notifications attendues (N par PATCH) jamais reçues avant la fin de l'attente ;
//  4. résultats : tests/load/out/resultats.json + tableau sur la sortie ; code 1 si un objectif échoue.
// Variables : LOAD_CLIENTS ("50,500"), LOAD_WRITES (100), LOAD_GAP_MS (200 = 5 écritures/s), LOAD_SETTLE_MS (10000),
//             LOAD_P95_MS (1000 : objectif p95), LOAD_API_PORT (3300), LOAD_PG_PORT (54359).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "tests", "load", "out");
const apiPort = process.env.LOAD_API_PORT ?? "3300";
const pgPort = process.env.LOAD_PG_PORT ?? "54359";
const tiers = (process.env.LOAD_CLIENTS ?? "50,500").split(",").map(Number);
const writes = Number(process.env.LOAD_WRITES ?? 100);
const gapMs = Number(process.env.LOAD_GAP_MS ?? 200);
const settleMs = Number(process.env.LOAD_SETTLE_MS ?? 10_000);
const budgetP95 = Number(process.env.LOAD_P95_MS ?? 1000);
const base = `http://127.0.0.1:${apiPort}`;
const auth = { "x-dev-account-id": "1", "x-dev-user-id": "1", "x-dev-role": "admin" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

mkdirSync(out, { recursive: true });
rmSync(join(out, "pg"), { recursive: true, force: true });
const log = createWriteStream(join(out, "stack.log"));
const stack = spawn(process.execPath, ["scripts/dev-stack.mjs", "--reset"], {
  cwd: root,
  env: {
    ...process.env, WNEXT_DEV_API_PORT: apiPort, WNEXT_DEV_PG_PORT: pgPort, WNEXT_DEV_PG_DIR: join(out, "pg"),
    // Les limites de débit protègent la production, pas la mesure : relevées pour ne pas mesurer des 429.
    TICKET_RATE_PER_USER: "1000000", TICKET_RATE_PER_ACCOUNT: "1000000", WS_UPGRADE_RATE_PER_ACCOUNT: "1000000",
    WS_MAX_PER_ACCOUNT: String(Math.max(...tiers) + 100),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
stack.stdout.pipe(log);
stack.stderr.pipe(log);
const stopStack = () => new Promise((res) => {
  if (stack.exitCode !== null) return res();
  const t = setTimeout(() => { stack.kill("SIGKILL"); res(); }, 30_000);
  stack.once("exit", () => { clearTimeout(t); res(); });
  stack.kill("SIGTERM");
});
process.on("SIGINT", () => void stopStack().then(() => process.exit(130)));

async function waitReady(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/api/v1/health`)).status < 500) return; } catch { /* pas encore prête */ }
    await sleep(500);
  }
  throw new Error(`l'API ne répond pas sur ${base}`);
}

async function api(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { ...auth, ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} : HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Un client : ticket neuf, WebSocket, subscribe depuis le curseur ; rend une promesse « prêt ». */
function connect(cursor, onChange) {
  return new Promise(async (resolve, reject) => {
    try {
      const { ticket } = await api("POST", "/realtime/ticket");
      const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}`);
      const timer = setTimeout(() => reject(new Error("délai de connexion dépassé")), 30_000);
      ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "subscribe", cursor })));
      ws.on("message", (data) => {
        const t = performance.now();
        const msg = JSON.parse(String(data));
        if (msg.type === "ready") { clearTimeout(timer); resolve(ws); }
        else if (msg.type === "changes") onChange(msg.changes, t);
      });
      ws.on("error", (e) => reject(e));
    } catch (e) { reject(e); }
  });
}

async function tier(n, allocations, cursor) {
  const arrivals = new Map(); // "id:version" -> nombre de clients ayant reçu
  const lat = [];
  const sent = new Map(); // "id:version" -> t0
  const socketsDropped = { n: 0 };
  const sockets = [];
  const t0conn = performance.now();
  for (let i = 0; i < n; i += 50) {
    const batch = await Promise.all(Array.from({ length: Math.min(50, n - i) }, () => connect(cursor, (changes, t) => {
      for (const ch of changes) {
        if (ch.entity !== "allocations") continue;
        const k = `${ch.id}:${ch.version}`;
        const s = sent.get(k);
        if (s === undefined) continue; // changement hors mesure
        arrivals.set(k, (arrivals.get(k) ?? 0) + 1);
        lat.push(t - s);
      }
    })));
    sockets.push(...batch);
  }
  let closing = false;
  for (const ws of sockets) ws.on("close", () => { if (!closing) socketsDropped.n++; });
  const connectMs = Math.round(performance.now() - t0conn);

  // Écrivain unique : on tourne sur K allocations, chaque PATCH avec le If-Match de la version connue.
  const pool = allocations.slice(0, 20); // objets partagés entre paliers : les versions avancent avec chaque PATCH
  let writeErrors = 0;
  const writeLat = [];
  const t0run = performance.now();
  for (let w = 0; w < writes; w++) {
    const a = pool[w % pool.length];
    const t0 = performance.now();
    // La clé est posée AVANT la requête : une notification peut arriver avant la réponse HTTP.
    const expected = `${a.id}:${a.version + 1}`;
    sent.set(expected, t0);
    try {
      const res = await fetch(`${base}/api/v1/allocations/${a.id}`, { method: "PATCH", headers: { ...auth, "content-type": "application/json", "if-match": `"${a.version}"` }, body: JSON.stringify({ notes: `charge ${n} #${w}` }) });
      writeLat.push(performance.now() - t0);
      if (!res.ok) { writeErrors++; sent.delete(expected); } else { a.version = (await res.json()).version; }
    } catch { writeErrors++; sent.delete(expected); }
    await sleep(Math.max(0, gapMs - (performance.now() - t0)));
  }
  const runMs = performance.now() - t0run;
  const deadline = Date.now() + settleMs;
  const complete = () => [...sent.keys()].every((k) => (arrivals.get(k) ?? 0) >= n);
  while (!complete() && Date.now() < deadline) await sleep(50);
  const alive = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
  closing = true;
  for (const ws of sockets) ws.close();
  await sleep(300);

  let missing = 0;
  for (const k of sent.keys()) missing += Math.max(0, n - (arrivals.get(k) ?? 0));
  const expectedTotal = sent.size * n;
  const r = (x) => (x === null ? null : Math.round(x));
  const result = {
    clients: n, writes: sent.size, writeErrors, writeRatePerSec: Number((sent.size / (runMs / 1000)).toFixed(2)), connectMs,
    expected: expectedTotal, received: lat.length, missing, lossPercent: expectedTotal ? Number(((100 * missing) / expectedTotal).toFixed(3)) : 0,
    droppedSockets: socketsDropped.n, aliveAtEnd: alive,
    p50: r(quantile(lat, 0.5)), p95: r(quantile(lat, 0.95)), p99: r(quantile(lat, 0.99)), max: lat.length ? r(lat.reduce((a, b) => Math.max(a, b), 0)) : null,
    writeP50: r(quantile(writeLat, 0.5)), writeP95: r(quantile(writeLat, 0.95)),
  };
  result.ok = result.p95 !== null && result.p95 < budgetP95 && missing === 0 && writeErrors === 0;
  return result;
}

const results = [];
let failed = false;
try {
  await waitReady(180_000);
  const sched = await api("GET", "/schedule?from=2026-07-01&to=2027-01-31&limit=50");
  const allocations = sched.allocations.filter((a) => typeof a.version === "number").map((a) => ({ id: a.id, version: a.version }));
  if (allocations.length < 20) throw new Error(`jeu d'essai trop petit (${allocations.length} allocations)`);
  for (const n of tiers) {
    console.log(`\n=== ${n} clients, ${writes} écritures toutes les ${gapMs} ms ===`);
    // Curseur frais avant chaque palier : les paliers ne se rejouent pas les changements des précédents.
    const fresh = (await api("GET", "/schedule?from=2026-10-19&to=2026-10-23&limit=1")).changeCursor;
    const res = await tier(n, allocations, fresh);
    console.log(JSON.stringify(res));
    results.push(res);
    if (!res.ok) failed = true;
    await sleep(2000);
  }
} catch (err) {
  console.error(err instanceof Error ? err.stack : err);
  failed = true;
} finally {
  await stopStack();
}
writeFileSync(join(out, "resultats.json"), JSON.stringify({ date: new Date().toISOString(), node: process.version, budgetP95, writes, gapMs, results }, null, 2));
console.log("\nclients | écritures | reçus/attendus | pertes | p50 | p95 | p99 | max (ms) | objectif");
for (const r of results) console.log(`${r.clients} | ${r.writes} | ${r.received}/${r.expected} | ${r.missing} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.ok ? "OK" : "ECHEC"}`);
console.log(`\nRésultats : ${join(out, "resultats.json")} (stack.log pour la pile)`);
process.exit(failed ? 1 : 0);
