// Jeu d'essai de développement (npm run dev:stack) : ids fixes, idempotent (rien si le compte 1 « WNEXT Dev » existe déjà).
//  * 1 compte (semaine du lundi, Europe/Paris), 1 admin et 1 membre (sujets OIDC, DEV_USERS), 50 personnes sur 3 départements, 6 projets dont 1 tentative,
//    ~300 allocations sur -3/+3 mois (heures et pourcentage), une série hebdomadaire, un congé d'une demi-journée, un férié.
//  * Les dates sont relatives au lundi de la semaine du semis (l'écran s'ouvre sur « aujourd'hui »), les ids sont stables.
// Exécuté en superutilisateur (la RLS ne s'applique pas) : ne sert qu'à amorcer une base de développement.
export const DEV_IDS = { accountId: "1", userId: "1", role: "admin" };

// Utilisateurs de connexion du compte 1 et leur sujet OIDC (`users.idp_subject`) : le fournisseur local
// (scripts/dev-idp.mjs) émet des jetons dont `sub` vaut `subject`. Le premier est l'identité de DEV_IDS.
export const DEV_USERS = [
  { id: "1", subject: "dev-admin", email: "admin@wnext.test", name: "Admin Dev", role: "admin" },
  { id: "2", subject: "dev-member", email: "membre@wnext.test", name: "Membre Dev", role: "member" },
  // Compte de recette d'Alec (owner, sans personne liée) : se connecte via le fournisseur local, « Bonjour Alec » (lot L-B).
  { id: "3", subject: "dev-alec", email: "alec@wnext.test", name: "Alec", role: "owner" },
];

// Identités OIDC : jouées à chaque démarrage (y compris sur une base semée avant l'OIDC), sans effet si tout est en place.
// L'id fixe la ligne ; le sujet n'est posé que s'il manque (jamais écrasé).
export const IDENTITIES_SQL = DEV_USERS.map((u) => `
INSERT INTO users (id, email, name, locale, idp_subject) OVERRIDING SYSTEM VALUE
  VALUES (${u.id}, '${u.email}', '${u.name}', 'fr', '${u.subject}') ON CONFLICT (id) DO NOTHING;
UPDATE users SET idp_subject = '${u.subject}' WHERE id = ${u.id} AND idp_subject IS NULL;
INSERT INTO account_members (account_id, user_id, role) VALUES (1, ${u.id}, '${u.role}') ON CONFLICT DO NOTHING;`).join("\n") + `
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));
`;

const MONDAY = "(current_date - (extract(isodow FROM current_date)::int - 1))";

