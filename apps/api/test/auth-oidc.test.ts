// Authentification par jeton porteur OIDC : vérification du JWT (signature, émetteur, audience, expiration), cache JWKS,
// résolution utilisateur -> compte -> rôle en base (PGlite, RLS active), et serveur complet avec ce mécanisme.
import { createHmac, generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createJwtVerifier, loadConfig, oidcAuthenticate, remoteJwks, startServer, type Db, type RunningServer } from "../src/index";

const ISS = "https://idp.example.test/";
const AUD = "wnext-api";
const NOW = 1_800_000_000_000; // ms
const T = NOW / 1000;

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaOther = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaWeak = generateKeyPairSync("rsa", { modulusLength: 1024 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ec384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
const pub = (k: KeyObject, kid: string, extra: object = {}): JsonWebKey => ({ ...k.export({ format: "jwk" }), kid, ...extra }) as JsonWebKey;

const JWKS: Record<string, JsonWebKey> = {
  rsa1: pub(rsa.publicKey, "rsa1"),
  ec1: pub(ec.publicKey, "ec1"),
  weak: pub(rsaWeak.publicKey, "weak"),
  p384: pub(ec384.publicKey, "p384"),
  enc: pub(rsa.publicKey, "enc", { use: "enc" }),
};

type Claims = Record<string, unknown>;
const good = (over: Claims = {}): Claims => ({ iss: ISS, aud: AUD, sub: "sub-1", exp: T + 600, ...over });

function jwt(claims: Claims, o: { alg?: string; kid?: string | null; key?: KeyObject } = {}) {
  const alg = o.alg ?? "RS256";
  const header: Record<string, unknown> = { alg, typ: "JWT" };
  if (o.kid !== null) header.kid = o.kid ?? (alg === "ES256" ? "ec1" : "rsa1");
  const data = `${enc(header)}.${enc(claims)}`;
  let sig: Buffer;
  if (alg === "RS256") sig = sign("sha256", Buffer.from(data), o.key ?? rsa.privateKey);
  else if (alg === "ES256") sig = sign("sha256", Buffer.from(data), { key: o.key ?? ec.privateKey, dsaEncoding: "ieee-p1363" });
  else if (alg === "HS256") sig = createHmac("sha256", JSON.stringify(JWKS.rsa1)).update(data).digest();
  else sig = Buffer.alloc(0);
  return `${data}.${sig.toString("base64url")}`;
}

const keys = async (kid: string | undefined) => (kid === undefined ? JWKS.rsa1 : JWKS[kid]);
const verifier = createJwtVerifier({ issuer: ISS, audience: AUD, keys, now: () => NOW });
const sub = async (token: string) => (await verifier.verify(token))?.sub ?? null;

describe("createJwtVerifier", () => {
  it("accepte RS256 et ES256", async () => {
    expect(await sub(jwt(good()))).toBe("sub-1");
    expect(await sub(jwt(good(), { alg: "ES256" }))).toBe("sub-1");
  });
  it("accepte un jeton sans kid quand le fournisseur n'a qu'une clé", async () => expect(await sub(jwt(good(), { kid: null }))).toBe("sub-1"));
  it("audience en tableau", async () => expect(await sub(jwt(good({ aud: ["autre", AUD] })))).toBe("sub-1"));

  it.each([
    ["émetteur différent", good({ iss: "https://evil.test/" })],
    ["émetteur absent", good({ iss: undefined })],
    ["audience différente", good({ aud: "autre" })],
    ["audience absente", good({ aud: undefined })],
    ["audience en tableau sans la nôtre", good({ aud: ["a", "b"] })],
    ["expiré (au-delà de la tolérance)", good({ exp: T - 61 })],
    ["exp absent", good({ exp: undefined })],
    ["exp non numérique", good({ exp: String(T + 600) })],
    ["nbf dans le futur (au-delà de la tolérance)", good({ nbf: T + 61 })],
    ["nbf non numérique", good({ nbf: "0" })],
    ["sub absent", good({ sub: undefined })],
    ["sub vide", good({ sub: "" })],
    ["sub numérique", good({ sub: 12 })],
  ])("refuse : %s", async (_n, claims) => expect(await sub(jwt(claims))).toBeNull());

  it("tolérance d'horloge de 60 s", async () => {
    expect(await sub(jwt(good({ exp: T - 59 })))).toBe("sub-1");
    expect(await sub(jwt(good({ nbf: T + 59 })))).toBe("sub-1");
  });

  it("refuse alg none", async () => expect(await sub(`${enc({ alg: "none" })}.${enc(good())}.`)).toBeNull());
  it("refuse alg none avec signature", async () => expect(await sub(jwt(good(), { alg: "none" }))).toBeNull());
  it("refuse HS256 signé avec la clé publique comme secret", async () => expect(await sub(jwt(good(), { alg: "HS256" }))).toBeNull());
  it("refuse une signature d'une autre clé", async () => expect(await sub(jwt(good(), { key: rsaOther.privateKey }))).toBeNull());
  it("refuse un jeton altéré", async () => {
    const [h, , s] = jwt(good()).split(".");
    expect(await sub(`${h}.${enc(good({ sub: "pirate" }))}.${s}`)).toBeNull();
  });
  it("refuse ES256 annoncé sur une clé RSA (et inversement)", async () => {
    expect(await sub(jwt(good(), { alg: "ES256", kid: "rsa1" }))).toBeNull();
    expect(await sub(jwt(good(), { alg: "RS256", kid: "ec1", key: ec.privateKey }))).toBeNull();
  });
  it("refuse un kid inconnu", async () => expect(await sub(jwt(good(), { kid: "inconnu" }))).toBeNull());
  it("refuse une clé RSA de 1024 bits", async () => expect(await sub(jwt(good(), { kid: "weak", key: rsaWeak.privateKey }))).toBeNull());
  it("refuse une courbe autre que P-256", async () => expect(await sub(jwt(good(), { alg: "ES256", kid: "p384", key: ec384.privateKey }))).toBeNull());
  it("refuse une clé réservée au chiffrement", async () => expect(await sub(jwt(good(), { kid: "enc" }))).toBeNull());
  it.each([
    ["vide", ""],
    ["deux segments", "a.b"],
    ["quatre segments", "a.b.c.d"],
    ["segment vide", "a..c"],
    ["en-tête illisible", `!!!.${enc(good())}.AAAA`],
    ["charge utile non objet", `${enc({ alg: "RS256" })}.${enc([1])}.AAAA`],
    ["trop gros", `${enc({ alg: "RS256" })}.${"A".repeat(9000)}.AAAA`],
  ])("refuse un jeton mal formé : %s", async (_n, token) => expect(await sub(token)).toBeNull());
});

describe("remoteJwks", () => {
  function server(initial: JsonWebKey[]) {
    const s = { calls: 0, keys: initial, fail: false, now: NOW };
    const fetchFn = (async () => {
      s.calls++;
      if (s.fail) return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({ keys: s.keys }), { status: 200 });
    }) as unknown as typeof fetch;
    const resolver = remoteJwks({ url: "https://idp.test/jwks", fetch: fetchFn, ttlMs: 600_000, cooldownMs: 30_000, now: () => s.now });
    return { s, resolver };
  }

  it("met les clés en cache", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    expect((await resolver("rsa1"))?.kid).toBe("rsa1");
    expect((await resolver("rsa1"))?.kid).toBe("rsa1");
    expect(s.calls).toBe(1);
  });
  it("un jeton sans kid n'est accepté que s'il n'y a qu'une clé", async () => {
    expect(await server([JWKS.rsa1!]).resolver(undefined)).toBeDefined();
    expect(await server([JWKS.rsa1!, JWKS.ec1!]).resolver(undefined)).toBeUndefined();
  });
  it("kid inconnu : un rechargement au plus par période de repos", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    await resolver("rsa1");
    expect(await resolver("x")).toBeUndefined(); // dans le repos : pas de requête
    expect(s.calls).toBe(1);
    s.now += 31_000;
    expect(await resolver("x")).toBeUndefined();
    expect(s.calls).toBe(2);
    expect(await resolver("x")).toBeUndefined();
    expect(s.calls).toBe(2);
  });
  it("rotation : la nouvelle clé est trouvée après le repos", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    await resolver("rsa1");
    s.keys = [JWKS.rsa1!, JWKS.ec1!];
    s.now += 31_000;
    expect((await resolver("ec1"))?.kid).toBe("ec1");
  });
  it("recharge après la durée de vie du cache", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    await resolver("rsa1");
    s.now += 601_000;
    await resolver("rsa1");
    expect(s.calls).toBe(2);
  });
  it("panne du fournisseur avec des clés connues : on continue avec le cache", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    await resolver("rsa1");
    s.fail = true;
    s.now += 601_000;
    expect((await resolver("rsa1"))?.kid).toBe("rsa1");
  });
  it("panne du fournisseur sans clé connue : erreur d'infrastructure, pas un refus", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    s.fail = true;
    await expect(resolver("rsa1")).rejects.toThrow("HTTP 503");
  });
  it("réponse sans champ keys", async () => {
    const r = remoteJwks({ url: "https://idp.test/jwks", fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(r("a")).rejects.toThrow("keys");
  });
  it("requêtes simultanées : un seul chargement", async () => {
    const { s, resolver } = server([JWKS.rsa1!]);
    await Promise.all([resolver("rsa1"), resolver("rsa1"), resolver("rsa1")]);
    expect(s.calls).toBe(1);
  });
});

