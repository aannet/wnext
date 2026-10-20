// Client temps réel : connexion, abonnement, reprise, attente croissante avec plancher du contrat, arrêt. Socket et minuteurs simulés.
import { REALTIME_PATH, REALTIME_RETRY_AFTER_SECONDS, type Change, type RealtimeTicket } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { RealtimeAuthError, RealtimeRateLimitedError, createRealtimeClient, ticketFrom, type RealtimeClientOptions, type RealtimeStatus, type SocketLike } from "../src/index";

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: any[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  // côté serveur
  open() { this.onopen?.({}); }
  say(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop() { this.onclose?.({}); }
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const ch = (seq: string): Change => ({ seq, entity: "departments", id: "1", op: "update", version: 2 });
const ready = (cursor: string) => ({ v: 1, type: "ready", cursor });
const changes = (seq: string) => ({ v: 1, type: "changes", changes: [ch(seq)], cursor: seq, hasMore: false });

function setup(over: Partial<RealtimeClientOptions> & { cursors?: string[]; ticketError?: () => Error | null } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const statuses: RealtimeStatus[] = [];
  const got: { changes: Change[]; cursor: string }[] = [];
  const errors: unknown[] = [];
  const log = { loadCursor: 0, ticket: 0, unauth: 0 };
  const clock = { t: 1_000_000 };
  const cursors = over.cursors ?? ["10", "20", "30", "40"];
  const client = createRealtimeClient({
    wsBase: "wss://app.test",
    getTicket: async (): Promise<RealtimeTicket> => {
      const err = over.ticketError?.();
      if (err) throw err;
      log.ticket++;
      return { ticket: `ticket-${log.ticket}-AAAAAAAAAAAA`, expiresInSeconds: 30 };
    },
    loadCursor: async () => cursors[log.loadCursor++] ?? "99",
    onChanges: (c, cursor) => got.push({ changes: c, cursor }),
    onStatus: (s) => statuses.push(s),
    onUnauthenticated: () => log.unauth++,
    onError: (e) => errors.push(e),
    openSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    random: () => 0.999,
    now: () => clock.t,
    ...over,
  });
  const pending = () => timers.filter((t) => t.live);
  /** Déclenche le minuteur en attente le plus récent (celui de reprise ou de délai de connexion) et rend son délai. */
  const fire = async () => { const t = pending().at(-1)!; t.live = false; t.fn(); await flush(); return t.ms; };
  const last = () => sockets.at(-1)!;
  const goLive = async (cursor: string) => { last().open(); last().say(ready(cursor)); await flush(); };
  return { client, sockets, timers, pending, statuses, got, errors, log, clock, fire, last, goLive };
}

describe("connexion et abonnement", () => {
  it("charge le curseur, demande un ticket, ouvre le canal du contrat, s'abonne puis passe en direct", async () => {
    const h = setup();
    h.client.start();
    await flush();
    expect(h.log).toMatchObject({ loadCursor: 1, ticket: 1 });
    expect(h.last().url).toBe(`wss://app.test${REALTIME_PATH}?ticket=ticket-1-AAAAAAAAAAAA`);
    expect(h.statuses).toEqual(["connecting"]);
    h.last().open();
    expect(h.last().sent).toEqual([{ v: 1, type: "subscribe", cursor: "10" }]);
    h.last().say(ready("10"));
    expect(h.statuses).toEqual(["connecting", "live"]);
    h.last().say(changes("11"));
    expect(h.got).toEqual([{ changes: [ch("11")], cursor: "11" }]);
  });
  it("start est idempotent", async () => {
    const h = setup();
    h.client.start();
    h.client.start();
    await flush();
    expect(h.sockets).toHaveLength(1);
  });
  it("le ticket est encodé dans l'URL", async () => {
    const h = setup({ getTicket: async () => ({ ticket: "a+b/c=d-e_fAAAAAAAAAA", expiresInSeconds: 30 }) });
    h.client.start();
    await flush();
    expect(h.last().url).toContain("ticket=a%2Bb%2Fc%3Dd-e_fAAAAAAAAAA");
  });
});

describe("reprise après coupure", () => {
  it("rouvre avec un ticket neuf et le dernier curseur, sans recharger la fenêtre", async () => {
    const h = setup();
    h.client.start();
    await flush();
    await h.goLive("10");
    h.last().say(changes("15"));
    h.last().drop();
    expect(h.statuses.at(-1)).toBe("waiting");
    await h.fire();
    expect(h.sockets).toHaveLength(2);
    expect(h.last().url).toContain("ticket-2-");
    h.last().open();
    expect(h.last().sent).toEqual([{ v: 1, type: "subscribe", cursor: "15" }]);
    expect(h.log.loadCursor).toBe(1);
  });
  it("coupure d'une connexion établie : attente de base avec aléa, sans le plancher du contrat", async () => {
    const lo = setup({ random: () => 0 });
    lo.client.start(); await flush(); await lo.goLive("10"); lo.last().drop();
    expect(await lo.fire()).toBe(500);
    const hi = setup({ random: () => 0.999 });
    hi.client.start(); await flush(); await hi.goLive("10"); hi.last().drop();
    expect(await hi.fire()).toBeLessThan(1000);
  });
});

describe("échec d'ouverture (429, 500, réseau)", () => {
  it("attend au moins Retry-After du contrat, puis davantage à chaque échec, jamais plus que le plafond", async () => {
    const h = setup();
    h.client.start();
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      h.last().drop(); // fermé sans jamais s'ouvrir
      delays.push(await h.fire());
    }
    expect(delays[0]).toBeGreaterThanOrEqual(REALTIME_RETRY_AFTER_SECONDS * 1000);
    expect(delays.every((d, i) => i === 0 || d >= delays[i - 1]!)).toBe(true);
    expect(delays.at(-1)).toBeGreaterThan(29_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    expect(new Set(delays).size).toBeGreaterThan(2);
  });
  it("l'aléa répartit les clients : deux tirages différents donnent des attentes différentes", async () => {
    const delayWith = async (r: number) => {
      const h = setup({ random: () => r });
      h.client.start(); await flush(); h.last().drop(); await flush();
      await h.fire(); h.last().drop();
      await h.fire(); h.last().drop(); await flush(); await h.fire(); h.last().drop();
      return h.fire();
    };
    expect(await delayWith(0)).toBeLessThan(await delayWith(0.99));
  });
  it("chaque tentative demande un ticket neuf", async () => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().drop();
    await h.fire();
    h.last().drop();
    await h.fire();
    expect(h.sockets.map((s) => /ticket-(\d+)-/.exec(s.url)![1])).toEqual(["1", "2", "3"]);
  });
  it("une connexion ouverte mais jamais prête est coupée au délai de connexion et reprise avec le plancher", async () => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().open(); // pas de ready
    expect(await h.fire()).toBe(10_000); // le minuteur de connexion
    expect(h.sockets[0]!.closed).toBe(true);
    expect(await h.fire()).toBeGreaterThanOrEqual(5000);
    expect(h.sockets).toHaveLength(2);
  });
  it("un échec du ticket (hors 401) est transitoire : reprise avec le plancher", async () => {
    let fail = true;
    const h = setup({ ticketError: () => (fail ? new Error("HTTP 503") : null) });
    h.client.start();
    await flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    fail = false;
    expect(await h.fire()).toBeGreaterThanOrEqual(5000);
    expect(h.sockets).toHaveLength(1);
  });
  it("l'échec de chargement du curseur est transitoire aussi", async () => {
    let n = 0;
    const h = setup({ loadCursor: async () => { if (n++ === 0) throw new Error("réseau"); return "5"; } });
    h.client.start();
    await flush();
    await h.fire();
    h.last().open();
    expect(h.last().sent[0].cursor).toBe("5");
  });
  it("une connexion tenue au moins stableMs remet l'attente à zéro ; une connexion fugace non", async () => {
    const h = setup({ random: () => 0 });
    h.client.start();
    await flush();
    for (let i = 0; i < 4; i++) { h.last().drop(); await h.fire(); } // attente qui a grandi
    await h.goLive("10");
    h.clock.t += 2_000; // fugace
    h.last().drop();
    expect(await h.fire()).toBeGreaterThan(500);
    await h.goLive("10");
    h.clock.t += 11_000; // stable
    h.last().drop();
    expect(await h.fire()).toBe(500);
  });
});

