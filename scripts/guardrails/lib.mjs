// Utilitaires communs aux garde-fous (git, arguments CLI, point d'entree).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Base par defaut : origin/main, sinon main. Le diff est pris depuis le merge-base avec HEAD
// (ce que la PR apporte), pas depuis la pointe actuelle de la base.
export function resolveBase(cwd, base) {
  const ref = base ?? ["origin/main", "main"].find((r) => refExists(cwd, r));
  if (!ref || !refExists(cwd, ref)) throw new Error(`base git introuvable : ${base ?? "origin/main | main"}`);
  try {
    return git(cwd, ["merge-base", ref, "HEAD"]).trim();
  } catch {
    return ref;
  }
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return out;
}

export const isMain = (metaUrl) => !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === metaUrl;

// Convertit un glob (`**`, `*`) en RegExp ancree sur le chemin relatif complet.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
