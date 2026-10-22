// Jeu de données de RECETTE (npm run dev:recette:seed, ou `dev:stack -- --seed=recette`) : réaliste, reproductible, idempotent.
// Il rend jouables les scénarios R-01..R-25 de docs/recette/scenarios.md (correspondance dans « Mode d'emploi », point 2).
//  * Compte 1 « WNEXT Recette » (semaine du lundi, Europe/Paris, EUR) : 4 équipes, 18 personnes (16 actives nommées + 1 placeholder
//    + 1 désactivée), dont un horaire du samedi (Karim), un temps partiel (Élodie), un horaire daté BR-19 (Thomas : 5 jours puis,
//    à partir du lundi S+3, 4 jours, via people_history) ; 3 clients, 7 projets (dont 1 tentatif), des tâches ; ~70 allocations
//    (heures et %, une série hebdomadaire, un groupe multi-personnes BR-26, sur- et sous-allocations, 1 allocation tentative),
//    congés (journée, demi-journée, en attente), un férié France, du temps loggé (R-20).
//  * Compte 2 « Autre Société » : une poignée de données, pour vérifier l'isolation (R-24).
//  * Dates relatives au lundi de la semaine du semis (S0 = ce lundi) ; ids fixes ; ne tourne que sur une base SANS autre compte
//    (jamais sur .dev-pg d'Alec : voir dev-stack.mjs, répertoire dédié .dev-pg-recette/). Exécuté en superutilisateur (RLS non appliquée).
export const RECETTE_IDS = { accountId: "1", userId: "1", role: "owner" };

// Comptes de connexion et leur sujet OIDC (`users.idp_subject`) : l'IdP local (scripts/dev-idp.mjs) les liste sur sa page de choix.
// `personId` : personne planifiée liée (account_members.person_id) ; `accountId` : compte d'appartenance.
export const RECETTE_USERS = [
  { id: "1", subject: "dev-alec", email: "alec@wnext.test", name: "Alec", role: "owner", accountId: "1", personId: null },
  { id: "2", subject: "recette-admin", email: "admin@wnext.test", name: "Admin Recette", role: "admin", accountId: "1", personId: null },
  { id: "3", subject: "recette-camille", email: "camille.roy@wnext.test", name: "Camille Roy", role: "member", accountId: "1", personId: "1" },
  { id: "4", subject: "recette-nadia", email: "nadia.benali@wnext.test", name: "Nadia Benali", role: "project_manager", accountId: "1", personId: "3" },
  { id: "5", subject: "recette-invite", email: "invite@wnext.test", name: "Invité Recette", role: "guest", accountId: "1", personId: null },
  { id: "6", subject: "recette-autre", email: "autre@wnext.test", name: "Admin Autre Société", role: "admin", accountId: "2", personId: null },
];

const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const MONDAY = "(current_date - (extract(isodow FROM current_date)::int - 1))";
const day = (n) => `(${MONDAY} + ${n})`;

export const IDENTITIES_SQL = RECETTE_USERS.map((u) => `
INSERT INTO users (id, email, name, locale, idp_subject) OVERRIDING SYSTEM VALUE
  VALUES (${u.id}, ${q(u.email)}, ${q(u.name)}, 'fr', ${q(u.subject)}) ON CONFLICT (id) DO NOTHING;
UPDATE users SET idp_subject = ${q(u.subject)} WHERE id = ${u.id} AND idp_subject IS NULL;`).join("") + `
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));
`;

const MEMBERS_SQL = RECETTE_USERS.map((u) => `
INSERT INTO account_members (account_id, user_id, role, person_id) VALUES (${u.accountId}, ${u.id}, '${u.role}', ${u.personId ?? "NULL"}) ON CONFLICT DO NOTHING;`).join("");

