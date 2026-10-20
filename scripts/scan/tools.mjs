// Outils de sécurité à binaires épinglés : téléchargés dans .tools/ (ignoré par le dépôt), somme SHA-256 vérifiée.
// Pour monter une version : changer url + sha256 (somme publiée par l'éditeur de la release), jamais l'un sans l'autre.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const toolsDir = join(root, ".tools");
const REL = "https://github.com";

export const TOOLS = {
  gitleaks: {
    version: "8.30.1",
    url: `${REL}/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz`,
    sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    archive: true,
  },
  "osv-scanner": {
    version: "2.7.0",
    url: `${REL}/google/osv-scanner/releases/download/v2.7.0/osv-scanner_linux_amd64`,
    sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
    archive: false,
  },
};

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} : code ${r.status}`);
}

/** Retourne le chemin du binaire épinglé, en le téléchargeant (et vérifiant sa somme) au besoin. */
export async function ensureTool(name) {
  const t = TOOLS[name];
  const dir = join(toolsDir, `${name}-${t.version}`);
  const bin = join(dir, name);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const res = await fetch(t.url);
  if (!res.ok) throw new Error(`téléchargement de ${name} : HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== t.sha256) throw new Error(`${name} : somme SHA-256 inattendue (${got}, attendue ${t.sha256}) : binaire refusé`);
  if (t.archive) {
    const tgz = join(dir, "archive.tgz");
    writeFileSync(tgz, buf);
    run("tar", ["-xzf", tgz, "-C", dir, name]);
    rmSync(tgz);
  } else {
    writeFileSync(bin, buf);
  }
  chmodSync(bin, 0o755);
  return bin;
}

export const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
