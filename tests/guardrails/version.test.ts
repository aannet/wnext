// Numéro de version du produit : une seule source, le `version` du package.json racine (SemVer, 0.x jusqu'au gate de release du
// MVP T1, qui sera 1.0.0). Les workspaces et package-lock.json le recopient (`npm run version:set -- X.Y.Z`), CHANGELOG.md a une
// entrée pour lui. Le contrat OpenAPI garde sa propre version (contracts-tools/src/openapi.ts), indépendante du produit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p));
const root = json("package.json");
const WORKSPACES = ["packages/contracts", "packages/contracts-tools", "packages/engine", "apps/api", "apps/web"];

describe("version du produit", () => {
  it("est un SemVer dans le package.json racine", () => {
    expect(root.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(root.version).not.toBe("0.0.0");
  });

  it("est recopiée dans chaque workspace et dans package-lock.json", () => {
    const lock = json("package-lock.json");
    expect(lock.version).toBe(root.version);
    expect(lock.packages[""].version).toBe(root.version);
    for (const ws of WORKSPACES) {
      expect(json(`${ws}/package.json`).version, ws).toBe(root.version);
      expect(lock.packages[ws].version, `package-lock ${ws}`).toBe(root.version);
    }
  });

  it("a son entrée dans CHANGELOG.md", () => {
    expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## \\[${root.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
  });

  it("se change par npm run version:set", () => {
    expect(root.scripts["version:set"]).toBeDefined();
  });
});
