import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Files = Record<string, string | null>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

export function writeFiles(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    if (content === null) {
      rmSync(p, { force: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

// Depot jetable : commit initial `base` sur main, puis un commit `change` sur la branche feature.
// Le vrai depot n'est jamais touche.
export function makeRepo(base: Files, change: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "wnext-guardrails-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFiles(dir, base);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFiles(dir, change);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "change");
  return dir;
}

export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

export function tmpDir(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "wnext-guardrails-"));
  writeFiles(dir, files);
  return dir;
}
