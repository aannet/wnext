import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";

// Écriture des allocations (entité pivot du Schedule). Choix de conception :
//  * Verrou optimiste (ADR-003 §5) : PATCH et DELETE exigent `If-Match: "<version>"` (la `version` lue dans le Schedule).
//    Version périmée -> 409 VERSION_CONFLICT avec `currentVersion` ; en-tête absent -> 428 PRECONDITION_REQUIRED.
//    La création n'a pas de précondition ; la réponse porte la `version` à utiliser ensuite.
//  * BR-01 : la sur-allocation n'est JAMAIS une erreur ici. La réponse ne contient pas d'avertissement : le client la
//    déduit avec @wnext/engine à partir des mêmes données, comme pour la lecture.
//  * BR-04 : écrire une allocation sur un jour de congé n'est pas refusé non plus ; l'avertissement vient du moteur.
//  * Le mode impose son champ via `load` (heures par jour OU pourcentage des heures brutes, plafond 500 %, BR-24).
//  * Défauts appliqués par le serveur quand le champ est omis : status "confirmed", billable true, priority 0, repeatState "none".
//  * Hors périmètre de ce contrat (à venir) : création multi-personnes / groupes (BR-26, « tous / celle-ci »), déplacement
//    par lot, suppression en cascade d'équipe (BR-10, avec récapitulatif et confirmation).
//  * Les écritures sont réservées aux rôles owner, admin et project_manager ; un autre rôle reçoit 403 FORBIDDEN.

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