describe("authentification", () => {
  it("401 sur le ticket : arrêt, notification, aucune reprise", async () => {
    const h = setup({ ticketError: () => new RealtimeAuthError() });
    h.client.start();
    await flush();
    expect(h.log.unauth).toBe(1);
    expect(h.statuses.at(-1)).toBe("stopped");
    expect(h.pending()).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
  });
  it("ticketFrom : 401 -> RealtimeAuthError ; autre échec -> erreur ordinaire ; succès -> ticket", async () => {
    const t: RealtimeTicket = { ticket: "A".repeat(20), expiresInSeconds: 30 };
    expect(await ticketFrom({ createRealtimeTicket: async () => ({ ok: true, status: 200, data: t }) })()).toEqual(t);
    await expect(ticketFrom({ createRealtimeTicket: async () => ({ ok: false, status: 401, error: {} }) })()).rejects.toBeInstanceOf(RealtimeAuthError);
    const err = await ticketFrom({ createRealtimeTicket: async () => ({ ok: false, status: 500, error: {} }) })().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RealtimeAuthError);
  });
});

describe("entités du journal", () => {
  it("transmet sans filtrer clients, phases, project_tasks, milestones et project_team", async () => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().open();
    h.last().say(ready("10"));
    const entities = ["clients", "phases", "project_tasks", "milestones", "project_team"] as const;
    const batch: Change[] = entities.map((entity, i) => ({ seq: String(11 + i), entity, id: "7", op: "update", version: 11 + i }));
    h.last().say({ v: 1, type: "changes", changes: batch, cursor: "15", hasMore: false });
    expect(h.errors).toEqual([]);
    expect(h.got).toEqual([{ changes: batch, cursor: "15" }]);
  });
});

