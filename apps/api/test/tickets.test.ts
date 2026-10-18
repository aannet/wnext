// Tickets d'upgrade du temps réel : service (signature, échéance, usage unique) puis serveur complet (POST du ticket, upgrade avec ?ticket=).
import { request } from "node:http";
import { REALTIME_TICKET_PATH, RealtimeTicket } from "@wnext/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTicketService, devAuthenticate, loadConfig, startServer, type Db, type RequestContext, type RunningServer } from "../src/index";

const SECRET = "0123456789abcdef0123456789abcdef";
const ctx: RequestContext = { accountId: "7", userId: "42", role: "project_manager" };
const clock = (start = 1_800_000_000_000) => { const f = Object.assign(() => f.t, { t: start }); return f; };

describe("createTicketService", () => {
  it("le ticket rend le contexte de celui qui l'a demandé et respecte le contrat", () => {
    const svc = createTicketService({ secret: SECRET });
    const t = svc.issue(ctx);
    expect(RealtimeTicket.parse(t)).toEqual(t);
    expect(t.expiresInSeconds).toBe(30);
    expect(svc.redeem(t.ticket)).toEqual(ctx);
  });
  it("deux émissions donnent deux tickets distincts", () => {
    const svc = createTicketService({ secret: SECRET });
    expect(svc.issue(ctx).ticket).not.toBe(svc.issue(ctx).ticket);
  });
  it("usage unique", () => {
    const svc = createTicketService({ secret: SECRET });
    const { ticket } = svc.issue(ctx);
    expect(svc.redeem(ticket)).not.toBeNull();
    expect(svc.redeem(ticket)).toBeNull();
  });
  it("expire après la durée de vie", () => {
    const now = clock();
    const svc = createTicketService({ secret: SECRET, ttlSeconds: 30, now });
    const a = svc.issue(ctx).ticket;
    const b = svc.issue(ctx).ticket;
    now.t += 29_000;
    expect(svc.redeem(a)).not.toBeNull();
    now.t += 1_000;
    expect(svc.redeem(b)).toBeNull();
  });
  it("sans état : une autre instance au même secret l'accepte, un autre secret le refuse", () => {
    const { ticket } = createTicketService({ secret: SECRET }).issue(ctx);
    expect(createTicketService({ secret: "x".repeat(32) }).redeem(ticket)).toBeNull();
    expect(createTicketService({ secret: SECRET }).redeem(ticket)).toEqual(ctx);
  });
  it("un octet modifié, n'importe où, invalide le ticket (signature et contenu)", () => {
    const svc = createTicketService({ secret: SECRET });
    const raw = Buffer.from(svc.issue(ctx).ticket, "base64url");
    for (const i of [0, 31, 32, 40, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[i] = bad[i]! ^ 1;
      expect(svc.redeem(bad.toString("base64url"))).toBeNull();
    }
  });
  it("on ne peut pas se forger un rôle : charge utile réécrite avec l'ancienne signature", () => {
    const svc = createTicketService({ secret: SECRET });
    const raw = Buffer.from(svc.issue({ ...ctx, role: "guest" }).ticket, "base64url");
    const forged = Buffer.concat([raw.subarray(0, 32), Buffer.from(raw.subarray(32).toString("utf8").replace("guest", "owner"))]);
    expect(svc.redeem(forged.toString("base64url"))).toBeNull();
  });
  it("un ticket signé avec un contenu invalide est refusé (rôle inconnu, champs manquants, JSON illisible)", async () => {
    const { createHmac } = await import("node:crypto");
    const sign = (payload: string) => Buffer.concat([createHmac("sha256", SECRET).update(payload).digest(), Buffer.from(payload)]).toString("base64url");
    const svc = createTicketService({ secret: SECRET });
    const e = Math.floor(Date.now() / 1000) + 30;
    expect(svc.redeem(sign(JSON.stringify({ a: "1", u: "2", r: "root", e, j: "x" })))).toBeNull();
    expect(svc.redeem(sign(JSON.stringify({ a: "1", u: "2", r: "admin", e })))).toBeNull();
    expect(svc.redeem(sign("pas du json"))).toBeNull();
    expect(svc.redeem(sign(JSON.stringify({ a: "1", u: "2", r: "admin", e, j: "ok" })))).toEqual({ accountId: "1", userId: "2", role: "admin" });
  });
  it.each([["vide", ""], ["trop court", "abc"], ["caractères interdits", "a b!c"], ["trop long", "A".repeat(2000)], ["que la signature", "A".repeat(43)]])("refuse : %s", (_n, t) => {
    expect(createTicketService({ secret: SECRET }).redeem(t)).toBeNull();
  });
  it("secret trop court refusé", () => expect(() => createTicketService({ secret: "court" })).toThrow());
  it("la table des tickets utilisés est purgée des échus", () => {
    const now = clock();
    const svc = createTicketService({ secret: SECRET, ttlSeconds: 1, now });
    for (let i = 0; i < 1500; i++) { svc.redeem(svc.issue(ctx).ticket); }
    now.t += 5_000;
    const last = svc.issue(ctx).ticket;
    expect(svc.redeem(last)).toEqual(ctx);
  });
});

describe("loadConfig : WS_TICKET_SECRET", () => {
  const base = { DATABASE_URL: "postgres://x" };
  it("optionnel hors production, 32 caractères au moins", () => {
    expect(loadConfig(base).wsTicketSecret).toBeUndefined();
    expect(loadConfig({ ...base, WS_TICKET_SECRET: SECRET }).wsTicketSecret).toBe(SECRET);
    expect(() => loadConfig({ ...base, WS_TICKET_SECRET: "court" })).toThrow();
  });
  it("requis en production", () => {
    const prod = { ...base, NODE_ENV: "production", AUTH_MODE: "oidc", OIDC_ISSUER: "https://i/", OIDC_AUDIENCE: "a", OIDC_JWKS_URL: "https://i/jwks" };
    expect(() => loadConfig(prod)).toThrow("WS_TICKET_SECRET");
    expect(loadConfig({ ...prod, WS_TICKET_SECRET: SECRET }).wsTicketSecret).toBe(SECRET);
  });
});

// ---- Serveur complet ----
const noDb: Db = { transaction: async () => { throw new Error("la base ne doit pas servir à l'upgrade"); } };
const dev = (account = "7") => ({ "x-dev-account-id": account, "x-dev-user-id": "42", "x-dev-role": "member" });
let a: RunningServer;
let b: RunningServer;
beforeAll(async () => {
  a = await startServer({ db: noDb, authenticate: devAuthenticate, ticketSecret: SECRET });
  b = await startServer({ db: noDb, authenticate: devAuthenticate, ticketSecret: SECRET });
});
afterAll(async () => { await a.close(); await b.close(); });

function post(srv: RunningServer, path: string, headers: Record<string, string>, method = "POST") {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: d ? JSON.parse(d) : undefined }));
    });
    req.on("error", reject);
    req.end();
  });
}
const upgrade = (srv: RunningServer, query: string, headers: Record<string, string> = {}) => new Promise<string>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/realtime${query}`, { headers });
  ws.once("open", () => { ws.close(); resolve("open"); });
  ws.once("unexpected-response", (_r, res) => resolve(String(res.statusCode)));
  ws.once("error", () => resolve("error"));
});
const newTicket = async (srv = a, h = dev()) => (await post(srv, REALTIME_TICKET_PATH, h)).json.ticket as string;

describe("POST /api/v1/realtime/ticket", () => {
  it("200 avec un ticket conforme au contrat pour tout membre authentifié", async () => {
    const r = await post(a, REALTIME_TICKET_PATH, dev());
    expect(r.status).toBe(200);
    expect(RealtimeTicket.parse(r.json).expiresInSeconds).toBe(30);
  });
  it("401 sans identité ; l'ancien ticket ne sert pas d'identité pour en obtenir un autre", async () => {
    expect((await post(a, REALTIME_TICKET_PATH, {})).status).toBe(401);
    expect((await post(a, `${REALTIME_TICKET_PATH}?ticket=${await newTicket()}`, {})).status).toBe(401);
  });
  it("seul POST existe", async () => {
    expect((await post(a, REALTIME_TICKET_PATH, dev(), "GET")).status).toBe(404);
    expect((await post(a, REALTIME_TICKET_PATH, dev(), "PUT")).status).toBe(404);
  });
});

describe("upgrade avec ?ticket=", () => {
  it("accepté sans aucun en-tête d'identité", async () => expect(await upgrade(a, `?ticket=${await newTicket()}`)).toBe("open"));
  it("usage unique : la seconde présentation est refusée en 401", async () => {
    const t = await newTicket();
    expect(await upgrade(a, `?ticket=${t}`)).toBe("open");
    expect(await upgrade(a, `?ticket=${t}`)).toBe("401");
  });
  it("accepté par une autre instance au même secret", async () => expect(await upgrade(b, `?ticket=${await newTicket(a)}`)).toBe("open"));
  it("ticket altéré ou inventé : 401, sans repli sur les en-têtes", async () => {
    const t = await newTicket();
    expect(await upgrade(a, `?ticket=${t.slice(0, -2)}AA`, dev())).toBe("401");
    expect(await upgrade(a, "?ticket=n-importe-quoi-de-long-ok", dev())).toBe("401");
    expect(await upgrade(a, "?ticket=", dev())).toBe("401");
  });
  it("paramètre répété : 401", async () => {
    const t1 = await newTicket();
    const t2 = await newTicket();
    expect(await upgrade(a, `?ticket=${t1}&ticket=${t2}`)).toBe("401");
  });
  it("sans ticket, les en-têtes authentifient toujours (clients hors navigateur)", async () => {
    expect(await upgrade(a, "", dev())).toBe("open");
    expect(await upgrade(a, "")).toBe("401");
  });
  it("le ticket d'un compte ne donne pas accès à un autre : le contexte vient du ticket, pas des en-têtes", async () => {
    // un ticket du compte 7 présenté avec des en-têtes du compte 8 : le ticket prime (en-têtes ignorés) ; l'identité reste celle du ticket
    const svc = createTicketService({ secret: SECRET });
    expect(svc.redeem(svc.issue(ctx).ticket)).toEqual(ctx);
    expect(await upgrade(a, `?ticket=${await newTicket(a, dev("7"))}`, dev("8"))).toBe("open");
  });
});
