/**
 * WorktreeManager réel, git simple (§4.2). Un worktree par ligne et par agent écrivant : `<workRoot>/<run_id>/<line>/<agent>`.
 * Jamais de commit sur main : les branches créées sont préfixées `line/`, les snapshots vont dans `refs/factory/snapshots/`
 * (commit orphelin de l'état courant via un index temporaire : ni la branche, ni l'index du worktree ne bougent).
 * Une même branche ne peut pas être extraite dans deux worktrees : le 2e agent écrivant d'une ligne reçoit `<branch>.<agent>`.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorktreeManager, WorktreeRef } from "../ports";
import type { Agent, LineId } from "../types";

const run = promisify(execFile);
const PROTECTED = new Set(["main", "master", "trunk"]);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface GitWorktreeOptions {
  repoDir: string;
  workRoot: string;
  /** Point de départ des branches de ligne (lecture seule). Défaut `main`. */
  baseRef?: string;
}

export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly o: GitWorktreeOptions) {}

  private async git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    const { stdout } = await run("git", ["-c", "user.name=factory", "-c", "user.email=factory@localhost", ...args], { cwd, env: { ...process.env, ...env } });
    return stdout.trim();
  }
  private async branchExists(b: string): Promise<boolean> {
    try { await this.git(this.o.repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]); return true; } catch { return false; }
  }
  private async checkedOut(b: string): Promise<boolean> {
    const out = await this.git(this.o.repoDir, ["worktree", "list", "--porcelain"]);
    return out.split("\n").includes(`branch refs/heads/${b}`);
  }

  async create(req: { run_id: string; line: LineId; agent: Agent; branch: string }): Promise<WorktreeRef> {
    for (const seg of [req.run_id, req.line, req.agent]) if (!SAFE.test(seg)) throw new Error(`segment de chemin invalide : ${seg}`);
    if (PROTECTED.has(req.branch) || !req.branch.startsWith("line/") || req.branch.includes("..")) throw new Error(`branche refusée (hors line/ ou protégée) : ${req.branch}`);
    const dir = path.join(this.o.workRoot, req.run_id, req.line, req.agent);
    mkdirSync(path.dirname(dir), { recursive: true });
    const base = this.o.baseRef ?? "main";
    let branch = req.branch;
    if (await this.checkedOut(branch)) branch = `${req.branch}.${req.agent}`;
    if (await this.branchExists(branch)) await this.git(this.o.repoDir, ["worktree", "add", dir, branch]);
    else await this.git(this.o.repoDir, ["worktree", "add", "-b", branch, dir, base]);
    return { path: dir, branch, line: req.line, agent: req.agent };
  }

  async snapshot(wt: WorktreeRef, label: string): Promise<string> {
    const gitDir = path.resolve(wt.path, await this.git(wt.path, ["rev-parse", "--absolute-git-dir"]));
    const idx = path.join(gitDir, "factory-snapshot.index");
    const env = { GIT_INDEX_FILE: idx };
    try {
      await this.git(wt.path, ["add", "-A"], env);
      const tree = await this.git(wt.path, ["write-tree"], env);
      const head = await this.git(wt.path, ["rev-parse", "HEAD"]);
      const commit = await this.git(wt.path, ["commit-tree", tree, "-p", head, "-m", `snapshot ${label}`]);
      const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snap";
      const ref = `refs/factory/snapshots/${path.basename(path.dirname(path.dirname(wt.path)))}/${wt.line}/${wt.agent}/${slug}`;
      // unicité : suffixe numérique si la réf existe déjà
      let final = ref, n = 1;
      while (await this.refExists(final)) final = `${ref}-${++n}`;
      await this.git(wt.path, ["update-ref", final, commit]);
      return final;
    } finally { rmSync(idx, { force: true }); }
  }
  private async refExists(r: string): Promise<boolean> {
    try { await this.git(this.o.repoDir, ["rev-parse", "--verify", "--quiet", r]); return true; } catch { return false; }
  }

  async remove(wt: WorktreeRef, opts: { keep?: boolean } = {}): Promise<void> {
    if (opts.keep) return;
    await this.git(this.o.repoDir, ["worktree", "remove", "--force", wt.path]);
  }
}