describe("limitation de débit (429)", () => {
  it("ticketFrom : 429 avec params.retryAfterSeconds -> RealtimeRateLimitedError ; sans valeur -> erreur ordinaire", async () => {
    const err = await ticketFrom({ createRealtimeTicket: async () => ({ ok: false, status: 429, error: { params: { retryAfterSeconds: 42 } } }) })().catch((e) => e);
    expect(err).toBeInstanceOf(RealtimeRateLimitedError);
    expect(err.retryAfterSeconds).toBe(42);
    const plain = await ticketFrom({ createRealtimeTicket: async () => ({ ok: false, status: 429, error: {} }) })().catch((e) => e);
    expect(plain).not.toBeInstanceOf(RealtimeRateLimitedError);
  });
  it("l'attente suit retryAfterSeconds quand il dépasse le plancher du contrat", async () => {
    const seconds = REALTIME_RETRY_AFTER_SECONDS * 4;
    const h = setup({ ticketError: () => new RealtimeRateLimitedError(seconds) });
    h.client.start();
    await flush();
    expect(h.pending().at(-1)!.ms).toBeGreaterThanOrEqual(seconds * 1000);
  });
});

describe("resynchronisation", () => {
  it("resync : recharge la fenêtre, repart du nouveau curseur, sans attente de plancher", async () => {
    const h = setup();
    h.client.start();
    await flush();
    await h.goLive("10");
    h.last().say({ v: 1, type: "resync", reason: "cursor_expired", head: "500" });
    h.last().drop();
    expect(await h.fire()).toBeLessThan(1000);
    expect(h.log.loadCursor).toBe(2);
    h.last().open();
    expect(h.last().sent).toEqual([{ v: 1, type: "subscribe", cursor: "20" }]);
  });
  it("resync reçu pendant l'abonnement (avant ready) : même conduite", async () => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().open();
    h.last().say({ v: 1, type: "resync", reason: "cursor_expired", head: "500" });
    h.last().drop();
    expect(await h.fire()).toBeLessThan(1000);
    expect(h.log.loadCursor).toBe(2);
  });
  it("SCHEDULE_CURSOR_INVALID recharge ; une autre erreur reprend au même curseur", async () => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().open();
    h.last().say({ v: 1, type: "error", code: "SCHEDULE_CURSOR_INVALID", params: {} });
    h.last().drop();
    await h.fire();
    expect(h.log.loadCursor).toBe(2);
    await h.goLive("20");
    h.last().say({ v: 1, type: "error", code: "INTERNAL_ERROR", params: {} });
    h.last().drop();
    await h.fire();
    expect(h.log.loadCursor).toBe(2);
    h.last().open();
    expect(h.last().sent[0].cursor).toBe("20");
  });
  it("le consommateur échoue sur un lot : on repart d'un chargement complet", async () => {
    let boom = true;
    const h = setup({ onChanges: () => { if (boom) { boom = false; throw new Error("rendu"); } } });
    h.client.start();
    await flush();
    await h.goLive("10");
    h.last().say(changes("11"));
    expect(h.sockets[0]!.closed).toBe(true);
    await h.fire();
    expect(h.log.loadCursor).toBe(2);
    expect(h.errors).toHaveLength(1);
  });
});

