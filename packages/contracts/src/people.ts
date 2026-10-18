import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";
import { ReferenceListQuery } from "./reference";
import { SchedulePage, SchedulePeopleType, SchedulePerson, ScheduleProject } from "./schedule";

// Écriture des personnes planifiables (people ; distinctes des utilisateurs de connexion, ADR-002). Choix de conception :
//  * Même mécanique que les allocations et les congés : verrou optimiste (PATCH exige If-Match "<version>"), rôles
//    owner/admin/project_manager, références (département, rôle) vérifiées dans le compte (404 NOT_FOUND, params.entity).
//  * PAS de DELETE : supprimer une personne emporterait ses allocations, ses congés et ses temps saisis (clés étrangères en
//    cascade ou RESTRICT). On la DÉSACTIVE (`active: false`) : elle quitte le Schedule et le calcul de capacité, ses données
//    restent, et la réactivation est possible. Une suppression définitive relèverait d'une autre décision (confirmation avec
//    récapitulatif, comme BR-10 pour une équipe).
//  * Aucun coût, taux ni e-mail ici : le contrat de lecture ne les expose pas, l'écriture ne les accepte pas (ADR-001, zéro fuite).
//    Ils viendront avec leurs propres routes et leurs propres droits.
//  * `workDaysHours` : 7 valeurs, index 0 = lundi (ISO, CLAUDE.md), 0 à 24 h. Défaut serveur {8,8,8,8,8,0,0}.
//  * Défauts serveur : peopleType "employee", tags [], active true, pays/département/rôle/avatar null.
//  * Désactiver une personne ne touche pas ses allocations existantes (BR-04 : rien n'est supprimé en silence).
//  * Lecture (tout membre authentifié, comme GET /schedule : mêmes champs que SchedulePerson, ni coût ni e-mail) :
//      - GET /people : liste paginée par curseur sur `id` (tri par id, `page.total`, limit 1..500, défaut 200). Les personnes
//        désactivées sont EXCLUES par défaut (comme le Schedule) ; `includeInactive=true` les inclut. Filtres : departmentId, roleId,
//        tag (exact), search (sous-chaîne du nom, sans tenir compte de la casse ; les accents comptent). Paramètre inconnu ou répété :
//        400 VALIDATION_FAILED ; curseur illisible : 400 SCHEDULE_CURSOR_INVALID.
//      - GET /people/{id} : une personne, désactivée comprise, avec sa `version` (relire après un VERSION_CONFLICT). Inconnue ou
//        hors compte : 404 NOT_FOUND.
//      - GET /people/{id}/projects : les projets de la personne = ceux où elle est dans l'ÉQUIPE (project_team) OU qui ont au moins une
//        allocation d'elle (l'équipe n'est pas exigée pour allouer, Q-07). Chaque élément porte le projet (forme du Schedule), `inTeam`
//        et `allocationCount` (nombre de lignes d'allocation, une série compte pour une). Pagination comme ci-dessus, tri par id de
//        projet ; les projets archivés sont exclus par défaut, `status` filtre (status=archived les liste). Personne inconnue : 404.
//        La personne désactivée garde ses projets (lecture seule, rien n'est supprimé).

const name = z.string().min(1).max(200).regex(/\S/, "nom vide");
const tags = z.array(z.string().min(1).max(50).regex(/\S/)).max(50);

const fields = {
  name,
  peopleType: SchedulePeopleType.optional(),
  departmentId: orNull(Id).optional(),
  roleId: orNull(Id).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional().describe("ISO 3166-1 alpha-2 ; null = aucun férié de pays"),
  workDaysHours: z.array(z.number().min(0).max(24)).length(7).optional().describe("Heures ouvrées par jour, index 0 = lundi ... 6 = dimanche"),
  tags: tags.optional(),
  avatarUrl: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
};

export const PersonCreate = z.object(fields).meta({ id: "PersonCreate" });
export type PersonCreate = z.infer<typeof PersonCreate>;

// Champs absents = inchangés ; null efface département, rôle, pays ou avatar.
export const PersonPatch = z
  .object(fields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "corps vide" })
  .meta({ id: "PersonPatch" });
export type PersonPatch = z.infer<typeof PersonPatch>;

export const PersonPathParams = z.object({ id: Id });

// --- Lecture ---
export const PersonListQuery = ReferenceListQuery.extend({
  departmentId: Id.optional().describe("Seulement les personnes de ce département"),
  roleId: Id.optional().describe("Seulement les personnes de ce rôle"),
  tag: z.string().min(1).optional().describe("Seulement les personnes portant ce tag"),
  search: z.string().min(1).max(200).regex(/\S/).optional().describe("Sous-chaîne du nom, sans tenir compte de la casse"),
  includeInactive: z.boolean().optional().describe("Inclure les personnes désactivées (défaut : non)"),
});
export type PersonListQuery = z.infer<typeof PersonListQuery>;
export const PersonList = z.object({ items: z.array(SchedulePerson), page: SchedulePage }).meta({ id: "PersonList" });

export const PersonProject = z
  .object({
    project: ScheduleProject,
    inTeam: z.boolean().describe("La personne est dans l'équipe du projet"),
    allocationCount: z.number().int().min(0).describe("Lignes d'allocation de la personne sur ce projet (une série compte pour une)"),
  })
  .meta({ id: "PersonProject" });
