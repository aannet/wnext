// Configuration, authentification de développement et adaptateur pg (pool simulé : pas de Postgres dans l'environnement).
import { describe, expect, it } from "vitest";
import { devAuthenticate, loadConfig, pgDb } from "../src/index";

describe("loadConfig", () => {
  const base = { DATABASE_URL: "postgres://x" };
  it("valeurs par défaut", () => {
    expect(loadConfig(base)).toEqual({ databaseUrl: "postgres://x", dbRole: undefined, host: "127.0.0.1", port: 3000, authMode: "dev", pollIntervalMs: 1000, wsMaxPerAccount: 200 });
  });
  it.each([
    ["DATABASE_URL absent", {}],
    ["PORT non numérique", { ...base, PORT: "abc" }],
    ["PORT hors plage", { ...base, PORT: "70000" }],
    ["POLL_INTERVAL_MS trop bas", { ...base, POLL_INTERVAL_MS: "1" }],
    ["WS_MAX_PER_ACCOUNT nul", { ...base, WS_MAX_PER_ACCOUNT: "0" }],
    ["AUTH_MODE inconnu", { ...base, AUTH_MODE: "jwt" }],
    ["DB_ROLE injectable", { ...base, DB_ROLE: "app_user; DROP TABLE x" }],
    ["mode dev en production", { ...base, NODE_ENV: "production" }],
  ])("refuse : %s", (_n, env) => expect(() => loadConfig(env)).toThrow());
});

describe("devAuthenticate", () => {
  const ok = { "x-dev-account-id": "1", "x-dev-user-id": "2", "x-dev-role": "admin" };
  it("lit l'identité", async () => expect(await devAuthenticate(ok)).toEqual({ accountId: "1", userId: "2", role: "admin" }));
  it.each([
    ["compte absent", { ...ok, "x-dev-account-id": undefined }],
    ["rôle inconnu", { ...ok, "x-dev-role": "root" }],
    ["identifiant non numérique", { ...ok, "x-dev-user-id": "1;2" }],
    ["en-tête répété", { ...ok, "x-dev-role": ["admin", "owner"] }],
  ])("null : %s", async (_n, h) => expect(await devAuthenticate(h as never)).toBeNull());
});

function fakePool(failOn?: string, failRollback = false) {
  const log: string[] = [];
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      log.push(sql);
      if (sql === failOn) throw new Error("boom");
      if (sql === "ROLLBACK" && failRollback) throw new Error("rollback boom");
      return { rows: [] };
    },
    release: (arg?: unknown) => { released.push(arg); },
  };
  return { pool: { connect: async () => client as never }, log, released };
}

describe("pgDb", () => {
  it("BEGIN, rôle, COMMIT, connexion rendue au pool", async () => {
    const f = fakePool();
    expect(await pgDb(f.pool, { role: "app_user" }).transaction(async (tx) => { await tx.query("SELECT 1"); return 42; })).toBe(42);
    expect(f.log).toEqual(["BEGIN", "SET LOCAL ROLE app_user", "SELECT 1", "COMMIT"]);
    expect(f.released).toEqual([undefined]);
  });
  it("erreur : ROLLBACK, pas de COMMIT, l'erreur remonte, connexion rendue", async () => {
    const f = fakePool("SELECT 1");
    await expect(pgDb(f.pool).transaction((tx) => tx.query("SELECT 1"))).rejects.toThrow("boom");
    expect(f.log).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
    expect(f.released).toEqual([undefined]);
  });
  it("ROLLBACK en échec : la connexion est détruite, pas réutilisée", async () => {
    const f = fakePool("SELECT 1", true);
    await expect(pgDb(f.pool).transaction((tx) => tx.query("SELECT 1"))).rejects.toThrow("boom");
    expect(f.released).toEqual([true]);
  });
  it("nom de rôle invalide refusé à la construction", () => {
    expect(() => pgDb(fakePool().pool, { role: "x; DROP" })).toThrow();
  });
});
