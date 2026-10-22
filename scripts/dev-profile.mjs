// Profils de données de la pile locale (dev-stack.mjs) : `dev` (.dev-pg/, données d'Alec), `recette` (.dev-pg-recette/) et `vide`
// (.dev-pg-vide/). Garde-fous communs, tous exécutés AVANT toute suppression, démarrage ou écriture :
//  * checkDataDir : le répertoire de données (WNEXT_DEV_PG_DIR ou le défaut du profil) est résolu en chemin réel (liens symboliques,
//    `..`, barre finale) ; recette et vide n'acceptent qu'un répertoire absent, vide, ou portant le marqueur de LEUR profil, et
//    jamais un chemin qui recouvre .dev-pg/ ; aucun profil n'accepte le dépôt ou un de ses ancêtres.
//  * Marqueur `.wnext-profile` (écrit à la création du répertoire par recette et vide) : un répertoire sans marqueur n'est pas dédié.
//  * inspectDb : la base n'appartient au profil que si ses comptes, utilisateurs et membres sont exactement ceux attendus.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MARKER = ".wnext-profile";
export const PROFILE_DIRS = { dev: ".dev-pg", recette: ".dev-pg-recette", vide: ".dev-pg-vide" };

export class ProfileError extends Error {}

/** Chemin réel, même si la fin du chemin n'existe pas encore ; un lien symbolique pendant est refusé. */
function realPath(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      try {
        lstatSync(cur);
        throw new ProfileError(`${p} traverse un lien symbolique pendant (${cur})`);
      } catch (inner) {
        if (inner instanceof ProfileError) throw inner;
      }
      const parent = dirname(cur);
      if (parent === cur) return cur;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** `inner` est `outer` ou se trouve dessous. */
const inside = (outer, inner) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const readMarker = (dir) => {
  try {
    return readFileSync(join(dir, MARKER), "utf8").trim();
  } catch {
    return null;
  }
};

/** Valide le répertoire de données du profil, sans rien écrire. Retourne { pgDir (chemin réel), markerMissing }. */
export function checkDataDir({ root, profile, env = process.env }) {
  if (!(profile in PROFILE_DIRS)) throw new ProfileError(`profil « ${profile} » inconnu (dev, recette ou vide)`);
  const requested = env.WNEXT_DEV_PG_DIR ?? join(root, PROFILE_DIRS[profile]);
  const pgDir = realPath(requested);
  const rootReal = realPath(root);
  if (inside(pgDir, rootReal)) throw new ProfileError(`${requested} contient le dépôt : refusé`);
  if (existsSync(pgDir) && !statSync(pgDir).isDirectory()) throw new ProfileError(`${requested} n'est pas un répertoire`);

  const marker = readMarker(pgDir);
  if (marker !== null && marker !== profile) throw new ProfileError(`${requested} appartient au profil « ${marker} », pas à « ${profile} »`);
  if (marker === null && existsSync(join(pgDir, MARKER))) throw new ProfileError(`marqueur illisible dans ${requested}`);
  if (profile === "dev") return { pgDir, markerMissing: false };

  const dev = realPath(join(root, PROFILE_DIRS.dev));
  if (inside(dev, pgDir) || inside(pgDir, dev)) throw new ProfileError(`${requested} chevauche ${PROFILE_DIRS.dev}/ (données de développement) : refusé pour le profil « ${profile} »`);
  if (marker === null && existsSync(pgDir) && readdirSync(pgDir).length > 0) {
    throw new ProfileError(`${requested} n'est pas dédié au profil « ${profile} » (non vide et sans marqueur ${MARKER}) : refusé, rien n'a été touché`);
  }
  const data = join(pgDir, "data");
  if (marker !== null && existsSync(data) && !inside(pgDir, realPath(data))) throw new ProfileError(`${requested}/data sort du répertoire du profil (lien symbolique) : refusé`);
  return { pgDir, markerMissing: marker === null };
}

/** Crée le répertoire et pose le marqueur du profil (à appeler après checkDataDir, jamais sur un répertoire existant d'un autre profil). */
export function writeMarker(pgDir, profile) {
  mkdirSync(pgDir, { recursive: true });
  writeFileSync(join(pgDir, MARKER), `${profile}\n`, { flag: "wx" });
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Lecture seule : la base appartient-elle au profil ? `spec` = { accounts: [[id, nom]], users: [{ id, email, subject, role, accountId }] }.
 * 'fresh' (aucune table), 'empty' (tables sans compte), 'seeded' (exactement les comptes attendus) ; sinon ProfileError.
 * Les utilisateurs et membres présents doivent être des identités attendues (id et e-mail identiques, sujet identique ou absent).
 */
export async function inspectDb(client, spec, label) {
  const refuse = (why) => new ProfileError(`la base n'appartient pas au profil « ${label} » (${why}) : refusé, rien n'a été écrit`);
  const reg = await client.query("SELECT to_regclass('public.accounts')::text AS a, to_regclass('public.users')::text AS u, to_regclass('public.account_members')::text AS m");
  const { a, u, m } = reg.rows[0];
  if (!a) {
    const tables = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    if (tables.rows[0].n > 0) throw refuse("tables inconnues sans table accounts");
    return "fresh";
  }
  const accounts = (await client.query("SELECT id::text AS id, name FROM accounts ORDER BY id")).rows;
  const expected = spec.accounts.map(([id, name]) => `${id}:${name}`);
  const found = accounts.map((r) => `${r.id}:${r.name}`);
  if (accounts.length > 0 && (found.length !== expected.length || found.some((x, i) => x !== expected[i]))) {
    throw refuse(`comptes ${JSON.stringify(found)} au lieu de ${JSON.stringify(expected)} : autres comptes présents ou compte imité`);
  }
  if (u) {
    for (const row of (await client.query("SELECT id::text AS id, email::text AS email, idp_subject FROM users ORDER BY id")).rows) {
      const want = spec.users.find((x) => x.id === row.id);
      if (!want || !same(want.email, row.email) || (row.idp_subject !== null && row.idp_subject !== want.subject)) {
        throw refuse(`identité inattendue : utilisateur ${row.id} ${row.email}`);
      }
    }
  }
  if (m) {
    for (const row of (await client.query("SELECT account_id::text AS account_id, user_id::text AS user_id, role::text AS role FROM account_members")).rows) {
      const want = spec.users.find((x) => x.id === row.user_id);
      if (!want || want.accountId !== row.account_id || want.role !== row.role) throw refuse(`membre inattendu : utilisateur ${row.user_id} du compte ${row.account_id}`);
    }
  }
  return accounts.length === 0 ? "empty" : "seeded";
}
