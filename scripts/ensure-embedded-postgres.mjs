#!/usr/bin/env node
// Postgres embarqué (embedded-postgres) : le paquet binaire @embedded-postgres/<plateforme> livre ses bibliothèques sans les
// liens de version (libicuuc.so.60 -> libicuuc.so.60.2) et les recrée dans son postinstall. Si ce postinstall n'a pas tourné,
// `postgres` ne se charge pas (« libicui18n.so.60: cannot open shared object file ») et dev:stack attend sans rien afficher.
// Lancé en postinstall du dépôt (`npm ci`) et par dev:stack avant le démarrage : recrée les liens manquants puis vérifie
// `postgres --version`. N'échoue jamais l'installation : affiche un avertissement.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Recrée les liens décrits par native/pg-symlinks.json qui manquent ; renvoie le nombre de liens créés. */
export function repairSymlinks(pkgDir) {
  const file = join(pkgDir, "native", "pg-symlinks.json");
  if (!existsSync(file)) return 0;
  let created = 0;
  for (const { source, target } of JSON.parse(readFileSync(file, "utf8"))) {
    const linkPath = resolve(pkgDir, target);
    if (lstatSync(linkPath, { throwIfNoEntry: false })) continue;
    symlinkSync(relative(dirname(linkPath), resolve(pkgDir, source)), linkPath);
    created++;
  }
  return created;
}

/** Répare le paquet de la plateforme courante et vérifie que `postgres` se lance. */
export async function ensureEmbeddedPostgres() {
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  let postgres;
  try {
    ({ postgres } = await import(pkg));
  } catch {
    return { ok: false, message: `${pkg} absent : relancer \`npm ci\` (plateforme non prise en charge par embedded-postgres ?)` };
  }
  const repaired = process.platform === "win32" ? 0 : repairSymlinks(resolve(dirname(postgres), "..", ".."));
  try {
    const version = execFileSync(postgres, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { ok: true, repaired, message: version };
  } catch (err) {
    const detail = (err.stderr?.toString() || err.message).trim();
    return { ok: false, repaired, message: `${postgres} ne se lance pas : ${detail}` };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const res = await ensureEmbeddedPostgres();
  if (res.repaired) console.log(`Postgres embarqué : ${res.repaired} lien(s) de bibliothèque recréé(s)`);
  if (!res.ok) console.warn(`Postgres embarqué : ${res.message}`);
}
