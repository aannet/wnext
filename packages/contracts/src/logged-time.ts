import { z } from "zod";
import { Id, IsoDate, orNull, Version } from "./common";

// Temps saisi (logged_time, T2) : le réalisé, contrepartie du planifié. BR-11, BR-12, BR-27, BR-28. Choix de conception :
//  * Pré-remplissage (BR-11) : POST /logged-time/prefill MATÉRIALISE, pour une personne et une fenêtre, un brouillon par jour et par
//    allocation CONFIRMÉE (projet non tentatif ; les heures de l'allocation ce jour-là, pourcentage converti sur les heures brutes,
//    arrondies au centième), avec `allocationId` = l'allocation source. Il n'enlève RIEN pour congés ou fériés : c'est un miroir,
//    l'utilisateur confirme ou ajuste. Idempotent : une ligne existe déjà pour (allocation, jour) -> ignorée (une ligne supprimée
//    est donc recréée au prochain appel). Le total d'un jour ne dépasse jamais 24 h (BR-28) : le brouillon est tronqué à ce qui reste,
//    ou omis. Réponse : `items` = toutes les lignes de la personne dans la fenêtre après l'opération, `createdCount` = lignes créées.
//  * Cycle de vie (BR-12, BR-28) : draft -> submitted (POST /logged-time/submit, atomique : tous les brouillons de la personne dans la
//    fenêtre, tout ou rien). Une ligne qui n'est plus un brouillon est immuable : PATCH et DELETE sont refusés par 409
//    LOGGED_TIME_LOCKED (`params.status`). Seuls owner et admin déverrouillent (POST /logged-time/{id}/unlock : retour à draft,
//    `unlocked_by` / `unlocked_at` tracés en base). approved et locked sont posés par un circuit d'approbation à venir.
//  * Total par personne et par jour <= 24 h (BR-28) : dépassement -> 409 LOGGED_TIME_DAY_LIMIT. Un placeholder ne logue pas de temps
//    (BR-27) : 400 VALIDATION_FAILED (field = personId).
//  * Verrou optimiste comme les autres entités (If-Match "<version>", 409 VERSION_CONFLICT, 428 PRECONDITION_REQUIRED).
//  * Rôles : lecture pour tout membre authentifié ; écritures (création, modification, suppression, pré-remplissage, soumission)
//    pour owner, admin et project_manager ; déverrouillage owner et admin. La saisie par un membre pour lui-même (lien
//    utilisateur <-> personne, BR-33) est hors périmètre.
//  * Fenêtres : `from` et `to` obligatoires, 400 jours au plus (SCHEDULE_RANGE_INVALID). Liste non paginée : une seule personne,
//    donc au plus quelques lignes par jour.
//  * Hors périmètre (à venir) : période de timesheet configurable et échéance de verrouillage automatique (Q-05/Q-06), ajout dans une
//    période verrouillée, approbation, rapports, diffusion temps réel (logged_time n'est pas dans ChangeEntity).
//  * Les temps saisis ne sont jamais touchés par une désactivation de personne ; un retrait d'équipe les supprime s'ils sont tous
//    brouillons (team.ts).

export const LoggedTimeStatus = z.enum(["draft", "submitted", "approved", "locked"]).meta({ id: "LoggedTimeStatus" });

export const LoggedTime = z
  .object({
    id: Id,
    version: Version,
    personId: Id,
    projectId: Id,
    phaseId: orNull(Id),
    taskId: orNull(Id),
    allocationId: orNull(Id).describe("Allocation d'origine du pré-remplissage ; null pour une saisie libre ou si l'allocation a été supprimée"),
    workDate: IsoDate,
    hours: z.number().gt(0).max(24),
    billable: z.boolean(),
    notes: orNull(z.string()),
    status: LoggedTimeStatus,
  })
  .meta({ id: "LoggedTime" });
export type LoggedTime = z.infer<typeof LoggedTime>;

export const LoggedTimePathParams = z.object({ id: Id });

export const LoggedTimeListQuery = z
  .object({
    personId: Id,
    from: IsoDate.describe("Début de la fenêtre (inclus)"),
    to: IsoDate.describe("Fin de la fenêtre (incluse). 400 jours au plus, sinon SCHEDULE_RANGE_INVALID"),
    status: LoggedTimeStatus.optional().describe("Seulement les lignes de ce statut"),
  })
  .meta({ id: "LoggedTimeListQuery" });
export type LoggedTimeListQuery = z.infer<typeof LoggedTimeListQuery>;

export const LoggedTimeList = z.object({ items: z.array(LoggedTime) }).meta({ id: "LoggedTimeList" });
export type LoggedTimeList = z.infer<typeof LoggedTimeList>;

const fields = {
  phaseId: orNull(Id).optional(),
  taskId: orNull(Id).optional(),
  hours: z.number().gt(0).max(24),
  billable: z.boolean().optional(),
  notes: z.string().max(5000).nullable().optional(),
};

export const LoggedTimeCreate = z
  .object({ personId: Id, projectId: Id, workDate: IsoDate, ...fields })
  .meta({ id: "LoggedTimeCreate" });
export type LoggedTimeCreate = z.infer<typeof LoggedTimeCreate>;

// Champs absents = inchangés. La personne, le projet et le jour ne changent pas : supprimer puis recréer.
export const LoggedTimePatch = z
  .object(fields)
  .partial()
  .refine((t) => Object.keys(t).length > 0, { message: "corps vide" })
  .meta({ id: "LoggedTimePatch" });
export type LoggedTimePatch = z.infer<typeof LoggedTimePatch>;

/** Corps de POST /logged-time/prefill et /logged-time/submit. */
export const LoggedTimeWindow = z
  .object({ personId: Id, from: IsoDate, to: IsoDate })
  .refine((w) => w.to >= w.from, { path: ["to"], message: "to < from" })
  .meta({ id: "LoggedTimeWindow" });
export type LoggedTimeWindow = z.infer<typeof LoggedTimeWindow>;

export const LoggedTimePrefillResult = z
  .object({ items: z.array(LoggedTime), createdCount: z.number().int().min(0) })
  .meta({ id: "LoggedTimePrefillResult" });
export type LoggedTimePrefillResult = z.infer<typeof LoggedTimePrefillResult>;

export const LoggedTimeSubmitResult = z
  .object({ items: z.array(LoggedTime), submittedCount: z.number().int().min(0) })
  .meta({ id: "LoggedTimeSubmitResult" });
export type LoggedTimeSubmitResult = z.infer<typeof LoggedTimeSubmitResult>;
