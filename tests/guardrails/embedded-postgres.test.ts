// Postgres embarqué : les liens des bibliothèques (libicu*.so.60 -> .so.60.2) sont recréés si le postinstall du paquet
// @embedded-postgres/<plateforme> n'a pas tourné ; sinon `postgres` ne se charge pas et dev:stack attend en silence.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairSymlinks } from "../../scripts/ensure-embedded-postgres.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakePackage() {
  const dir = mkdtempSync(join(tmpdir(), "wnext-epg-"));
  dirs.push(dir);
  mkdirSync(join(dir, "native", "lib"), { recursive: true });
  writeFileSync(join(dir, "native", "lib", "libicuuc.so.60.2"), "");
  writeFileSync(
    join(dir, "native", "pg-symlinks.json"),
    JSON.stringify([
      { source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so.60" },
      { source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so" },
    ]),
  );
  return dir;
}

describe("Postgres embarqué", () => {
  it("recrée les liens manquants, relatifs à leur dossier, et ne refait rien au second passage", () => {
    const dir = fakePackage();
    expect(repairSymlinks(dir)).toBe(2);
    const link = join(dir, "native", "lib", "libicuuc.so.60");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("libicuuc.so.60.2");
    expect(repairSymlinks(dir)).toBe(0);
  });

  it("ne fait rien sans pg-symlinks.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "wnext-epg-"));
    dirs.push(dir);
    expect(repairSymlinks(dir)).toBe(0);
  });

  it("est vérifié après chaque installation (postinstall)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.postinstall).toBe("node scripts/ensure-embedded-postgres.mjs");
  });
});
