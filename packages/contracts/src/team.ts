import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";
import { SchedulePage } from "./schedule";

// Retrait d'une personne d'un projet (BR-10, US-2.2). Le retrait SUPPRIME les allocations et les temps saisis de la personne
// sur ce projet : jamais de suppression silencieuse, donc deux temps.
//  1. GET  .../removal-summary : récapitulatif « N allocations, M heures saisies seront supprimées » (aucune écriture).
//  2. POST .../removal : exécution, avec la confirmation de ce que l'utilisateur a vu. Si l'état a changé depuis (ajout ou
//     modification), la confirmation est périmée : 409 TEAM_REMOVAL_STALE_CONFIRMATION, `params` porte le nouveau récapitulatif
//     à re-présenter. Sans confirmation alors qu'il y a quelque chose à supprimer : 428 TEAM_REMOVAL_CONFIRMATION_REQUIRED.
//     Des temps non brouillons (soumis, approuvés, verrouillés ; BR-12, BR-31) interdisent le retrait : 409 TEAM_REMOVAL_LOCKED_LOGS.
//  * Le délai de 10 s « Annuler » (BR-40, ADR-001 §10) est côté client : aucune écriture destructive avant l'échéance,
//    donc le serveur ne connaît ni toast ni annulation.
//  * L'appartenance à l'équipe (project_team) n'est pas exigée pour allouer (Q-07 ouverte) : le retrait supprime la ligne
//    d'équipe si elle existe (`inTeam`) et, dans tous les cas, ce que le récapitulatif annonce.
//  * Réservé aux rôles owner, admin et project_manager (403 FORBIDDEN). Projet ou personne hors du compte : 404 NOT_FOUND.
//  * Les `params` des erreurs sont des scalaires : les dates absentes sont omises, pas nulles.

export const TeamPathParams = z.object({ projectId: Id, personId: Id });
export const TeamProjectPathParams = z.object({ projectId: Id });

export const TeamRemovalSummary = z
  .object({
    inTeam: z.boolean().describe("Une ligne d'équipe existe pour cette personne sur ce projet"),
    allocationCount: z.number().int().min(0),
    firstAllocation: orNull(IsoDate),
    lastAllocation: orNull(IsoDate).describe("Fin de série incluse pour les allocations répétées"),
    logCount: z.number().int().min(0),
    logHours: z.number().min(0),
    lockedLogCount: z.number().int().min(0).describe("Temps saisis qui ne sont plus des brouillons"),
    canRemove: z.boolean().describe("Faux si lockedLogCount > 0"),
  })
  .meta({ id: "TeamRemovalSummary" });
export type TeamRemovalSummary = z.infer<typeof TeamRemovalSummary>;

/** Ce que l'utilisateur a vu et confirmé dans le récapitulatif. */
export const TeamRemovalConfirmation = z
  .object({ allocationCount: z.number().int().min(0), logCount: z.number().int().min(0), logHours: z.number().min(0) })
  .meta({ id: "TeamRemovalConfirmation" });

export const TeamRemovalRequest = z
  .object({ confirmation: TeamRemovalConfirmation.optional().describe("Obligatoire s'il y a des allocations ou des temps à supprimer") })
  .meta({ id: "TeamRemovalRequest" });
export type TeamRemovalRequest = z.infer<typeof TeamRemovalRequest>;

export const TeamRemovalResult = z
  .object({
    removedAllocations: z.number().int().min(0),
    removedLogs: z.number().int().min(0),
    removedLogHours: z.number().min(0),
    wasInTeam: z.boolean(),
  })
  .meta({ id: "TeamRemovalResult" });
export type TeamRemovalResult = z.infer<typeof TeamRemovalResult>;