describe("messages illisibles et arrêt", () => {
  it.each([["JSON invalide", "pas du json"], ["type inconnu", JSON.stringify({ v: 1, type: "data" })], ["protocole futur", JSON.stringify({ v: 2, type: "ready", cursor: "1" })]])("%s : coupe et reprend", async (_n, raw) => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().open();
    h.last().onmessage!({ data: raw });
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.errors).toHaveLength(1);
    expect(await h.fire()).toBeGreaterThanOrEqual(5000);
    expect(h.sockets).toHaveLength(2);
  });
  it("stop : ferme le canal, annule la reprise, ignore les événements tardifs", async () => {
    const h = setup();
    h.client.start();
    await flush();
    await h.goLive("10");
    const s = h.last();
    h.client.stop();
    expect(s.closed).toBe(true);
    s.say(changes("11"));
    s.drop();
    expect(h.got).toHaveLength(0);
    expect(h.pending()).toHaveLength(0);
    expect(h.statuses.at(-1)).toBe("stopped");
  });
  it("stop pendant l'attente annule la reprise", async () => {
    const h = setup();
    h.client.start();
    await flush();
    h.last().drop();
    expect(h.pending()).toHaveLength(1);
    h.client.stop();
    expect(h.pending()).toHaveLength(0);
  });
  it("stop pendant la demande de ticket : aucun canal n'est ouvert", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup({ getTicket: async () => { await gate; return { ticket: "A".repeat(20), expiresInSeconds: 30 }; } });
    h.client.start();
    await flush();
    h.client.stop();
    release();
    await flush();
    expect(h.sockets).toHaveLength(0);
  });
  it("redémarrable après stop, depuis un chargement complet", async () => {
    const h = setup();
    h.client.start();
    await flush();
    await h.goLive("10");
    h.client.stop();
    h.client.start();
    await flush();
    expect(h.log.loadCursor).toBe(2);
    expect(h.sockets).toHaveLength(2);
  });
  it("un socket remplacé ne peut plus déclencher de reprise (événement tardif de l'ancienne tentative)", async () => {
    const h = setup();
    h.client.start();
    await flush();
    const old = h.last();
    old.drop();
    await h.fire();
    const before = { timers: h.pending().length, sockets: h.sockets.length };
    old.drop();
    old.say(changes("77"));
    expect({ timers: h.pending().length, sockets: h.sockets.length }).toEqual(before); // seul le minuteur de connexion de la nouvelle tentative
    expect(h.got).toHaveLength(0);
    expect(h.statuses.at(-1)).toBe("connecting");
  });
});

describe("notifications in-app (message `notifications`)", () => {
  it("transmet le compteur de non lues à onNotifications, sans toucher au curseur ni à la connexion", async () => {
    const counts: number[] = [];
    const h = setup({ onNotifications: (n) => counts.push(n) });
    h.client.start();
    await flush();
    await h.goLive("10");
    h.last().say({ v: 1, type: "notifications", unreadCount: 3 });
    h.last().say(changes("11"));
    h.last().say({ v: 1, type: "notifications", unreadCount: 0 });
    expect(counts).toEqual([3, 0]);
    expect(h.got).toEqual([{ changes: [ch("11")], cursor: "11" }]);
    expect(h.sockets).toHaveLength(1);
    expect(h.last().closed).toBe(false);
  });
  it("sans consommateur, ou consommateur en échec : la connexion reste ouverte", async () => {
    const h = setup({ onNotifications: () => { throw new Error("badge"); } });
    h.client.start();
    await flush();
    await h.goLive("10");
    h.last().say({ v: 1, type: "notifications", unreadCount: 1 });
    expect(h.last().closed).toBe(false);
    expect(h.errors).toHaveLength(1);
  });
});
