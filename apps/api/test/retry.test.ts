// Rejeu des transactions annulées par Postgres (interblocage, sérialisation) : withContext.
import { describe, expect, it } from "vitest";
import { withContext, type Db, type RequestContext } from "../src/db";

const ctx: RequestContext = { accountId: "1", userId: "1", role: "admin" };
const pgError = (code: string) => Object.assign(new Error(code), { code });
/** Base factice : chaque transaction exécute `fn` ; les `failures` d'abord renvoyés par la base à la place du résultat. */
const fakeDb = (failures: string[]) => {
  let transactions = 0;
  const db: Db = { transaction: async (fn) => { transactions++; const f = failures.shift(); const r = await fn({ query: async () => ({ rows: [] }) }); if (f) throw pgError(f); return r; } };
  return { db, count: () => transactions };
};

describe("withContext : rejeu des annulations Postgres", () => {
  it.each(["40P01", "40001"])("rejoue après %s et rend le résultat de la tentative suivante", async (code) => {
    const { db, count } = fakeDb([code]);
    let calls = 0;
    await expect(withContext(db, ctx, async () => ++calls)).resolves.toBe(2);
    expect(count()).toBe(2);
  });
  it("abandonne après 3 tentatives et relance l'erreur d'origine", async () => {
    const { db, count } = fakeDb(["40P01", "40P01", "40P01", "40P01"]);
    await expect(withContext(db, ctx, async () => 1)).rejects.toMatchObject({ code: "40P01" });
    expect(count()).toBe(3);
  });
  it.each(["23P01", "23505", "XX000"])("ne rejoue pas %s ni une erreur sans code", async (code) => {
    const { db, count } = fakeDb([code]);
    await expect(withContext(db, ctx, async () => 1)).rejects.toMatchObject({ code });
    expect(count()).toBe(1);
    const plain: Db = { transaction: async () => { throw new Error("x"); } };
    await expect(withContext(plain, ctx, async () => 1)).rejects.toThrow("x");
  });
});
