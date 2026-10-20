// Notifications in-app en temps réel, de bout en bout sur un port réel : trigger de 0004 -> pg_notify('wnext_notifications') ->
// LISTEN (PGlite) -> ChangeHub -> session -> WebSocket. Le message `notifications` n'atteint QUE le destinataire : ni un autre membre
// du compte (admin compris), ni le même identifiant d'utilisateur dans un autre compte (zéro fuite en WS).
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { RealtimeServerMessage } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { devAuthenticate, startServer, type ChangeNotifier, type Db, type RunningServer } from "../src/index";

let pg: PGlite;
let srv: RunningServer;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const who = { admin: ["1", "2", "admin"], member: ["1", "3", "member"], other: ["2", "3", "admin"] } as const;
const headers = (w: keyof typeof who) => ({ "x-dev-account-id": who[w][0], "x-dev-user-id": who[w][1], "x-dev-role": who[w][2] });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ChangeNotifier sur LISTEN de PGlite (même rôle que pgNotifier sur `pg`). */
function pgliteNotifier(): ChangeNotifier {
  const offs: Array<() => Promise<void>> = [];
  return {
    async start(h) {
      offs.push(await pg.listen("wnext_changes", (p) => h.onNotify(p)));
      offs.push(await pg.listen("wnext_notifications", (p) => { const m = /^(\d+):(\d+)$/.exec(p); if (m) h.onUserNotify?.(m[1]!, m[2]!); }));
      h.onUp();
    },
    async stop() { for (const off of offs) await off(); },
  };
}

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

async function live(w: keyof typeof who) {
  const cursor = (await http("GET", "/api/v1/schedule?from=2026-03-02&to=2026-03-06", headers(w))).json.changeCursor as string;
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/realtime`, { headers: headers(w) });
  const got: RealtimeServerMessage[] = [];
  ws.on("message", (d) => got.push(RealtimeServerMessage.parse(JSON.parse(d.toString())))); // chaque message respecte le contrat
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  ws.send(JSON.stringify({ v: 1, type: "subscribe", cursor }));
  const until = async (pred: () => boolean) => { for (let i = 0; i < 200 && !pred(); i++) await wait(25); expect(pred()).toBe(true); };
  await until(() => got.some((m) => m.type === "ready"));
  const counts = () => got.filter((m) => m.type === "notifications").map((m) => (m as { unreadCount: number }).unreadCount);
  return { ws, got, until, counts };
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
  await pg.exec(`
    INSERT INTO users (email) VALUES ('o@x.test'), ('a@x.test'), ('m@x.test');
    INSERT INTO accounts (name) VALUES ('A'), ('B');
    INSERT INTO people (account_id, name) VALUES (1, 'Adam'), (1, 'Mia'), (2, 'Mia B');
    INSERT INTO projects (account_id, name) VALUES (1, 'P'), (2, 'Q');
    INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (1, 2, 'admin', 1), (1, 3, 'member', 2), (2, 3, 'admin', 3);
  `);
  srv = await startServer({ db, authenticate: devAuthenticate, pollIntervalMs: 60_000, notifier: pgliteNotifier(), onError: () => {} });
}, 120_000);
afterAll(async () => { await srv?.close(); await pg?.close(); }, 60_000);

describe("message temps réel `notifications`", () => {
  it("au seul destinataire : nouveau compteur à l'émission puis au marquage lu ; rien pour l'admin auteur ni pour l'autre compte", async () => {
    const [member, admin, other] = [await live("member"), await live("admin"), await live("other")];
    const created = await http("POST", "/api/v1/allocations", headers("admin"), { personId: "2", projectId: "1", startDate: "2026-03-02", endDate: "2026-03-02", load: { mode: "hours", hoursPerDay: 3 } });
    expect(created.status).toBe(201);
    await member.until(() => member.counts().length === 1);
    expect(member.counts()).toEqual([1]);
    await admin.until(() => admin.got.some((m) => m.type === "changes")); // le changement d'allocation, lui, est diffusé au compte
    const id = (await http("GET", "/api/v1/notifications", headers("member"))).json.items[0].id as string;
    expect((await http("POST", `/api/v1/notifications/${id}/read`, headers("member"))).status).toBe(200);
    await member.until(() => member.counts().length === 2);
    expect(member.counts()).toEqual([1, 0]);
    await wait(150);
    expect(admin.counts()).toEqual([]);
    expect(other.counts()).toEqual([]);
    expect(other.got.filter((m) => m.type === "changes")).toEqual([]); // ni le changement d'un autre compte
    for (const c of [member, admin, other]) c.ws.close();
  });
});
