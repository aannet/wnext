import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { lintBoundaries } from "../../scripts/lint-boundaries.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixture = (name: string) => join(here, "fixtures", name);

interface Violation {
  file: string;
  specifier: string;
  rule: string;
}
const run = (root: string): Violation[] => lintBoundaries({ root });
const rules = (name: string) => run(fixture(name)).map((v) => v.rule);

describe("lint de frontieres : le repo reel", () => {
  it("passe sur le repo actuel", () => {
    expect(run(repoRoot)).toEqual([]);
  });
  it("la fixture valide passe (imports autorises)", () => {
    expect(run(fixture("ok"))).toEqual([]);
  });
});

describe("chaque regle echoue sur un import interdit", () => {
  it("web -> api interdit", () => {
    expect(rules("web-imports-api")).toEqual(["app-isolation"]);
  });
  it("api -> web interdit", () => {
    expect(rules("api-imports-web")).toEqual(["app-isolation"]);
  });
  it("web -> api par chemin relatif interdit (et sortie du paquet)", () => {
    expect(rules("web-relative-api")).toContain("no-package-escape");
  });
  it("import par chemin nu apps/... interdit", () => {
    expect(rules("app-bare-path")).toEqual(["app-isolation"]);
  });
  it("contracts -> engine interdit", () => {
    expect(rules("contracts-imports-engine")).toEqual(["contracts-no-monorepo"]);
  });
  it("contracts : seule dependance externe zod", () => {
    expect(rules("contracts-external")).toEqual(["contracts-only-zod"]);
  });
  it("engine -> api interdit", () => {
    expect(rules("engine-imports-api")).toEqual(["engine-only-contracts"]);
  });
  it("engine -> web interdit meme en import() dynamique", () => {
    expect(rules("engine-imports-web-dynamic")).toEqual(["engine-only-contracts"]);
  });
  it("import profond @wnext/engine/src/... interdit", () => {
    expect(rules("deep-import")).toEqual(["no-deep-import"]);
  });
  it("import relatif qui sort du paquet interdit", () => {
    expect(rules("escape-package")).toEqual(["no-package-escape"]);
  });
  it("require() qui sort du paquet interdit", () => {
    expect(rules("escape-via-require")).toContain("no-package-escape");
  });
  it("import('...') en position de type qui sort du paquet interdit", () => {
    expect(rules("escape-type-import")).toContain("no-package-escape");
  });
  it("les violations indiquent fichier et specifier", () => {
    const [v] = run(fixture("web-imports-api"));
    expect(v?.file).toBe("apps/web/src/index.ts");
    expect(v?.specifier).toBe("@wnext/api");
  });
});

describe("CLI", () => {
  const cli = (root: string) =>
    spawnSync(process.execPath, [join(repoRoot, "scripts/lint-boundaries.mjs"), "--root", root], {
      encoding: "utf8",
    });
  it("code 0 sur le repo reel", () => {
    expect(cli(repoRoot).status).toBe(0);
  });
  it("code 1 et message sur une violation", () => {
    const r = cli(fixture("web-imports-api"));
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("app-isolation");
  });
});
