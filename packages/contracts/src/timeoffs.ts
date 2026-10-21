import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";

// Écriture des congés (timeoffs). Choix de conception :
//  * Même mécanique que les allocations : verrou optimiste (PATCH/DELETE exigent If-Match "<version>", 409 VERSION_CONFLICT,
//    428 PRECONDITION_REQUIRED), rôles owner/admin/project_manager, références vérifiées dans le compte (404 NOT_FOUND).
//  * BR-04 : poser un congé sur des allocations existantes n'est PAS refusé et ne supprime ni ne déplace rien. La réponse ne
//    porte pas d'avertissement : le client le déduit avec @wnext/engine et propose la replanification assistée.
//  * Demi-journées : startHalf/endHalf (am|pm). Défaut am..pm = journées entières ; une moitié déduit 50 % des heures du jour.
//    scope "partial" = un nombre d'heures par jour (hoursPerDay), toujours en journées entières (am..pm).
//  * Un même congé ne peut pas en chevaucher un autre de la même personne, à la demi-journée près, sauf s'il est refusé
//    (declined) ou partiel : 409 TIMEOFF_OVERLAP. Ce n'est pas un conflit de version : recharger ne suffit pas, il faut changer les dates.
//  * Défauts serveur : scope "full_day", startHalf "am", endHalf "pm", approvalStatus "approved" (RT-022 : un congé est posé par un
//    manager ou un admin et vaut décision ; pas de circuit de demande). "pending" reste accepté et lu pour les congés existants
//    (compté dans la capacité, sans assistant BR-04, BR-29), mais l'écran ne le propose plus à la pose.
//  * Hors périmètre : demande d'un membre pour lui-même et circuit d'approbation (retirés, RT-022) ; création de plusieurs
//    personnes à la fois ; types de congé (écriture).

const half = z.enum(["am", "pm"]);

const fields = {
  typeId: Id,
  startDate: IsoDate,
  endDate: IsoDate,
  scope: z.enum(["full_day", "partial"]).optional(),
  startHalf: half.optional(),
  endHalf: half.optional(),
  hoursPerDay: orNull(z.number().gt(0).max(24)).optional().describe("Obligatoire si scope = partial, absent ou null sinon"),
  approvalStatus: z.enum(["pending", "approved", "declined"]).optional().describe("Défaut approved (RT-022) ; pending conservé pour les congés existants"),
  notes: z.string().max(5000).nullable().optional(),
};

const body = z.object({ personId: Id, ...fields });

export const TimeoffCreate = body
  .refine((t) => t.endDate >= t.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .refine((t) => (t.scope ?? "full_day") === "partial" ? t.hoursPerDay != null : t.hoursPerDay == null, { path: ["hoursPerDay"], message: "hoursPerDay incohérent avec scope" })
  .refine((t) => (t.scope ?? "full_day") === "full_day" || ((t.startHalf ?? "am") === "am" && (t.endHalf ?? "pm") === "pm"), { path: ["scope"], message: "un congé partiel couvre des journées entières" })
  .refine((t) => t.endDate > t.startDate || (t.startHalf ?? "am") <= (t.endHalf ?? "pm"), { path: ["endHalf"], message: "moitiés incohérentes sur un seul jour" })
  .meta({ id: "TimeoffCreate" });
export type TimeoffCreate = z.infer<typeof TimeoffCreate>;

// Champs absents = inchangés. La cohérence avec l'état courant (dates, moitiés, scope) est contrôlée par le serveur.
export const TimeoffPatch = body
  .partial()
  .refine((t) => Object.keys(t).length > 0, { message: "corps vide" })
  .refine((t) => !t.startDate || !t.endDate || t.endDate >= t.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .meta({ id: "TimeoffPatch" });
export type TimeoffPatch = z.infer<typeof TimeoffPatch>;

export const TimeoffPathParams = z.object({ id: Id });
