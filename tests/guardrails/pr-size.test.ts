import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { checkPrSize } from "../../scripts/guardrails/pr-size.mjs";
import { cleanup, makeRepo } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "scripts", "guardrails", "pr-size.mjs");
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
const repos: string[] = [];
afterEach(() => repos.splice(0).forEach(cleanup));
const mk = (change: Record<string, string | null>, base: Record<string, string | null> = { "README.md": "x\n" }) => {
  const d = makeRepo(base, change);
  repos.push(d);
  return d;
};

describe("pr-size", () => {
  it("echoue au-dessus de 400 lignes (ajouts)", () => {
    const r = checkPrSize({ cwd: mk({ "src/a.ts": lines(401) }), base: "main" });
    expect(r.ok).toBe(false);
    expect(r.total).toBe(401);
  });
  it("compte ajouts + suppressions", () => {
    const base = { "src/a.ts": lines(300) };
    const r = checkPrSize({ cwd: mk({ "src/a.ts": lines(300).replaceAll("line", "ligne") }, base), base: "main" });
    expect(r.total).toBe(600);
    expect(r.ok).toBe(false);
  });
  it("passe a exactement 400", () => {
    expect(checkPrSize({ cwd: mk({ "src/a.ts": lines(400) }), base: "main" }).ok).toBe(true);
  });
  it("ignore package-lock.json, fixtures et fichiers generes", () => {
    const r = checkPrSize({
      cwd: mk({
        "package-lock.json": lines(5000),
        "packages/x/package-lock.json": lines(500),
        "tests/boundaries/fixtures/a/f.ts": lines(500),
        "packages/contracts/openapi.generated.json": lines(500),
        "src/a.ts": lines(10),
      }),
      base: "main",
      generated: ["**/*.generated.*"],
    });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(10);
  });
  it("les generes sont comptes si non listes", () => {
    const r = checkPrSize({ cwd: mk({ "gen/out.ts": lines(500) }), base: "main", generated: [] });
    expect(r.ok).toBe(false);
  });
  it("seuil parametrable", () => {
    expect(checkPrSize({ cwd: mk({ "src/a.ts": lines(50) }), base: "main", max: 40 }).ok).toBe(false);
  });
  it("CLI : code 1 / 0", () => {
    const bad = mk({ "src/a.ts": lines(450) });
    const good = mk({ "src/a.ts": lines(5) });
    const cli = (cwd: string) => spawnSync("node", [script, "--root", cwd, "--base", "main"], { encoding: "utf8" });
    expect(cli(bad).status).toBe(1);
    expect(cli(good).status).toBe(0);
  });
});