const DEPARTMENTS = [[1, "Design"], [2, "Développement"], [3, "Produit"], [4, "Opérations"]];
const ROLES = [[1, "Designer UX"], [2, "Directrice artistique"], [3, "Développeur"], [4, "Lead dev"], [5, "Cheffe de projet"], [6, "Product owner"], [7, "Ingénieur DevOps"]];
const WEEK = "{8,8,8,8,8,0,0}";
// id, nom, e-mail (null = placeholder), équipe, rôle, type, pays, horaire (index 0 = lundi), actif
const PEOPLE = [
  [1, "Camille Roy", "camille.roy@wnext.test", 1, 1, "employee", "FR", WEEK, true],
  [2, "Léo Martin", "leo.martin@wnext.test", 1, 1, "employee", "FR", WEEK, true],
  [3, "Nadia Benali", "nadia.benali@wnext.test", 3, 5, "employee", "FR", WEEK, true],
  [4, "Thomas Girard", "thomas.girard@wnext.test", 2, 4, "employee", "FR", WEEK, true], // horaire daté ci-dessous
  [5, "Julie Lambert", "julie.lambert@wnext.test", 2, 3, "employee", "FR", WEEK, true],
  [6, "Karim Haddad", "karim.haddad@wnext.test", 2, 3, "employee", "FR", "{8,8,8,8,8,4,0}", true], // travaille le samedi
  [7, "Élodie Fontaine", "elodie.fontaine@wnext.test", 3, 6, "employee", "FR", "{8,8,0,8,8,0,0}", true], // temps partiel (mercredi off)
  [8, "Maxime Rousseau", "maxime.rousseau@wnext.test", 2, 3, "contractor", "FR", WEEK, true],
  [9, "Sophie Lefèvre", "sophie.lefevre@wnext.test", 1, 2, "employee", "FR", WEEK, true],
  [10, "Antoine Mercier", "antoine.mercier@wnext.test", 2, 3, "employee", "FR", WEEK, true],
  [11, "Chloé Bernard", "chloe.bernard@wnext.test", 3, 6, "employee", "FR", WEEK, true],
  [12, "Hugo Petit", "hugo.petit@wnext.test", 4, 7, "employee", "FR", WEEK, true],
  [13, "Manon Durand", "manon.durand@wnext.test", 4, 7, "employee", "FR", WEEK, true],
  [14, "Sam Carter", "sam.carter@wnext.test", 2, 3, "employee", "US", WEEK, true],
  [15, "Yasmine Cherif", "yasmine.cherif@wnext.test", 2, 3, "employee", "FR", WEEK, true],
  [16, "Lucas Morel", "lucas.morel@wnext.test", 1, 1, "employee", "FR", WEEK, true],
  [17, "Développeur à recruter", null, 2, 3, "placeholder", "FR", WEEK, true],
  [18, "Pierre Vidal", "pierre.vidal@wnext.test", 4, 7, "employee", "FR", WEEK, false], // désactivé
];
const CLIENTS = [[1, "Acme", "ACME"], [2, "Banque Horizon", "HORIZON"], [3, "Maison Aurore", "AURORE"]];
// id, nom, code, client, couleur, statut, personne gérante (project_manager_id)
const PROJECTS = [
  [1, "Refonte", "REF-01", 1, "#2563EB", "in_progress", 3],
  [2, "Site vitrine", "SITE-01", 1, "#0D9488", "in_progress", 9],
  [3, "Application mobile", "MOB-01", 2, "#7C3AED", "in_progress", 4],
  [4, "Identité de marque", "BRAND-01", 3, "#DB2777", "in_progress", 9],
  [5, "Migration cloud", "CLOUD-01", null, "#D97706", "planned", 4],
  [6, "Appel d'offres Ministère", "AO-01", 2, "#6B7280", "tentative", 11],
  [7, "Support et maintenance", "MAINT-01", 1, "#16A34A", "in_progress", 5],
];
// id, projet, nom
const TASKS = [
  [1, 1, "Conception"], [2, 1, "Design UI"], [3, 1, "Développement front"], [4, 1, "Recette"],
  [5, 2, "Maquettes"], [6, 2, "Intégration"], [7, 2, "Contenu"],
  [8, 3, "Cadrage"], [9, 3, "iOS"], [10, 3, "Android"],
  [11, 4, "Direction artistique"], [12, 4, "Charte graphique"],
  [13, 5, "Audit"], [14, 5, "Migration"], [15, 7, "Support N2"], [16, 6, "Chiffrage"],
];
const GROUP = "6f1c2d3a-5b7e-4a90-8c11-2e4f6a8b0c1d";
const WEEKLY_END = 77;