export const SEED_SQL = `
INSERT INTO users (id, email, name, locale) OVERRIDING SYSTEM VALUE VALUES (1, 'admin@wnext.test', 'Admin Dev', 'fr');
INSERT INTO accounts (id, name, timezone, currency_code, default_locale, week_start)
  OVERRIDING SYSTEM VALUE VALUES (1, 'WNEXT Dev', 'Europe/Paris', 'EUR', 'fr', 1);
INSERT INTO departments (id, account_id, name) OVERRIDING SYSTEM VALUE
  VALUES (1, 1, 'Design'), (2, 1, 'Développement'), (3, 1, 'Produit');
INSERT INTO people (id, account_id, department_id, name, email, country, work_days_hours) OVERRIDING SYSTEM VALUE
  SELECT i, 1, (i % 3) + 1, 'Personne ' || lpad(i::text, 2, '0'), 'personne' || i || '@wnext.test', 'FR',
         CASE WHEN i % 7 = 0 THEN '{8,8,8,0,0,0,0}'::numeric[] ELSE '{8,8,8,8,8,0,0}'::numeric[] END
  FROM generate_series(1, 50) i;
INSERT INTO account_members (account_id, user_id, role) VALUES (1, 1, 'admin');
INSERT INTO projects (id, account_id, name, project_code, color, status) OVERRIDING SYSTEM VALUE VALUES
  (1, 1, 'Refonte du site', 'DEV-001', '#3B82F6', 'in_progress'),
  (2, 1, 'Application mobile', 'DEV-002', '#10B981', 'in_progress'),
  (3, 1, 'Identité de marque', 'DEV-003', '#F59E0B', 'in_progress'),
  (4, 1, 'Migration cloud', 'DEV-004', '#8B5CF6', 'planned'),
  (5, 1, 'Portail client', 'DEV-005', '#EF4444', 'in_progress'),
  (6, 1, 'Appel d''offres (tentatif)', 'DEV-006', '#6B7280', 'tentative');
-- 6 blocs par personne, décalés selon la personne ; heures (pairs) ou pourcentage (impairs).
INSERT INTO allocations (id, account_id, person_id, project_id, start_date, end_date, mode, hours_per_day, percent, status)
  OVERRIDING SYSTEM VALUE
  SELECT (p - 1) * 6 + k + 1, 1, p, ((p + k) % 6) + 1,
         d.start_date, d.start_date + (4 + (p * k) % 12),
         CASE WHEN p % 2 = 0 THEN 'hours'::allocation_mode ELSE 'percentage'::allocation_mode END,
         CASE WHEN p % 2 = 0 THEN 2 + (p + k) % 7 END,
         CASE WHEN p % 2 = 1 THEN 25 + 25 * ((p + k) % 4) END,
         CASE WHEN (p + k) % 11 = 0 THEN 'tentative'::allocation_status ELSE 'confirmed'::allocation_status END
  FROM generate_series(1, 50) p, generate_series(0, 5) k,
       LATERAL (SELECT ${MONDAY} - 90 + k * 30 + (p % 5) AS start_date) d;
-- Série répétée chaque semaine : personne 1, projet 1, le lundi 4 h, sur 12 semaines.
INSERT INTO allocations (id, account_id, person_id, project_id, name, start_date, end_date, mode, hours_per_day, repeat_state, repeat_end_date)
  OVERRIDING SYSTEM VALUE
  VALUES (1000, 1, 1, 1, 'Point hebdo', ${MONDAY}, ${MONDAY}, 'hours', 4, 'weekly', ${MONDAY} + 77);
INSERT INTO timeoff_types (id, account_id, name) OVERRIDING SYSTEM VALUE VALUES (1, 1, 'Vacances');
-- Congé d'une demi-journée (matin) : jeudi de la semaine courante, personne 2.
INSERT INTO timeoffs (id, account_id, person_id, timeoff_type_id, start_date, end_date, start_half, end_half, approval_status)
  OVERRIDING SYSTEM VALUE
  VALUES (1, 1, 2, 1, ${MONDAY} + 3, ${MONDAY} + 3, 'am', 'am', 'approved');
-- Férié (France) : mercredi de la semaine suivante.
INSERT INTO holidays (id, account_id, name, hdate, country) OVERRIDING SYSTEM VALUE
  VALUES (1, 1, 'Jour férié de test', ${MONDAY} + 9, 'FR');
`;

// Les identités sont posées à la main : avancer les séquences au-delà des ids fixes.
const SEQUENCED = ["users", "accounts", "departments", "people", "projects", "allocations", "timeoff_types", "timeoffs", "holidays"];

/** Sème le jeu d'essai si le compte 1 « WNEXT Dev » n'existe pas (true si semé) ; complète les identités OIDC dans tous les cas. */
export async function seedDev(client) {
  const found = await client.query("SELECT 1 FROM accounts WHERE id = 1 AND name = 'WNEXT Dev'");
  if (found.rowCount > 0) {
    await client.query(IDENTITIES_SQL);
    return false;
  }
  const other = await client.query("SELECT count(*)::int AS n FROM accounts");
  if (other.rows[0].n > 0) throw new Error("la base contient déjà des comptes : relancer avec --reset");
  await client.query("BEGIN");
  try {
    await client.query(SEED_SQL);
    for (const t of SEQUENCED) await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT max(id) FROM ${t}))`);
    await client.query(IDENTITIES_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return true;
}