// ---- Résolution en base ----
let pg: PGlite;
let srv: RunningServer;
const db: Db = { transaction: (fn) => pg.transaction(async (tx) => { await tx.query("SET LOCAL ROLE app_user"); return fn(tx as never); }) };
const authenticate = oidcAuthenticate({ db, verifier });
const bearer = (subject: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${jwt(good({ sub: subject }))}`, ...extra });

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist, citext } });
  await pg.exec(readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8"));
  await pg.exec(`
    INSERT INTO accounts (name) VALUES ('A'), ('B'), ('C');
    INSERT INTO users (email, idp_subject) VALUES
      ('solo@x.test', 'sub-solo'), ('multi@x.test', 'sub-multi'), ('rien@x.test', 'sub-rien'), ('sans-idp@x.test', NULL);
    INSERT INTO account_members (account_id, user_id, role) VALUES
      (1, 1, 'member'), (1, 2, 'owner'), (2, 2, 'guest'), (3, 4, 'admin');
  `);
  srv = await startServer({ db, authenticate, pollIntervalMs: 50 });
}, 60_000); // chargement du schéma sous charge (suite complète en parallèle)
afterAll(async () => { await srv.close(); await pg.close(); });

describe("oidcAuthenticate", () => {
  it("une seule appartenance : le compte et le rôle viennent de la base", async () => {
    expect(await authenticate(bearer("sub-solo"))).toEqual({ accountId: "1", userId: "1", role: "member" });
  });
  it("plusieurs appartenances : le compte demandé fixe le rôle de ce compte", async () => {
    expect(await authenticate(bearer("sub-multi", { "x-account-id": "1" }))).toEqual({ accountId: "1", userId: "2", role: "owner" });
    expect(await authenticate(bearer("sub-multi", { "x-account-id": "2" }))).toEqual({ accountId: "2", userId: "2", role: "guest" });
  });
  it("plusieurs appartenances sans compte demandé : refusé (pas de choix implicite)", async () => {
    expect(await authenticate(bearer("sub-multi"))).toBeNull();
  });
  it("compte dont l'utilisateur n'est pas membre : refusé", async () => {
    expect(await authenticate(bearer("sub-solo", { "x-account-id": "2" }))).toBeNull();
    expect(await authenticate(bearer("sub-multi", { "x-account-id": "3" }))).toBeNull();
  });
  it("compte inexistant : refusé", async () => expect(await authenticate(bearer("sub-solo", { "x-account-id": "99" }))).toBeNull());
  it.each(["abc", "1;2", "", "-1", "1234567890123456789"])("x-account-id illisible %j : refusé", async (v) => {
    expect(await authenticate(bearer("sub-solo", { "x-account-id": v }))).toBeNull();
  });
  it("en-tête x-account-id répété : refusé", async () => {
    expect(await authenticate({ ...bearer("sub-solo"), "x-account-id": ["1", "1"] } as never)).toBeNull();
  });
  it("utilisateur sans appartenance : refusé", async () => expect(await authenticate(bearer("sub-rien"))).toBeNull());
  it("sub inconnu : refusé", async () => expect(await authenticate(bearer("sub-inconnu"))).toBeNull());
  it("les identités dev ne servent à rien en mode oidc", async () => {
    expect(await authenticate({ "x-dev-account-id": "1", "x-dev-user-id": "1", "x-dev-role": "owner" })).toBeNull();
  });
  it.each([
    ["sans Authorization", {}],
    ["schéma Basic", { authorization: "Basic abc" }],
    ["Bearer vide", { authorization: "Bearer " }],
    ["jeton invalide", { authorization: "Bearer a.b.c" }],
    ["caractères interdits", { authorization: "Bearer a b" }],
  ])("refusé : %s", async (_n, h) => expect(await authenticate(h)).toBeNull());
  it("un jeton expiré est refusé même pour un utilisateur connu", async () => {
    expect(await authenticate({ authorization: `Bearer ${jwt(good({ sub: "sub-solo", exp: T - 3600 }))}` })).toBeNull();
  });
});

describe("serveur complet avec jeton porteur", () => {
  const get = (path: string, h: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path, method: "GET", headers: h }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end();
    });

  it("lecture HTTP : 200 avec un jeton valide, 401 sans, 401 avec un jeton altéré", async () => {
    expect(await get("/api/v1/departments", bearer("sub-solo"))).toBe(200);
    expect(await get("/api/v1/departments", {})).toBe(401);
    expect(await get("/api/v1/departments", { authorization: `Bearer ${jwt(good({ sub: "sub-solo" })).slice(0, -4)}AAAA` })).toBe(401);
  });
  it("le rôle de la base s'applique : un membre ne peut pas écrire une entité de configuration", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path: "/api/v1/departments", method: "POST", headers: { ...bearer("sub-solo"), "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end(JSON.stringify({ name: "X" }));
    });
    expect(status).toBe(403);
  });
  it("upgrade WebSocket : accepté avec un jeton valide, refusé en 401 sinon", async () => {
    const open = (headers: Record<string, string>) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/v1/realtime`, { headers });
      ws.once("open", () => { ws.close(); resolve("open"); });
      ws.once("unexpected-response", (_r, res) => resolve(String(res.statusCode)));
      ws.once("error", () => resolve("error"));
    });
    expect(await open(bearer("sub-solo"))).toBe("open");
    expect(await open({})).toBe("401");
  });
});

describe("loadConfig : mode oidc", () => {
  const base = { DATABASE_URL: "postgres://x", AUTH_MODE: "oidc", OIDC_ISSUER: ISS, OIDC_AUDIENCE: AUD, OIDC_JWKS_URL: "https://idp.example.test/jwks" };
  it("valide, y compris en production", () => {
    expect(loadConfig(base).oidc).toEqual({ issuer: ISS, audience: AUD, jwksUrl: "https://idp.example.test/jwks" });
    expect(loadConfig({ ...base, NODE_ENV: "production" }).authMode).toBe("oidc");
  });
  it.each([
    ["issuer absent", { OIDC_ISSUER: undefined }],
    ["audience absente", { OIDC_AUDIENCE: undefined }],
    ["jwks absent", { OIDC_JWKS_URL: undefined }],
    ["jwks non http", { OIDC_JWKS_URL: "file:///etc/passwd" }],
    ["jwks en clair en production", { OIDC_JWKS_URL: "http://idp.test/jwks", NODE_ENV: "production" }],
  ])("refuse : %s", (_n, over) => expect(() => loadConfig({ ...base, ...over })).toThrow());
  it("le mode dev reste refusé en production", () => expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production" })).toThrow());
});
