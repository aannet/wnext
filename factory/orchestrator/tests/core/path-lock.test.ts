import { describe, expect, it } from "vitest";
import { PathLockManager } from "../../src/core/path-lock";
import { settle } from "./helpers";

describe("PathLockManager", () => {
  it("fichiers disjoints : acquisition immédiate", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["a.ts"]); await l.acquire("L2", ["b.ts"]);
    expect(l.holders()).toEqual({ "a.ts": "L1", "b.ts": "L2" });
  });
  it("même fichier : le second attend la libération (FIFO)", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["a.ts"]);
    const order: string[] = [];
    const p2 = l.acquire("L2", ["a.ts"]).then(() => order.push("L2"));
    const p3 = l.acquire("L3", ["./a.ts"]).then(() => order.push("L3"));
    await settle();
    expect(order).toEqual([]);
    l.release("L1"); await settle();
    expect(order).toEqual(["L2"]);
    l.release("L2"); await p2; await p3;
    expect(order).toEqual(["L2", "L3"]);
  });
  it("tout ou rien : pas de verrou partiel", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["a.ts"]);
    let got = false;
    void l.acquire("L2", ["b.ts", "a.ts"]).then(() => { got = true; });
    await settle();
    expect(got).toBe(false);
    expect(l.holders()["b.ts"]).toBeUndefined();
    l.release("L1"); await settle();
    expect(got).toBe(true);
  });
  it("pas de dépassement : un waiter ultérieur ne double pas un waiter plus ancien sur le même chemin", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["a.ts"]);
    const order: string[] = [];
    void l.acquire("L2", ["a.ts", "b.ts"]).then(() => order.push("L2"));
    void l.acquire("L3", ["b.ts"]).then(() => order.push("L3"));
    await settle();
    expect(order).toEqual([]); // L3 pourrait prendre b.ts mais L2 est devant
    l.release("L1"); await settle();
    expect(order).toEqual(["L2"]);
  });
  it("un dossier (suffixe /) verrouille tout son contenu", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["src/db/"]);
    expect(l.tryAcquire("L2", ["src/db/schema.sql"])).toBe(false);
    expect(l.tryAcquire("L2", ["src/web/x.ts"])).toBe(true);
  });
  it("AbortSignal annule une attente sans fuite", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["a.ts"]);
    const ac = new AbortController();
    const p = l.acquire("L2", ["a.ts"], ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/annul/);
    l.release("L1");
    expect(l.tryAcquire("L3", ["a.ts"])).toBe(true);
  });
  it("contention : 4 lignes sur le même fichier ne se chevauchent jamais", async () => {
    const l = new PathLockManager();
    let inside = 0, maxInside = 0;
    const log: string[] = [];
    const worker = async (id: string) => {
      await l.acquire(id, ["hot.ts"]);
      inside++; maxInside = Math.max(maxInside, inside); log.push(`in:${id}`);
      await settle(20);
      inside--; log.push(`out:${id}`);
      l.release(id);
    };
    await Promise.all(["L1", "L2", "L3", "L4"].map(worker));
    expect(maxInside).toBe(1);
    expect(log).toEqual(["in:L1", "out:L1", "in:L2", "out:L2", "in:L3", "out:L3", "in:L4", "out:L4"]);
  });
  it("double acquisition par le même propriétaire refusée ; release idempotent", async () => {
    const l = new PathLockManager();
    await l.acquire("L1", ["a.ts"]);
    await expect(l.acquire("L1", ["b.ts"])).rejects.toThrow(/déjà/);
    l.release("L1"); l.release("L1");
    expect(l.holders()).toEqual({});
  });
});
