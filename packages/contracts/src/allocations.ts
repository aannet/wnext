import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";
import { ReferenceListQuery } from "./reference";
import { SchedulePage, ScheduleAllocation } from "./schedule";

// Écriture des allocations (entité pivot du Schedule). Choix de conception :
//  * Verrou optimiste (ADR-003 §5) : PATCH et DELETE exigent `If-Match: "<version>"` (la `version` lue dans le Schedule).
//    Version périmée -> 409 VERSION_CONFLICT avec `currentVersion` ; en-tête absent -> 428 PRECONDITION_REQUIRED.
//    La création n'a pas de précondition ; la réponse porte la `version` à utiliser ensuite.
//  * BR-01 : la sur-allocation n'est JAMAIS une erreur ici. La réponse ne contient pas d'avertissement : le client la
//    déduit avec @wnext/engine à partir des mêmes données, comme pour la lecture.
//  * BR-37 : une allocation hors des dates de son projet ou de sa phase est ACCEPTÉE, sans avertissement dans la réponse
//    non plus (décision 9 du registre : l'API transporte les faits). Le client appelle allocationDateWarnings de
//    @wnext/engine avec les bornes du projet (ScheduleProject.startDate / endDate) et, si besoin, de la phase (GET des phases).
//  * BR-04 : écrire une allocation sur un jour de congé n'est pas refusé non plus ; l'avertissement vient du moteur.
//  * Le mode impose son champ via `load` (heures par jour OU pourcentage des heures brutes, plafond 500 %, BR-24).
//  * Défauts appliqués par le serveur quand le champ est omis : status "confirmed", billable true, priority 0, repeatState "none".
//  * Groupes (BR-26, allocation multi-personnes) : N lignes d'allocation (une par personne) liées par un `groupId` partagé.
//      - POST /allocation-groups : crée le groupe (2 à 50 membres, personnes distinctes) en UNE transaction, tout ou rien. Les champs
//        communs (projet, phase, tâche, nom, notes, dates, statut, facturable, priorité, répétition) sont dans le corps ; chaque membre
//        a SES heures : `members[i].load`, ou à défaut le `load` commun (un membre sans l'un ni l'autre : 400). Réponse 201 :
//        `{ groupId, items }`, `items` dans l'ORDRE des membres. Les droits sont ceux de l'écriture d'une allocation.
//      - Édition « celle-ci » : PATCH/DELETE /allocations/{id} comme aujourd'hui ; la ligne reste dans le groupe (même si ses dates
//        ou sa personne divergent ensuite).
//      - Édition « tous » : PATCH/DELETE /allocations/{id}/group. `If-Match` porte la version de la ligne désignée par l'URL ; toutes
//        les lignes du groupe sont verrouillées dans la même transaction, la précondition est contrôlée sur la ligne désignée seule, et
//        chaque ligne reçoit les modifications communes SUR SA PROPRE VALEUR ACTUELLE (une date non citée reste celle de la ligne).
//        Seuls les champs communs sont acceptables (`personId` et `load` propres à chaque ligne : 400 VALIDATION_FAILED, corps strict).
//        PATCH répond `{ groupId, items }` (toutes les lignes, par id) ; DELETE répond 204 (supprime toutes les lignes du groupe), ou,
//        avec `Prefer: return=representation` (RFC 7240), 200 `{ groupId, items }` : TOUTES les lignes supprimées, telles qu'avant la
//        suppression (liste exhaustive, lue sous le même verrou ; le client recrée chacune pour annuler, RT-047).
//        Allocation sans groupe : 404 NOT_FOUND (params.entity = allocation_group).
//      - Un congé n'affecte que la ligne de la personne concernée (BR-05) : rien à faire ici, les lignes sont indépendantes.
//  * Hors périmètre de ce contrat (à venir) : déplacement par lot, suppression en cascade d'équipe (BR-10, avec récapitulatif et
//    confirmation), sortie d'une ligne du groupe, relecture d'un groupe par son identifiant.
//  * Les écritures sont réservées aux rôles owner, admin et project_manager ; un autre rôle reçoit 403 FORBIDDEN.
//  * Lecture (tout membre authentifié, comme GET /schedule ; mêmes champs que ScheduleAllocation) :
//      - GET /allocations/{id} : une allocation avec sa `version` (relire après un VERSION_CONFLICT). Inconnue ou hors compte :
//        404 NOT_FOUND (params.entity = allocation). Pas de liste globale : une liste d'allocations se lit par fenêtre (GET /schedule,
//        GET /projects/{projectId}/allocations).
//      - GET /projects/{projectId}/allocations : les allocations d'un projet qui CHEVAUCHENT la fenêtre [from, to] (bornes incluses ;
//        `from` et `to` obligatoires, 400 jours au plus, sinon 400 SCHEDULE_RANGE_INVALID). Même règle de chevauchement que le
//        Schedule : une allocation répétée compte jusqu'à la fin de sa série (`repeatEndDate`) ; elle est renvoyée UNE fois (son
//        occurrence d'origine), pas développée en une ligne par répétition. Filtres : `personId`, `status` (tentative|confirmed).
//        Liste paginée par curseur sur `id` (tri par id, `page.total`, limit 1..500, défaut 200) : le client trie à l'affichage.
//        Projet inconnu ou hors compte : 404 NOT_FOUND (params.entity = project) ; un projet archivé se lit. Les personnes
//        désactivées gardent leurs allocations. Une personne ou un statut inconnu en filtre ne donne pas d'erreur de référence :
//        liste vide (sauf identifiant non numérique ou statut hors énumération : 400 VALIDATION_FAILED).
//      - GET /people/{id}/allocations : symétrique pour une personne (fiche personne). Mêmes règles (fenêtre obligatoire, chevauchement,
//        série renvoyée une fois, pagination sur `id`) ; filtres `projectId`, `status`. Personne inconnue ou hors compte : 404 NOT_FOUND
//        (params.entity = person) ; une personne désactivée se lit. Les allocations de projets archivés sont incluses.

