// RT-044 (revue croisée de L-R1) : les profils de données de la pile locale (dev, recette, vide) ne peuvent jamais toucher aux données
// d'un autre profil, en particulier .dev-pg/ d'Alec. Répertoire choisi (realpath, liens, chemins équivalents), marqueur de profil,
// refus AVANT toute suppression ou écriture, et un essai bout en bout du script (dev-stack.mjs) sur de vrais répertoires.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { MARKER, ProfileError, checkDataDir, writeMarker } from "../../scripts/dev-profile.mjs";

const stackScript = new URL("../../scripts/dev-stack.mjs", import.meta.url).pathname;
let base: string;
let root: string;
let n = 0;

/** Dépôt factice : `.dev-pg/` d'Alec avec une base (PG_VERSION) et un fichier témoin. */
function fakeRoot() {
  const r = join(base, `root${++n}`);
  mkdirSync(join(r, ".dev-pg", "data"), { recursive: true });
  writeFileSync(join(r, ".dev-pg", "data", "PG_VERSION"), "18\n");
  writeFileSync(join(r, ".dev-pg", "sentinel"), "données d'Alec");
  return r;
}
const refused = (profile: string, env: Record<string, string>, r = root) => {
  try {
    checkDataDir({ root: r, profile, env });
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    return (err as Error).message;
  }
  throw new Error("aucun refus");
};
const sentinelIntact = (r = root) => readFileSync(join(r, ".dev-pg", "sentinel"), "utf8") === "données d'Alec" && existsSync(join(r, ".dev-pg", "data", "PG_VERSION"));

beforeAll(() => { base = mkdtempSync(join(tmpdir(), "wnext-profile-")); });
afterAll(() => { rmSync(base, { recursive: true, force: true }); });
beforeEach(() => { root = fakeRoot(); });

describe("choix du répertoire de données par profil", () => {
  it("répertoire par défaut : .dev-pg, .dev-pg-recette, .dev-pg-vide, jamais confondus", () => {
    expect(checkDataDir({ root, profile: "dev", env: {} }).pgDir).toBe(join(root, ".dev-pg"));
    expect(checkDataDir({ root, profile: "recette", env: {} }).pgDir).toBe(join(root, ".dev-pg-recette"));
    expect(checkDataDir({ root, profile: "vide", env: {} }).pgDir).toBe(join(root, ".dev-pg-vide"));
  });

  it("WNEXT_DEV_PG_DIR vers .dev-pg est refusé pour recette et vide, sous toutes ses formes", () => {
    const forms = [
      join(root, ".dev-pg"), `${join(root, ".dev-pg")}/`, join(root, ".dev-pg", "..", ".dev-pg"), join(root, ".dev-pg", "data", ".."),
      join(root, ".dev-pg", "data"), join(root, ".dev-pg", "nouveau"), join(root, ".", ".dev-pg"),
    ];
    for (const profile of ["recette", "vide"]) {
      for (const dir of forms) expect(refused(profile, { WNEXT_DEV_PG_DIR: dir })).toMatch(/\.dev-pg|marqueur|chevauche/);
    }
    expect(sentinelIntact()).toBe(true);
  });

  it("liens symboliques : vers .dev-pg, ancêtre en lien, lien pendant, sous-dossier data en lien", () => {
    symlinkSync(join(root, ".dev-pg"), join(root, ".dev-pg-recette"));
    expect(refused("recette", {})).toMatch(/\.dev-pg|marqueur|chevauche/);
    const link = join(base, `lien${n}`);
    symlinkSync(root, link);
    expect(refused("vide", { WNEXT_DEV_PG_DIR: join(link, ".dev-pg") })).toMatch(/\.dev-pg|marqueur|chevauche/);
    expect(refused("vide", { WNEXT_DEV_PG_DIR: join(link, ".dev-pg", "x", "y") })).toMatch(/chevauche/);
    symlinkSync(join(base, "absent"), join(root, "pendant"));
    expect(refused("recette", { WNEXT_DEV_PG_DIR: join(root, "pendant") })).toMatch(/lien/);
    const own = join(root, ".dev-pg-vide");
    mkdirSync(own);
    writeMarker(own, "vide");
    symlinkSync(join(root, ".dev-pg", "data"), join(own, "data"));
    expect(refused("vide", {})).toMatch(/data/);
    expect(sentinelIntact()).toBe(true);
  });

  it("refuse le dépôt lui-même ou un ancêtre (un --reset supprimerait le code)", () => {
    for (const profile of ["dev", "recette", "vide"]) {
      expect(refused(profile, { WNEXT_DEV_PG_DIR: root })).toMatch(/dépôt/);
      expect(refused(profile, { WNEXT_DEV_PG_DIR: join(root, "..") })).toMatch(/dépôt/);
    }
  });

  it("répertoire non dédié : non vide sans marqueur, fichier ordinaire, marqueur d'un autre profil", () => {
    const other = join(base, `autre${n}`);
    mkdirSync(other);
    writeFileSync(join(other, "quelque-chose"), "x");
    expect(refused("recette", { WNEXT_DEV_PG_DIR: other })).toMatch(/marqueur/);
    expect(refused("vide", { WNEXT_DEV_PG_DIR: other })).toMatch(/marqueur/);
    const file = join(base, `fichier${n}`);
    writeFileSync(file, "x");
    expect(refused("recette", { WNEXT_DEV_PG_DIR: file })).toMatch(/répertoire/);
    const rec = join(base, `rec${n}`);
    mkdirSync(rec);
    writeMarker(rec, "recette");
    expect(refused("vide", { WNEXT_DEV_PG_DIR: rec })).toMatch(/profil « recette »/);
    expect(refused("dev", { WNEXT_DEV_PG_DIR: rec })).toMatch(/profil « recette »/);
    expect(readdirSync(other)).toEqual(["quelque-chose"]);
  });

  it("répertoire dédié accepté : absent, vide, ou marqué pour le profil (y compris hors du dépôt)", () => {
    const empty = join(base, `vide${n}`);
    mkdirSync(empty);
    expect(checkDataDir({ root, profile: "recette", env: { WNEXT_DEV_PG_DIR: empty } })).toMatchObject({ markerMissing: true });
    expect(checkDataDir({ root, profile: "vide", env: { WNEXT_DEV_PG_DIR: join(base, `absent${n}`) } })).toMatchObject({ markerMissing: true });
    writeMarker(empty, "recette");
    expect(readFileSync(join(empty, MARKER), "utf8").trim()).toBe("recette");
    expect(checkDataDir({ root, profile: "recette", env: { WNEXT_DEV_PG_DIR: empty } })).toMatchObject({ markerMissing: false });
  });
});

