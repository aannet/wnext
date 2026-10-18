import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktreeManager } from "../../src/core/worktree-git";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

let root: string, repo: string, work: string, mgr: GitWorktreeManager;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "wt-"));
  repo = path.join(root, "repo"); work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "init");
  mgr = new GitWorktreeManager({ repoDir: repo, workRoot: work, baseRef: "main" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("GitWorktreeManager (dépôt git temporaire)", () => {
  it("crée /work/<run>/<line>/<agent> sur la branche de ligne, sans toucher main", async () => {
    const mainBefore = git(repo, "rev-parse", "main");
    const wt = await mgr.create({ run_id: "R1", line: "P0-001", agent: "implementeur", branch: "line/P0-001" });
    expect(wt.path).toBe(path.join(work, "R1", "P0-001", "implementeur"));
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("line/P0-001");
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
  });
  it("un second agent écrivant de la même ligne reçoit sa propre branche dérivée", async () => {
    const a = await mgr.create({ run_id: "R1", line: "P0-001", agent: "testeur", branch: "line/P0-001" });
    const b = await mgr.create({ run_id: "R1", line: "P0-001", agent: "implementeur", branch: "line/P0-001" });
    expect(a.branch).toBe("line/P0-001");
    expect(b.branch).toBe("line/P0-001.implementeur");
    expect(git(b.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("line/P0-001.implementeur");
  });
  it("refuse main/master/trunk et toute branche hors line/", async () => {
    for (const branch of ["main", "master", "trunk", "feature/x"]) {
      await expect(mgr.create({ run_id: "R1", line: "P0-001", agent: "implementeur", branch })).rejects.toThrow(/branche/);
    }
  });
  it("refuse les segments de chemin dangereux", async () => {
    await expect(mgr.create({ run_id: "../x", line: "P0-001", agent: "implementeur", branch: "line/P0-001" })).rejects.toThrow(/invalide/);
  });
  it("snapshot : réf dédiée contenant l'état non commité, branche et index intacts", async () => {
    const wt = await mgr.create({ run_id: "R1", line: "P0-001", agent: "implementeur", branch: "line/P0-001" });
    const tip = git(wt.path, "rev-parse", "HEAD");
    writeFileSync(path.join(wt.path, "new.ts"), "export const x = 1;\n");
    writeFileSync(path.join(wt.path, "README.md"), "changed\n");
    const ref = await mgr.snapshot(wt, "interrupt 1");
    expect(ref).toMatch(/^refs\/factory\/snapshots\/R1\/P0-001\/implementeur\/interrupt-1/);
    expect(git(repo, "show", `${ref}:new.ts`)).toContain("export const x");
    expect(git(repo, "show", `${ref}:README.md`)).toBe("changed");
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(wt.path, "status", "--porcelain")).toContain("?? new.ts");
    expect(git(repo, "rev-parse", "main")).not.toBe(git(repo, "rev-parse", ref));
  });
  it("remove keep:true conserve le dossier ; sinon le supprime", async () => {
    const wt = await mgr.create({ run_id: "R1", line: "P0-001", agent: "implementeur", branch: "line/P0-001" });
    await mgr.remove(wt, { keep: true });
    expect(existsSync(wt.path)).toBe(true);
    await mgr.remove(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", "line/P0-001")).toContain("line/P0-001");
  });
});
