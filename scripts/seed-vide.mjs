// Compte VIDE (npm run dev:recette:vide, ou `dev:stack -- --seed=vide`) : le point de départ de R-06 (« compte vide, connecté en Owner »).
// Un seul compte « WNEXT Vide » (lundi, Europe/Paris, EUR) et l'identité d'Alec (owner, sans personne liée) : aucune personne, aucun projet,
// aucun client. Base dédiée .dev-pg-vide/ (marqueur de profil, voir dev-profile.mjs) : ni .dev-pg/ ni la recette ne sont touchés.
// Idempotent, mêmes garde-fous que le seed de recette (inspectDb avant toute écriture). Exécuté en superutilisateur.
import { inspectDb } from "./dev-profile.mjs";

export const VIDE_IDS = { accountId: "1", userId: "1", role: "owner" };
export const VIDE_USERS = [
  { id: "1", subject: "dev-alec", email: "alec@wnext.test", name: "Alec", role: "owner", accountId: "1", personId: null },
];
export const VIDE_SPEC = { accounts: [["1", "WNEXT Vide"]], users: VIDE_USERS };

const IDENTITIES_SQL = `
INSERT INTO users (id, email, name, locale, idp_subject) OVERRIDING SYSTEM VALUE
  VALUES (1, 'alec@wnext.test', 'Alec', 'fr', 'dev-alec') ON CONFLICT (id) DO NOTHING;
UPDATE users SET idp_subject = 'dev-alec' WHERE id = 1 AND idp_subject IS NULL;
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));
`;

const SEED_SQL = `
INSERT INTO accounts (id, name, timezone, currency_code, default_locale, week_start) OVERRIDING SYSTEM VALUE
  VALUES (1, 'WNEXT Vide', 'Europe/Paris', 'EUR', 'fr', 1);
${IDENTITIES_SQL}
INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'owner') ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('accounts', 'id'), (SELECT max(id) FROM accounts));
`;

/** Sème le compte vide (true si semé) ; sur une base déjà semée, complète l'identité d'Alec (false). Refuse toute autre base, sans écrire. */
export async function seedVide(client) {
  const state = await inspectDb(client, VIDE_SPEC, "vide");
  if (state === "fresh") throw new Error("base non migrée");
  if (state === "seeded") {
    await client.query(IDENTITIES_SQL);
    return false;
  }
  await client.query("BEGIN");
  try {
    await client.query(SEED_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return true;
}
