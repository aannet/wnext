import { z } from "zod";

// Import CSV simple (FR-01/FR-02, US-1.2, tranche T1) : personnes, projets ou clients depuis un fichier CSV.
//  POST /api/v1/imports/{kind}[?dryRun=true], corps `{ csv, skipInvalid? }`. Owner et admin seulement (403 avant le corps).
//
// Choix de conception :
//  * Le corps porte le TEXTE CSV, pas des lignes déjà analysées : le serveur ne fait jamais confiance à une analyse cliente,
//    les numéros de ligne du rapport sont ceux du fichier, et l'analyse (séparateur, guillemets, en-têtes FR/EN, validation)
//    est la même fonction pure de @wnext/engine des deux côtés (aperçu local de la démo, serveur).
//  * Fichier : RFC 4180 ; séparateur `,` ou `;` détecté sur la ligne d'en-tête ; guillemets doublés ; BOM UTF-8 et fins de ligne
//    CRLF/LF/CR acceptés. Ligne 1 = en-têtes ; une ligne entièrement vide est ignorée. Au plus IMPORT_MAX_ROWS lignes de données
//    (au-delà : 413 IMPORT_TOO_LARGE, params.maxRows et params.rows, rien n'est analysé plus loin) et IMPORT_MAX_CSV_CHARS
//    caractères (au-delà : 400 VALIDATION_FAILED, field = csv).
//  * En-têtes tolérants : casse, accents, espaces et ponctuation ignorés ; noms anglais ou français. Colonnes (nom canonique, * = requise) :
//      people   : name*, email*, type, department, role, country, hours_per_day, tags
//      projects : name*, project_code*, client, color, start_date, end_date, status, project_manager, billable, tags, notes
//      clients  : name*, short_name, tags
//    Colonne inconnue : ignorée et listée dans `ignoredColumns`. Valeurs : nombres à virgule ou point ; dates AAAA-MM-JJ ou JJ/MM/AAAA ;
//    booléens oui/non, yes/no, true/false, 1/0 ; types et statuts en anglais ou en français ; tags séparés par `|`, `,` ou `;`.
//  * Clé d'idempotence : e-mail (sans casse) pour une personne, project_code (exact) pour un projet, nom (sans casse, espaces
//    rognés) pour un client. Ligne dont la clé existe = mise à jour des SEULES cellules non vides (un import n'efface jamais une
//    valeur) ; identique à l'existant = inchangée (aucune écriture, la version ne bouge pas). Réimporter le même fichier ne crée
//    ni ne modifie rien. La même clé deux fois dans le fichier : la seconde ligne est en erreur (duplicate_in_file, params.firstLine).
//  * Références résolues par nom (sans casse) : département, rôle et client d'un projet absents sont CRÉÉS (listés dans
//    `references`) ; le chef de projet doit exister (e-mail ou nom d'une personne du compte) : sinon unknown_reference, plusieurs
//    personnes du même nom : ambiguous_reference. Un client existant en double (même nom) : ambiguous_reference (projet) ou
//    ambiguous_key (import de clients).
//  * dryRun=true : analyse et rapport (créées, mises à jour, inchangées, erreurs par ligne) sans AUCUNE écriture.
//    Sinon : une transaction. Si le rapport contient des erreurs et que `skipInvalid` n'est pas vrai : 422 IMPORT_HAS_ERRORS
//    (params.invalid, params.rows), rien n'est écrit. Avec `skipInvalid: true`, les lignes valides sont appliquées (toutes ou
//    aucune), les lignes en erreur sont ignorées et listées. Réimporter ensuite le fichier corrigé est sans risque (idempotent).
//  * Écritures ordinaires : audit (created_by, modified_by), journal temps réel (change_log) et historique daté des personnes
//    (BR-19 : une modification de département, rôle ou horaire prend effet aujourd'hui, fuseau du compte ; refusée par ligne,
//    history_locked, si des temps saisis non brouillons couvrent aujourd'hui ou après).
//  * L'e-mail d'une personne est écrit mais jamais renvoyé (comme la lecture des personnes) ; le rapport ne recopie que des
//    valeurs du fichier (`value`, tronquée à 200 caractères). Au plus IMPORT_MAX_ERRORS erreurs listées (`errorsTruncated`), les
//    compteurs restent exacts.

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_CSV_CHARS = 900_000;
export const IMPORT_MAX_ERRORS = 1000;