export const AllocationLoad = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("hours"), hoursPerDay: z.number().gt(0).max(24) }),
    z.object({ mode: z.literal("percentage"), percent: z.number().gt(0).max(500) }),
  ])
  .meta({ id: "AllocationLoad" });

const fields = {
  projectId: Id,
  phaseId: orNull(Id).optional(),
  taskId: orNull(Id).optional(),
  name: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  startDate: IsoDate,
  endDate: IsoDate,
  status: z.enum(["tentative", "confirmed"]).optional(),
  billable: z.boolean().optional(),
  priority: z.number().int().min(-32768).max(32767).optional(),
  repeatState: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
  repeatEndDate: orNull(IsoDate).optional().describe("Obligatoire si repeatState <> none, absent ou null sinon"),
};

const body = z.object({ personId: Id, ...fields });

export const AllocationCreate = body
  .extend({ load: AllocationLoad })
  .refine((a) => a.endDate >= a.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .refine(
    (a) => (a.repeatState ?? "none") === "none" ? a.repeatEndDate == null : a.repeatEndDate != null && a.repeatEndDate >= a.endDate,
    { path: ["repeatEndDate"], message: "répétition incohérente" },
  )
  .meta({ id: "AllocationCreate" });
export type AllocationCreate = z.infer<typeof AllocationCreate>;

// Champs absents = inchangés. `personId` change = déplacement vers une autre ligne du Schedule.
// La cohérence avec l'état courant (dates, répétition) est contrôlée par le serveur ; ici seulement ce qui se voit dans le corps.
export const AllocationPatch = body
  .partial()
  .extend({ load: AllocationLoad.optional() })
  .refine((a) => Object.keys(a).length > 0, { message: "corps vide" })
  .refine((a) => !a.startDate || !a.endDate || a.endDate >= a.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .meta({ id: "AllocationPatch" });
export type AllocationPatch = z.infer<typeof AllocationPatch>;

export const AllocationPathParams = z.object({ id: Id });

// ETag fort : la version entre guillemets, ex. "3".
export const IfMatchHeader = z.object({
  "If-Match": z.string().regex(/^"\d+"$/).describe('Version lue dans le Schedule, entre guillemets : "3"'),
});

// DELETE /allocations/{id}/group : `Prefer: return=representation` demande les lignes supprimées (200) au lieu de 204 (RT-047).
export const GroupDeleteHeaders = IfMatchHeader.extend({
  Prefer: z.literal("return=representation").optional().describe("Facultatif : 200 avec les lignes supprimées (état d'avant) au lieu de 204"),
});

// --- Lecture ---
export const ProjectPathParams = z.object({ projectId: Id });
export const ProjectAllocationListQuery = ReferenceListQuery.extend({
  from: IsoDate.describe("Début de la fenêtre (inclus)"),
  to: IsoDate.describe("Fin de la fenêtre (incluse). 400 jours au plus, sinon SCHEDULE_RANGE_INVALID"),
  personId: Id.optional().describe("Seulement les allocations de cette personne"),
  status: z.enum(["tentative", "confirmed"]).optional().describe("Seulement les allocations de ce statut"),
});
export type ProjectAllocationListQuery = z.infer<typeof ProjectAllocationListQuery>;
export const ProjectAllocationList = z.object({ items: z.array(ScheduleAllocation), page: SchedulePage }).meta({ id: "ProjectAllocationList" });

export const PersonAllocationListQuery = ReferenceListQuery.extend({
  from: IsoDate.describe("Début de la fenêtre (inclus)"),
  to: IsoDate.describe("Fin de la fenêtre (incluse). 400 jours au plus, sinon SCHEDULE_RANGE_INVALID"),
  projectId: Id.optional().describe("Seulement les allocations de ce projet"),
  status: z.enum(["tentative", "confirmed"]).optional().describe("Seulement les allocations de ce statut"),
});
export type PersonAllocationListQuery = z.infer<typeof PersonAllocationListQuery>;
export const PersonAllocationList = z.object({ items: z.array(ScheduleAllocation), page: SchedulePage }).meta({ id: "PersonAllocationList" });

// --- Groupes (BR-26) ---
export const AllocationGroupMax = 50;
export const AllocationGroupCreate = z
  .object({
    ...fields,
    load: AllocationLoad.optional().describe("Charge commune, utilisée par les membres qui n'ont pas la leur"),
    members: z
      .array(z.object({ personId: Id, load: AllocationLoad.optional().describe("Charge propre à ce membre") }))
      .min(2)
      .max(AllocationGroupMax),
  })
  .refine((a) => a.endDate >= a.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .refine(
    (a) => (a.repeatState ?? "none") === "none" ? a.repeatEndDate == null : a.repeatEndDate != null && a.repeatEndDate >= a.endDate,
    { path: ["repeatEndDate"], message: "répétition incohérente" },
  )
  .refine((a) => new Set(a.members.map((m) => m.personId)).size === a.members.length, { path: ["members"], message: "personne en double" })
  .refine((a) => a.load !== undefined || a.members.every((m) => m.load !== undefined), { path: ["load"], message: "charge manquante" })
  .meta({ id: "AllocationGroupCreate" });
export type AllocationGroupCreate = z.infer<typeof AllocationGroupCreate>;

// Champs COMMUNS seulement : la personne et la charge sont propres à chaque ligne. Corps strict : une clé inconnue est une erreur.
export const AllocationGroupPatch = z
  .object(fields)
  .partial()
  .strict()
  .refine((a) => Object.keys(a).length > 0, { message: "corps vide" })
  .refine((a) => !a.startDate || !a.endDate || a.endDate >= a.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .meta({ id: "AllocationGroupPatch" });
export type AllocationGroupPatch = z.infer<typeof AllocationGroupPatch>;

export const AllocationGroup = z
  .object({ groupId: Id, items: z.array(ScheduleAllocation) })
  .meta({ id: "AllocationGroup" });
export type AllocationGroup = z.infer<typeof AllocationGroup>;

// --- « Cette occurrence » d'une série répétée (BR-25, US-3.3 ; décision 10 du registre) --------------------------------
// POST /allocations/{id}/split : pas de table d'exceptions, la série est DÉCOUPÉE en au plus trois allocations (splitSeries de
// @wnext/engine) : `before` (occurrences précédentes, série bornée à la veille), `occurrence` (l'occurrence seule, sans répétition)
// et `after` (occurrences suivantes, nouvelle origine, même fin de série). Choix de conception :
//  * Un corps plat : `occurrenceDate` désigne l'occurrence par sa date de DÉBUT (celle qu'affiche le client, calculée par
//    expandOccurrences du moteur) ; `patch` optionnel s'applique à l'occurrence isolée ; `delete: true` la supprime au lieu de la
//    garder. Ni l'un ni l'autre : découpe seule (l'occurrence est détachée telle quelle). Les deux : 400 VALIDATION_FAILED.
//    Un drapeau plutôt qu'une union discriminée : une seule forme à valider, à générer et à lire.
//  * `patch` reprend les champs du PATCH d'une allocation SAUF la répétition (repeatState, repeatEndDate) : l'occurrence isolée
//    n'est jamais une série (corps strict : une clé inconnue est une erreur). Mêmes contrôles de références que le PATCH.
//  * `If-Match` porte la version de la SÉRIE (ligne `{id}`) et est obligatoire : périmée -> 409 VERSION_CONFLICT
//    (params.currentVersion) ; absente -> 428 PRECONDITION_REQUIRED. Une seule transaction, la série est verrouillée.
//  * Lignes : `before` est la ligne d'origine (même id, nouvelle version). Occurrence 0 : la ligne d'origine est SUPPRIMÉE
//    (delete_log, BR-14) et `before` est absent. `occurrence` et `after` sont des lignes NOUVELLES (version 1) qui gardent le
//    `groupId` de la série. La réponse porte les morceaux qui existent après l'opération (`occurrence` absent si `delete`, `after`
//    absent pour la dernière occurrence).
//  * Erreurs propres : allocation non répétée -> 409 NOT_A_SERIES ; aucune occurrence ne commence à `occurrenceDate` -> 404
//    OCCURRENCE_NOT_FOUND (params.occurrenceDate) ; série que la découpe ne sait pas représenter -> 409 SERIES_SPLIT_UNSUPPORTED
//    (params.reason = overlapping : bloc plus long que le pas ; monthly_clamped : série mensuelle dont l'origine suivante serait
//    ramenée en fin de mois).
//  * BR-01 / BR-04 / BR-37 : comme le PATCH, rien n'est refusé pour sur-allocation, congé ou dates hors projet.
export const OccurrencePatch = z
  .object({ personId: Id, ...fields })
  .omit({ repeatState: true, repeatEndDate: true })
  .partial()
  .extend({ load: AllocationLoad.optional() })
  .strict()
  .refine((a) => Object.keys(a).length > 0, { message: "patch vide" })
  .refine((a) => !a.startDate || !a.endDate || a.endDate >= a.startDate, { path: ["endDate"], message: "endDate < startDate" });
export type OccurrencePatch = z.infer<typeof OccurrencePatch>;

export const AllocationSplit = z
  .object({
    occurrenceDate: IsoDate,
    patch: OccurrencePatch.optional(),
    delete: z.literal(true).optional(),
  })
  .strict()
  .refine((a) => !(a.delete && a.patch), { path: ["delete"], message: "patch et delete exclusifs" })
  .meta({ id: "AllocationSplit" });
export type AllocationSplit = z.infer<typeof AllocationSplit>;

export const AllocationSplitResult = z
  .object({
    before: ScheduleAllocation.optional(),
    occurrence: ScheduleAllocation.optional(),
    after: ScheduleAllocation.optional(),
  })
  .meta({ id: "AllocationSplitResult" });
export type AllocationSplitResult = z.infer<typeof AllocationSplitResult>;
