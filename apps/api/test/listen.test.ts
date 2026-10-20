// ChangeHub piloté par un notifier (LISTEN/NOTIFY) et pgNotifier : réveil immédiat, filet, coupure, reconnexion. Sans base : faux Db et faux client.
import { describe, expect, it } from "vitest";
import { createChangeHub, pgNotifier, type ChangeNotifier, type Db, type ListenClient, type RequestContext } from "../src/index";

const A: RequestContext = { accountId: "1", userId: "1", role: "admin" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeDb() {
  const s = { head: 0, reads: 0 };
  const db: Db = { transaction: (fn) => fn({ query: async (sql: string) => { if (sql.includes("account_change_seq")) { s.reads++; return { rows: [{ seq: s.head }] }; } return { rows: [] }; } } as never) };
  return { s, db };
}
function fakeNotifier() {
  const n = { h: undefined as Parameters<ChangeNotifier["start"]>[0] | undefined, stopped: 0 };
  const notifier: ChangeNotifier = { start: async (h) => { n.h = h; }, stop: async () => { n.stopped++; } };
  return { n, notifier };
}

describe("ChangeHub avec notifier", () => {
  it("une notification réveille aussitôt, sans attendre le minuteur", async () => {
    const { s, db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    let wakes = 0;
    const off = hub.subscribe(A, () => { wakes++; });
    n.h!.onUp();
    await wait(20);
    expect(wakes).toBe(1); // rattrapage à la connexion
    s.head = 1; n.h!.onNotify("1");
    await wait(20);
    expect(wakes).toBe(2);
    n.h!.onNotify("1"); // doublon : tête inchangée, pas de réveil
    await wait(20);
    expect(wakes).toBe(2);
    off(); hub.close();
  });

  it("notification d'un compte sans session : ignorée, aucune lecture", async () => {
    const { s, db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    n.h!.onUp();
    n.h!.onNotify("99");
    await wait(20);
    expect(s.reads).toBe(0);
    hub.close();
  });

  it("l'écoute établie : le minuteur dort (seul le filet repasse) ; coupée, il reprend sa période", async () => {
    const { s, db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 15, fallbackMs: 60_000, notifier });
    const off = hub.subscribe(A, () => {});
    n.h!.onUp();
    await wait(40);
    const quiet = s.reads;
    await wait(150);
    expect(s.reads).toBe(quiet); // ~10 périodes sans lecture
    n.h!.onDown();
    await wait(150);
    expect(s.reads).toBeGreaterThan(quiet + 3);
    off(); hub.close();
  });

  it("filet : même écoute établie, une lecture complète repasse après fallbackMs", async () => {
    const { s, db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 15, fallbackMs: 80, notifier });
    const off = hub.subscribe(A, () => {});
    n.h!.onUp();
    await wait(40);
    const before = s.reads;
    await wait(200);
    expect(s.reads).toBeGreaterThan(before);
    expect(s.reads - before).toBeLessThan(6);
    off(); hub.close();
  });

  it("reconnexion : tout le monde relit (des notifications ont pu être perdues pendant la coupure)", async () => {
    const { s, db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    let wakes = 0;
    const off = hub.subscribe(A, () => { wakes++; });
    n.h!.onUp();
    await wait(20);
    n.h!.onDown();
    s.head = 5; // changements pendant la coupure, notifications perdues
    n.h!.onUp();
    await wait(20);
    expect(wakes).toBe(2);
    off(); hub.close();
  });

  it("abonné tardif avec écoute établie : rattrapage immédiat, sans attendre le filet", async () => {
    const { db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    n.h!.onUp();
    let late = 0;
    const off = hub.subscribe(A, () => { late++; });
    await wait(20);
    expect(late).toBe(1);
    off(); hub.close();
  });

  it("notification pendant une lecture : une seconde lecture la rattrape", async () => {
    let head = 0; let reads = 0; let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const db: Db = { transaction: (fn) => fn({ query: async (sql: string) => {
      if (!sql.includes("account_change_seq")) return { rows: [] };
      const seen = head; reads++;
      if (reads === 1) await gate; // la première lecture voit l'ancienne tête et traîne
      return { rows: [{ seq: seen }] };
    } } as never) };
    const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    let wakes = 0;
    const off = hub.subscribe(A, () => { wakes++; });
    n.h!.onUp();
    await wait(10);
    head = 1; n.h!.onNotify("1"); // arrive pendant la lecture bloquée
    release();
    await wait(30);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(wakes).toBe(2);
    off(); hub.close();
  });

  it("close arrête le notifier", async () => {
    const { db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    await wait(5);
    hub.close();
    await wait(5);
    expect(n.stopped).toBe(1);
  });
});

describe("ChangeHub : réveils par utilisateur (notifications in-app)", () => {
  const M: RequestContext = { accountId: "1", userId: "3", role: "member" };
  const O: RequestContext = { accountId: "2", userId: "3", role: "admin" }; // même id utilisateur, autre compte
  it("seul l'utilisateur visé (compte + utilisateur) est réveillé ; un changement de compte ne réveille pas les abonnés utilisateur", async () => {
    const { s, db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 60_000, notifier });
    const log: string[] = [];
    const offs = [hub.subscribeUser(A, () => log.push("A")), hub.subscribeUser(M, () => log.push("M")), hub.subscribeUser(O, () => log.push("O"))];
    n.h!.onUp();
    expect(log.sort()).toEqual(["A", "M", "O"]); // reconnexion : tout le monde relit son compteur
    log.length = 0;
    n.h!.onUserNotify!("1", "3");
    n.h!.onUserNotify!("9", "9");
    s.head = 1; n.h!.onNotify("1");
    await wait(20);
    expect(log).toEqual(["M"]);
    offs[1]!();
    n.h!.onUserNotify!("1", "3");
    expect(log).toEqual(["M"]); // désabonné
    offs.forEach((off) => off()); hub.close();
  });
  it("filet : au plus un réveil de tous les abonnés utilisateur par fallbackMs", async () => {
    const { db } = fakeDb(); const { n, notifier } = fakeNotifier();
    const hub = createChangeHub({ db, intervalMs: 10, fallbackMs: 60, notifier });
    let wakes = 0;
    const off = hub.subscribeUser(M, () => { wakes++; });
    n.h!.onUp();
    wakes = 0;
    await wait(200);
    expect(wakes).toBeGreaterThanOrEqual(2);
    expect(wakes).toBeLessThanOrEqual(4);
    off(); hub.close();
  });
});

describe("pgNotifier", () => {
  function fakeClients(failConnects = 0) {
    const created: Array<{ client: ListenClient; q: string[]; emit: (e: string, a?: unknown) => void; ended: number }> = [];
    let toFail = failConnects;
    const createClient = (): ListenClient => {
      const handlers: Record<string, Array<(a?: never) => void>> = {};
      const rec = { q: [] as string[], ended: 0, emit: (e: string, a?: unknown) => (handlers[e] ?? []).forEach((f) => f(a as never)), client: undefined as unknown as ListenClient };
      rec.client = {
        connect: async () => { if (toFail > 0) { toFail--; throw new Error("refusé"); } },
        query: async (sql: string) => { rec.q.push(sql); },
        end: async () => { rec.ended++; },
        on: (e: string, f: (a?: never) => void) => { (handlers[e] ??= []).push(f); return undefined; },
      } as ListenClient;
      created.push(rec);
      return rec.client;
    };
    return { created, createClient };
  }
  const handlers = () => { const log: string[] = []; return { log, h: { onNotify: (a: string) => log.push(`n:${a}`), onUserNotify: (a: string, u: string) => log.push(`u:${a}:${u}`), onUp: () => log.push("up"), onDown: () => log.push("down") } }; };

  it("canal des notifications in-app : transmet compte et utilisateur, ignore toute autre forme", async () => {
    const { created, createClient } = fakeClients();
    const { log, h } = handlers();
    const nf = pgNotifier({ createClient });
    await nf.start(h);
    created[0]!.emit("notification", { channel: "wnext_notifications", payload: "1:42" });
    created[0]!.emit("notification", { channel: "wnext_notifications", payload: "42" });
    created[0]!.emit("notification", { channel: "wnext_notifications", payload: "1:2:3" });
    created[0]!.emit("notification", { channel: "wnext_changes", payload: "1:42" });
    created[0]!.emit("notification", { channel: "wnext_notifications" });
    expect(log).toEqual(["up", "u:1:42"]);
    await nf.stop();
  });

  it("écoute le canal, transmet le seul identifiant de compte, ignore le reste", async () => {
    const { created, createClient } = fakeClients();
    const { log, h } = handlers();
    const nf = pgNotifier({ createClient });
    await nf.start(h);
    expect(created[0]!.q).toEqual(["LISTEN wnext_changes", "LISTEN wnext_notifications"]);
    created[0]!.emit("notification", { channel: "wnext_changes", payload: "42" });
    created[0]!.emit("notification", { channel: "autre", payload: "7" });
    created[0]!.emit("notification", { channel: "wnext_changes", payload: "1; DROP" });
    created[0]!.emit("notification", { channel: "wnext_changes" });
    expect(log).toEqual(["up", "n:42"]);
    await nf.stop();
  });

  it("connexion perdue : onDown, nouvelle connexion, nouveau LISTEN, onUp", async () => {
    const { created, createClient } = fakeClients();
    const { log, h } = handlers();
    const nf = pgNotifier({ createClient, backoffMs: 10 });
    await nf.start(h);
    created[0]!.emit("error", new Error("reset"));
    created[0]!.emit("end"); // 'error' puis 'end' : une seule reprise
    await wait(60);
    expect(log).toEqual(["up", "down", "up"]);
    expect(created).toHaveLength(2);
    expect(created[1]!.q).toEqual(["LISTEN wnext_changes", "LISTEN wnext_notifications"]);
    expect(created[0]!.ended).toBeGreaterThan(0);
    await nf.stop();
  });

  it("échecs de connexion : attente croissante plafonnée, puis succès", async () => {
    const { created, createClient } = fakeClients(3);
    const { log, h } = handlers();
    const errors: unknown[] = [];
    const nf = pgNotifier({ createClient, backoffMs: 10, maxBackoffMs: 20, onError: (e) => errors.push(e) });
    await nf.start(h); // premier échec : start n'échoue pas, la reprise est planifiée
    expect(log).toEqual(["down"]);
    await wait(150);
    expect(errors).toHaveLength(3);
    expect(created).toHaveLength(4);
    expect(log.at(-1)).toBe("up");
    await nf.stop();
  });

  it("stop : plus de reconnexion", async () => {
    const { created, createClient } = fakeClients();
    const { h } = handlers();
    const nf = pgNotifier({ createClient, backoffMs: 10 });
    await nf.start(h);
    created[0]!.emit("end");
    await nf.stop();
    await wait(60);
    expect(created).toHaveLength(1);
  });
});