// Ajout d'une personne à l'équipe d'un projet : PUT idempotent sur la ressource « appartenance », sans corps.
//  * Rejouer ne change rien : `added` vaut false si la ligne existait déjà (200 dans les deux cas).
//  * N'écrit que project_team : aucune allocation, aucun contrôle de capacité (BR-01) ; l'appartenance n'est pas exigée pour allouer (Q-07).
//  * Mêmes rôles et mêmes 404 que le retrait (403 FORBIDDEN, 404 NOT_FOUND `params.entity` project|person).
export const TeamMembership = z
  .object({ added: z.boolean().describe("Faux si la personne était déjà dans l'équipe") })
  .meta({ id: "TeamMembership" });
export type TeamMembership = z.infer<typeof TeamMembership>;

// Lecture de l'équipe d'un projet : GET /projects/{projectId}/team, liste paginée par curseur (limit 1..500, défaut 200, ReferenceListQuery).
//  * Ouverte à tout membre authentifié, comme les autres lectures. Projet inconnu ou hors compte : 404 NOT_FOUND (params.entity = project) ;
//    un projet archivé se lit normalement.
//  * Tri par `personId` croissant (stable) ; le client trie à l'affichage. `page.total` = taille de l'équipe.
//  * Une équipe vide est une liste vide (200), pas une erreur. L'appartenance n'est pas exigée pour allouer (Q-07) : l'équipe n'est donc
//    PAS la liste des personnes allouées au projet.
//  * Ne porte que l'identité de la personne (`personId`, `name`) : le reste (rôle, département, capacité) est dans GET /schedule ou GET /people.
//    Paramètre inconnu ou répété : 400 VALIDATION_FAILED ; curseur illisible : 400 SCHEDULE_CURSOR_INVALID.
export const TeamMember = z.object({ personId: Id, name: z.string() }).meta({ id: "TeamMember" });
export type TeamMember = z.infer<typeof TeamMember>;
export const TeamMemberList = z.object({ items: z.array(TeamMember), page: SchedulePage }).meta({ id: "TeamMemberList" });
export type TeamMemberList = z.infer<typeof TeamMemberList>;

// Ajout en lot : POST /projects/{projectId}/team, corps { personIds }. Équivalent de n PUT individuels, en UNE transaction.
//  * Tout ou rien : si une personne est inconnue ou d'un autre compte, rien n'est écrit et la réponse est 404 NOT_FOUND
//    (params.entity = person, params.personId = la première fautive dans l'ordre reçu). Projet inconnu : 404 (params.entity = project).
//  * Idempotent comme le PUT : une personne déjà dans l'équipe n'est pas une erreur, elle est listée dans `alreadyInTeam`.
//    Rejouer le même lot ne change rien (tout part en `alreadyInTeam`). 200 dans tous les cas.
//  * `added` et `alreadyInTeam` suivent l'ordre du corps. Une même personne deux fois dans `personIds` est une erreur du client :
//    400 VALIDATION_FAILED (field = personIds) ; de même pour une liste vide ou de plus de 500 personnes.
//  * N'écrit que project_team : aucune allocation, aucun contrôle de capacité (BR-01) ; l'appartenance n'est pas exigée pour allouer (Q-07).
//  * Mêmes rôles que l'ajout et le retrait : owner, admin, project_manager (403 FORBIDDEN, vérifié avant le corps).
export const TEAM_BATCH_MAX = 500;
export const TeamBatchAdd = z
  .object({ personIds: z.array(Id).min(1).max(TEAM_BATCH_MAX) })
  .refine((b) => new Set(b.personIds).size === b.personIds.length, { path: ["personIds"], message: "identifiant en double" })
  .meta({ id: "TeamBatchAdd" });
export type TeamBatchAdd = z.infer<typeof TeamBatchAdd>;
export const TeamBatchResult = z
  .object({
    added: z.array(Id).describe("Personnes ajoutées par cet appel"),
    alreadyInTeam: z.array(Id).describe("Personnes qui y étaient déjà"),
  })
  .meta({ id: "TeamBatchResult" });
export type TeamBatchResult = z.infer<typeof TeamBatchResult>;