// personne, projet, tâche, début, fin (décalages en jours depuis le lundi S0), mode h|p, valeur, statut, libellé, notes, groupe
const al = (person, project, task, start, end, mode, value, extra = {}) => ({ person, project, task, start, end, mode, value, status: "confirmed", ...extra });
const ALLOCATIONS = [
  // Camille (R-12 : bloc Refonte S+2 lun-mer ; R-15 : +5 h le mardi S+2 ; R-13 : libre lun-mar S+3)
  al(1, 1, 2, -14, -10, "p", 50), al(1, 4, 12, -7, -3, "h", 4), al(1, 2, 5, 0, 3, "h", 6),
  al(1, 1, 2, 14, 16, "h", 8, { name: "Maquettes écran d'accueil", notes: "Valider les variantes avec Nadia avant jeudi." }),
  al(1, 2, 5, 15, 15, "h", 5, { name: "Variantes de la home" }),
  al(1, 4, 12, 24, 25, "p", 50), al(1, 1, 3, 28, 32, "p", 25),
  // Léo : 12 allocations Refonte sur S-4..S-1 (R-20, avec 34 h loggées) ; libre le mardi S+2 (R-15)
  ...[-28, -21, -14, -7].flatMap((w, i) => [
    al(2, 1, 3, w, w, "h", 4), al(2, 1, 3, w + 1, w + 2, "h", i % 2 ? 6 : 4), al(2, 1, 4, w + 3, w + 4, "h", 4),
  ]),
  al(2, 3, 8, 0, 4, "p", 50), al(2, 2, 6, 21, 25, "h", 6),
  // Nadia : série hebdomadaire (lundi) ; groupe « Atelier de lancement » avec Thomas et Yasmine (S+2 mer-jeu)
  al(3, 1, 1, 0, 0, "h", 2, { name: "Point hebdo Refonte", repeat: WEEKLY_END }), al(3, 2, null, 14, 18, "p", 25),
  al(3, 3, 8, 16, 17, "h", 6, { name: "Atelier de lancement", group: GROUP }),
  // Thomas : sur-allocation S0 (10 h pour 8 h) ; 4 jours à partir de S+3 (horaire daté)
  al(4, 3, 9, 0, 4, "h", 6), al(4, 5, 13, 0, 4, "h", 4), al(4, 3, 9, 7, 11, "h", 8), al(4, 3, 9, 14, 15, "h", 2),
  al(4, 3, 8, 16, 17, "h", 6, { name: "Atelier de lancement", group: GROUP }), al(4, 5, 14, 21, 24, "h", 8),
  // Julie : R-04, 6 h puis 10 h par jour sur Refonte (75 % puis 125 %)
  al(5, 2, 6, -7, -3, "p", 75), al(5, 1, 3, 7, 11, "h", 6), al(5, 1, 3, 14, 18, "h", 10), al(5, 3, 10, 28, 32, "p", 100),
  // Karim : travaille le samedi (4 h)
  al(6, 7, 15, -14, -10, "p", 50), al(6, 3, 10, 0, 5, "h", 4), al(6, 3, 10, 7, 12, "h", 6),
  // Élodie : temps partiel, en pourcentage
  al(7, 2, null, 0, 4, "p", 50), al(7, 3, 8, 7, 11, "p", 60), al(7, 4, null, 14, 18, "p", 40),
  // Maxime : sous-allocation (2 jours de 4 h)
  al(8, 7, 15, 0, 1, "h", 4), al(8, 7, 15, 7, 8, "h", 4), al(8, 2, 6, 14, 15, "h", 2),
  // Sophie
  al(9, 4, 11, -14, -10, "p", 60), al(9, 4, 11, 0, 4, "p", 60), al(9, 2, 5, 7, 11, "p", 40), al(9, 6, 16, 14, 18, "h", 2), al(9, 4, 12, 21, 25, "p", 50),
  // Antoine : R-18, trois allocations du lundi au mercredi S+3
  al(10, 1, 3, 21, 21, "h", 4), al(10, 2, 6, 22, 22, "h", 4), al(10, 3, 9, 23, 23, "h", 4),
  al(10, 5, 14, 0, 4, "h", 6), al(10, 5, 14, 7, 11, "h", 6), al(10, 7, 15, 28, 32, "p", 50),
  // Chloé : projet tentatif et allocation tentative sur un projet confirmé
  al(11, 3, 8, 0, 4, "p", 50), al(11, 6, 16, 7, 11, "h", 3), al(11, 2, null, 14, 16, "h", 4, { status: "tentative" }),
  // Hugo : sous-allocation (4 h par jour)
  al(12, 5, 13, 0, 4, "h", 4), al(12, 5, 14, 7, 11, "h", 4), al(12, 7, 15, 14, 18, "h", 4),
  al(13, 7, 15, 0, 4, "p", 50), al(13, 5, 13, 7, 11, "p", 50), al(13, 7, 15, 14, 18, "p", 50),
  // Sam (États-Unis, R-19)
  al(14, 3, 10, 0, 4, "h", 8), al(14, 3, 10, 7, 11, "h", 8), al(14, 1, 3, 14, 18, "p", 50), al(14, 2, 6, 21, 25, "h", 6),
  al(15, 3, 9, 0, 4, "p", 100), al(15, 3, 9, 7, 11, "p", 100), al(15, 3, 8, 16, 17, "h", 6, { name: "Atelier de lancement", group: GROUP }),
  // Lucas : libre toute la semaine S+2 et S+3 (R-10)
  al(16, 4, 12, -7, -3, "h", 6), al(16, 4, 12, 0, 4, "h", 6), al(16, 1, 2, 7, 11, "p", 50), al(16, 2, 5, 28, 32, "h", 6),
  al(17, 5, 14, 14, 18, "p", 100), al(17, 5, 14, 21, 25, "p", 100),
  al(18, 7, 15, -28, -24, "p", 50),
];