describe("dev-stack.mjs : refus avant toute suppression ou démarrage", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [stackScript, ...args], { env: { ...process.env, WNEXT_DEV_PG_PORT: "0", ...env }, encoding: "utf8", timeout: 60_000 });

  it("--seed=recette --reset sur un répertoire non dédié (.dev-pg d'Alec) : échec, rien n'est supprimé", () => {
    for (const profile of ["recette", "vide"]) {
      const r = run([`--seed=${profile}`, "--reset"], { WNEXT_DEV_PG_DIR: join(root, ".dev-pg") });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/marqueur|\.dev-pg/);
      expect(sentinelIntact()).toBe(true);
    }
    symlinkSync(join(root, ".dev-pg"), join(root, "lien"));
    const viaLink = run(["--seed=recette", "--reset"], { WNEXT_DEV_PG_DIR: join(root, "lien") });
    expect(viaLink.status).toBe(1);
    expect(sentinelIntact()).toBe(true);
  });

  it("un profil inconnu est refusé", () => {
    const r = run(["--seed=autre"], {});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inconnu/);
  });
});

describe("dev-stack.mjs : appartenance de la base vérifiée AVANT extensions et migrations", () => {
  let server: EmbeddedPostgres;
  let dir: string;
  const port = 20000 + Math.floor(Math.random() * 20000);

  beforeAll(async () => {
    // Répertoire marqué « recette » (donc accepté) mais dont la base `wnext` contient déjà les données d'un autre compte.
    dir = join(base, "marque");
    mkdirSync(dir);
    writeMarker(dir, "recette");
    server = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: true, onLog: () => {}, onError: () => {} });
    await server.initialise();
    await server.start();
    await server.createDatabase("wnext");
    const c = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/wnext` });
    await c.connect();
    await c.query("CREATE TABLE accounts (id bigint PRIMARY KEY, name text); INSERT INTO accounts VALUES (1, 'Données d''Alec')");
    await c.end();
    await server.stop();
  }, 120_000);

  it("refuse sans rien écrire : ni migration, ni extension, ni donnée", async () => {
    const r = spawnSync(process.execPath, [stackScript, "--seed=recette"], {
      env: { ...process.env, WNEXT_DEV_PG_DIR: dir, WNEXT_DEV_PG_PORT: String(port), WNEXT_DEV_API_PORT: String(port + 1) }, encoding: "utf8", timeout: 90_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/n'appartient pas|autres? comptes?/);
    expect(r.stderr).not.toMatch(/Unhandled|terminating connection/);
    expect(r.stdout).not.toMatch(/migration/);
    await server.start();
    const c = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/wnext` });
    await c.connect();
    try {
      expect((await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'wnext_migrations'")).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('btree_gist', 'citext')")).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n).toBe(1);
      expect((await c.query("SELECT id::text, name FROM accounts")).rows).toEqual([{ id: "1", name: "Données d'Alec" }]);
    } finally {
      await c.end();
      await server.stop();
    }
  }, 180_000);
});