export const ImportKind = z.enum(["people", "projects", "clients"]).meta({ id: "ImportKind" });
export type ImportKind = z.infer<typeof ImportKind>;

export const ImportPathParams = z.object({ kind: ImportKind });
export const ImportQuery = z.object({
  dryRun: z.boolean().optional().describe("true : rapport seul, aucune écriture (défaut : false, l'import est appliqué)"),
});
export type ImportQuery = z.infer<typeof ImportQuery>;

export const ImportRequest = z
  .object({
    csv: z.string().min(1).max(IMPORT_MAX_CSV_CHARS).describe("Contenu du fichier CSV (ligne 1 = en-têtes)"),
    skipInvalid: z.boolean().optional().describe("Appliquer les lignes valides malgré des lignes en erreur (défaut : false = tout ou rien)"),
  })
  .meta({ id: "ImportRequest" });
export type ImportRequest = z.infer<typeof ImportRequest>;

// Codes d'erreur par ligne (stables ; le client les traduit).
//  Fichier (line = 1, column = en-tête) : empty_file, missing_column, duplicate_column. Enregistrement : unterminated_quote, field_count.
//  Cellule : required, too_long, invalid_email, invalid_number, invalid_enum, invalid_date, invalid_date_range, invalid_color,
//  invalid_country, invalid_boolean, too_many_tags. Clé et références : duplicate_in_file, ambiguous_key, unknown_reference,
//  ambiguous_reference, history_locked.
export const ImportRowErrorCode = z
  .enum([
    "empty_file", "missing_column", "duplicate_column", "unterminated_quote", "field_count",
    "required", "too_long", "invalid_email", "invalid_number", "invalid_enum", "invalid_date", "invalid_date_range", "invalid_color",
    "invalid_country", "invalid_boolean", "too_many_tags",
    "duplicate_in_file", "ambiguous_key", "unknown_reference", "ambiguous_reference", "history_locked",
  ])
  .meta({ id: "ImportRowErrorCode" });
export type ImportRowErrorCode = z.infer<typeof ImportRowErrorCode>;

export const ImportRowError = z
  .object({
    line: z.number().int().min(1).describe("Ligne physique du fichier où commence l'enregistrement (1 = en-têtes)"),
    column: z.string().nullable().describe("Nom canonique de la colonne (ex. email), null pour l'enregistrement entier"),
    code: ImportRowErrorCode,
    value: z.string().nullable().describe("Valeur lue dans le fichier (200 caractères au plus), null si sans objet"),
    params: z.record(z.string(), z.union([z.string(), z.number()])).describe("Précisions (ex. firstLine, max, min)"),
  })
  .meta({ id: "ImportRowError" });
export type ImportRowError = z.infer<typeof ImportRowError>;

const count = z.number().int().min(0);
export const ImportReport = z
  .object({
    kind: ImportKind,
    dryRun: z.boolean(),
    applied: z.boolean().describe("true si les écritures ont été faites (jamais en dryRun)"),
    delimiter: z.enum([",", ";"]),
    rows: count.describe("Lignes de données lues (hors en-têtes et lignes vides)"),
    created: count,
    updated: count,
    unchanged: count,
    invalid: count.describe("Lignes en erreur, jamais appliquées"),
    references: z
      .object({ departments: z.array(z.string()), roles: z.array(z.string()), clients: z.array(z.string()) })
      .describe("Noms des références créées (ou à créer en dryRun)"),
    ignoredColumns: z.array(z.string()).describe("En-têtes non reconnus, tels qu'écrits"),
    errors: z.array(ImportRowError).describe("Par ligne croissante"),
    errorsTruncated: z.boolean(),
  })
  .meta({ id: "ImportReport" });
export type ImportReport = z.infer<typeof ImportReport>;