// personne, type, début, fin, début/fin de journée, statut
const TIMEOFFS = [
  [6, 1, 3, 3, "am", "am", "approved"], // demi-journée (matin) cette semaine, jeudi
  [11, 1, 8, 9, "am", "pm", "pending"], // en attente (hachuré)
  [12, 1, 21, 25, "am", "pm", "approved"],
  [13, 2, -3, -3, "am", "pm", "approved"],
  [8, 3, 21, 21, "pm", "pm", "approved"], // demi-journée (après-midi)
];
const TIMEOFF_TYPES = [[1, "Congés payés"], [2, "Maladie"], [3, "Formation"]];
// Temps loggé de Léo sur Refonte : 34 h (R-20)
const LOGGED = [[-28, 6], [-27, 6], [-26, 6], [-21, 6], [-20, 6], [-19, 4]];

const num = (v) => (v === null || v === undefined ? "NULL" : String(v));

function seedSql() {
  const alloc = ALLOCATIONS.map((a, i) => `(${i + 1}, 1, ${a.person}, ${a.project}, ${num(a.task)}, ${a.group ? q(a.group) : "NULL"}, ${a.name ? q(a.name) : "NULL"}, ${a.notes ? q(a.notes) : "NULL"},
    ${day(a.start)}, ${day(a.end)}, '${a.mode === "h" ? "hours" : "percentage"}', ${a.mode === "h" ? a.value : "NULL"}, ${a.mode === "p" ? a.value : "NULL"}, '${a.status}',
    '${a.repeat ? "weekly" : "none"}', ${a.repeat ? day(a.repeat) : "NULL"})`);
  return `
INSERT INTO accounts (id, name, timezone, currency_code, default_locale, week_start) OVERRIDING SYSTEM VALUE
  VALUES (1, 'WNEXT Recette', 'Europe/Paris', 'EUR', 'fr', 1), (2, 'Autre Société', 'Europe/Paris', 'EUR', 'fr', 1);
${IDENTITIES_SQL}
INSERT INTO departments (id, account_id, name) OVERRIDING SYSTEM VALUE VALUES ${DEPARTMENTS.map(([id, n]) => `(${id}, 1, ${q(n)})`).join(", ")}, (5, 2, 'Studio');
INSERT INTO roles (id, account_id, name) OVERRIDING SYSTEM VALUE VALUES ${ROLES.map(([id, n]) => `(${id}, 1, ${q(n)})`).join(", ")};
INSERT INTO people (id, account_id, department_id, role_id, name, email, people_type, country, work_days_hours, active) OVERRIDING SYSTEM VALUE VALUES
  ${PEOPLE.map(([id, n, e, d, r, t, c, h, a]) => `(${id}, 1, ${d}, ${r}, ${q(n)}, ${e ? q(e) : "NULL"}, '${t}', '${c}', '${h}', ${a})`).join(",\n  ")},
  (101, 2, 5, NULL, 'Agathe Collin', 'agathe.collin@autre.test', 'employee', 'FR', '${WEEK}', true),
  (102, 2, 5, NULL, 'Bruno Nguyen', 'bruno.nguyen@autre.test', 'employee', 'FR', '${WEEK}', true);
-- Horaire daté (BR-19) : lun-ven jusqu'à S+2, puis lun-jeu à partir du lundi S+3 (le trigger écrit people_history).
SELECT set_config('app.effective_from', (${day(21)})::text, true);
UPDATE people SET work_days_hours = '{8,8,8,8,0,0,0}' WHERE id = 4 AND account_id = 1;
SELECT set_config('app.effective_from', '', true);
${MEMBERS_SQL}
INSERT INTO clients (id, account_id, name, short_name) OVERRIDING SYSTEM VALUE VALUES ${CLIENTS.map(([id, n, s]) => `(${id}, 1, ${q(n)}, ${q(s)})`).join(", ")};
INSERT INTO projects (id, account_id, client_id, project_manager_id, name, project_code, color, status, start_date, end_date) OVERRIDING SYSTEM VALUE VALUES
  ${PROJECTS.map(([id, n, code, cl, col, st, pm]) => `(${id}, 1, ${num(cl)}, ${pm}, ${q(n)}, ${q(code)}, '${col}', '${st}', ${day(-28)}, ${day(90)})`).join(",\n  ")},
  (101, 2, NULL, NULL, 'Projet confidentiel', 'SEC-01', '#0891B2', 'in_progress', ${day(0)}, ${day(30)});
INSERT INTO project_tasks (id, account_id, project_id, name, position) OVERRIDING SYSTEM VALUE VALUES ${TASKS.map(([id, p, n], i) => `(${id}, 1, ${p}, ${q(n)}, ${i})`).join(", ")};
-- Chef de projet (utilisateur 4) : gère REF-01 et co-gère SITE-01 (RT-039).
INSERT INTO project_managers (project_id, account_id, user_id) VALUES (1, 1, 4), (2, 1, 4);
INSERT INTO allocations (id, account_id, person_id, project_id, project_task_id, group_id, name, notes, start_date, end_date, mode, hours_per_day, percent, status, repeat_state, repeat_end_date)
  OVERRIDING SYSTEM VALUE VALUES
  ${alloc.join(",\n  ")},
  (1000, 2, 101, 101, NULL, NULL, NULL, NULL, ${day(0)}, ${day(4)}, 'hours', 6, NULL, 'confirmed', 'none', NULL);
INSERT INTO project_team (project_id, person_id, account_id) SELECT DISTINCT project_id, person_id, account_id FROM allocations;
INSERT INTO timeoff_types (id, account_id, name) OVERRIDING SYSTEM VALUE VALUES ${TIMEOFF_TYPES.map(([id, n]) => `(${id}, 1, ${q(n)})`).join(", ")};
INSERT INTO timeoffs (id, account_id, person_id, timeoff_type_id, start_date, end_date, start_half, end_half, approval_status) OVERRIDING SYSTEM VALUE VALUES
  ${TIMEOFFS.map(([p, t, s, e, sh, eh, st], i) => `(${i + 1}, 1, ${p}, ${t}, ${day(s)}, ${day(e)}, '${sh}', '${eh}', '${st}')`).join(",\n  ")};
INSERT INTO holidays (id, account_id, name, hdate, country) OVERRIDING SYSTEM VALUE VALUES (1, 1, 'Férié de recette (France)', ${day(23)}, 'FR');
INSERT INTO logged_time (id, account_id, person_id, project_id, work_date, hours, status) OVERRIDING SYSTEM VALUE VALUES
  ${LOGGED.map(([d, h], i) => `(${i + 1}, 1, 2, 1, ${day(d)}, ${h}, 'draft')`).join(", ")};
-- Les triggers d'émission ont notifié les personnes liées pendant le semis : repartir d'une cloche vide (R-23).
DELETE FROM notifications;
`;
}

const SEQUENCED = ["accounts", "departments", "roles", "people", "clients", "projects", "project_tasks", "allocations", "timeoff_types", "timeoffs", "holidays", "logged_time"];

/** Sème le jeu de recette si le compte 1 « WNEXT Recette » n'existe pas (true si semé) ; complète les identités OIDC dans tous les cas. */
export async function seedRecette(client) {
  const found = await client.query("SELECT 1 FROM accounts WHERE id = 1 AND name = 'WNEXT Recette'");
  if (found.rowCount > 0) {
    await client.query(IDENTITIES_SQL);
    return false;
  }
  const other = await client.query("SELECT count(*)::int AS n FROM accounts");
  if (other.rows[0].n > 0) throw new Error("la base contient déjà d'autres comptes : le seed de recette ne s'applique qu'à une base vide (répertoire .dev-pg-recette/)");
  await client.query("BEGIN");
  try {
    await client.query(seedSql());
    for (const t of SEQUENCED) await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT max(id) FROM ${t}))`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return true;
}