export type PersonProject = z.infer<typeof PersonProject>;
export const PersonProjectListQuery = ReferenceListQuery.extend({
  status: ScheduleProject.shape.status.optional().describe("Seulement les projets de ce statut (les archivés ne sont listés que sur demande : status=archived)"),
});
export type PersonProjectListQuery = z.infer<typeof PersonProjectListQuery>;
export const PersonProjectList = z.object({ items: z.array(PersonProject), page: SchedulePage }).meta({ id: "PersonProjectList" });

// Désactivation d'une personne avec ses allocations futures (BR-31 : suppression/désactivation, PAS réallocation automatique).
// Désactiver par PATCH `active: false` ne touche à rien (BR-04) ; cette voie en deux temps règle le sort des allocations à venir,
// sur le modèle du retrait d'équipe (BR-10, team.ts) : jamais de suppression silencieuse.
//  1. GET  /people/{id}/deactivation-summary : récapitulatif des allocations « futures » (aucune écriture).
//  2. POST /people/{id}/deactivation : désactive la personne et applique `disposition` à ses allocations futures, en UNE transaction.
//  * « Futures » = lignes dont la fin effective (`repeatEndDate` pour une série, sinon `endDate`) est >= `asOf` (défaut : aujourd'hui,
//    date UTC du serveur ; `asOf` existe pour rendre le calcul reproductible). Une allocation déjà commencée mais non terminée est
//    donc concernée EN ENTIER (la ligne est réaffectée ou supprimée d'un bloc ; elle n'est jamais coupée). Le passé n'est jamais touché.
//  * `disposition` : `reassign` (avec `replacementId`) change la personne des lignes futures ; `delete` les supprime. Les temps saisis
//    (logged_time) ne sont jamais supprimés ni transférés : ils restent à la personne désactivée.
//  * Le remplaçant est OPTIONNEL et jamais deviné par le serveur : c'est au client de le proposer. Il doit être une autre personne
//    ACTIVE du compte (inconnu : 404 NOT_FOUND, params.entity = person, params.replacementId ; la personne elle-même ou une personne
//    désactivée : 409 PERSON_DEACTIVATION_INVALID_REPLACEMENT, params.reason = same_person|inactive). Aucun contrôle de capacité (BR-01).
//  * Garde de confirmation : s'il y a des allocations futures, `disposition` et `confirmation.allocationCount` (ce que l'utilisateur
//    a vu) sont obligatoires : 428 PERSON_DEACTIVATION_CONFIRMATION_REQUIRED, `params` = récapitulatif. Si le décompte a changé :
//    409 PERSON_DEACTIVATION_STALE_CONFIRMATION, `params` = nouveau récapitulatif. Sans allocation future, rien d'autre n'est requis.
//  * Une personne déjà désactivée peut encore être traitée (ses allocations futures restantes) ; rejouer sans allocation future ne change rien.
//  * Réservé à owner, admin et project_manager (403 FORBIDDEN, avant la validation du corps). Personne hors compte : 404 NOT_FOUND.
//  * Le délai « Annuler » de 10 s (BR-40) est côté client. Les `params` d'erreur sont des scalaires : les dates absentes sont omises.
export const PersonDeactivationQuery = z.object({ asOf: IsoDate.optional().describe("Date de référence de « futur » (défaut : aujourd'hui UTC)") });
export type PersonDeactivationQuery = z.infer<typeof PersonDeactivationQuery>;

export const PersonDeactivationSummary = z
  .object({
    alreadyInactive: z.boolean(),
    asOf: IsoDate,
    allocationCount: z.number().int().min(0).describe("Allocations dont la fin effective est >= asOf"),
    projectCount: z.number().int().min(0).describe("Projets distincts concernés"),
    firstAllocation: orNull(IsoDate).describe("Plus petit début parmi ces allocations"),
    lastAllocation: orNull(IsoDate).describe("Plus grande fin effective (fin de série incluse)"),
  })
  .meta({ id: "PersonDeactivationSummary" });
export type PersonDeactivationSummary = z.infer<typeof PersonDeactivationSummary>;

export const PersonDeactivationDisposition = z.enum(["reassign", "delete"]).meta({ id: "PersonDeactivationDisposition" });
export type PersonDeactivationDisposition = z.infer<typeof PersonDeactivationDisposition>;

export const PersonDeactivationRequest = z
  .object({
    asOf: IsoDate.optional().describe("Doit être celle du récapitulatif vu (défaut : aujourd'hui UTC)"),
    disposition: PersonDeactivationDisposition.optional().describe("Obligatoire s'il y a des allocations futures"),
    replacementId: Id.optional().describe("Requis avec `reassign`, interdit avec `delete`"),
    confirmation: z.object({ allocationCount: z.number().int().min(0) }).optional().describe("Obligatoire s'il y a des allocations futures"),
  })
  .refine((b) => (b.disposition === "reassign") === (b.replacementId !== undefined), { path: ["replacementId"], message: "replacementId requis avec reassign, interdit sinon" })
  .meta({ id: "PersonDeactivationRequest" });
export type PersonDeactivationRequest = z.infer<typeof PersonDeactivationRequest>;

export const PersonDeactivationResult = z
  .object({
    person: SchedulePerson.describe("La personne, désactivée, avec sa version courante"),
    reassignedAllocations: z.number().int().min(0),
    deletedAllocations: z.number().int().min(0),
  })
  .meta({ id: "PersonDeactivationResult" });
export type PersonDeactivationResult = z.infer<typeof PersonDeactivationResult>;
