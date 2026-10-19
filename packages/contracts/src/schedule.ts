import { z } from "zod";
import { Id, IsoDate, orNull, Version } from "./common";

// GET /api/v1/schedule : fenêtre du Schedule (dossier §3.3 : chargement par fenêtre, matrice creuse personnes x jours).
//
// Choix de conception :
//  * La réponse porte les DONNÉES D'ENTRÉE du moteur (horaires, allocations, congés, fériés), pas la capacité ni
//    l'utilisation calculées : le client les calcule avec @wnext/engine, de façon identique à l'API, ce qui permet
//    de recalculer instantanément pendant un glisser-déposer. Le serveur reste la source de vérité des écritures.
//  * Aucun coût, taux, budget ni e-mail : un Member ne doit rien en recevoir (ADR-001, zéro fuite).
//  * `changeCursor` = position du journal change_log au moment de la lecture ; le WebSocket reprend depuis ce curseur (ADR-003 §5).
//  * Pagination par curseur sur les PERSONNES (lignes du Schedule) ; allocations et congés ne concernent que les personnes de la page.
//  * `version` sur chaque entité modifiable : base de l'ETag / 409 (ADR-003 §5).
//  * Les avertissements métier (sur-allocation BR-01, congé sur allocations BR-04) ne sont pas dans la réponse : ils se dérivent
//    des mêmes données avec le moteur.

export const ScheduleQuery = z.object({
  from: IsoDate.describe("Début de la fenêtre (inclus)"),
  to: IsoDate.describe("Fin de la fenêtre (incluse). 400 jours au plus, sinon SCHEDULE_RANGE_INVALID"),
  departmentId: Id.optional().describe("Seulement les personnes de ce département"),
  roleId: Id.optional().describe("Seulement les personnes de ce rôle"),
  projectId: Id.optional().describe("Seulement les personnes allouées à ce projet dans la fenêtre (leurs autres allocations restent renvoyées)"),
  tag: z.string().min(1).optional().describe("Seulement les personnes portant ce tag"),
  includeInactive: z.boolean().optional().describe("Inclure les personnes désactivées (défaut : non)"),
  limit: z.number().int().min(1).max(500).optional().describe("Personnes par page (défaut 200)"),
  cursor: z.string().min(1).optional().describe("Curseur de page renvoyé par page.nextCursor"),
});
export type ScheduleQuery = z.infer<typeof ScheduleQuery>;

export const SchedulePeopleType = z.enum(["employee", "contractor", "placeholder"]).meta({ id: "SchedulePeopleType" });

export const SchedulePerson = z
  .object({
    id: Id,
    version: Version,
    name: z.string(),
    peopleType: SchedulePeopleType,
    departmentId: orNull(Id),
    roleId: orNull(Id),
    country: z.string().regex(/^[A-Z]{2}$/).nullable().describe("ISO 3166-1 alpha-2 ; null = aucun férié de pays"),
    workDaysHours: z.array(z.number().min(0).max(24)).length(7).describe("Heures ouvrées par jour, index 0 = lundi ... 6 = dimanche"),
    tags: z.array(z.string()),
    avatarUrl: z.string().nullable(),
    active: z.boolean(),
  })
  .meta({ id: "SchedulePerson" });

const allocationBase = z.object({
  id: Id,
  version: Version,
  personId: Id,
  projectId: Id,
  phaseId: orNull(Id),
  taskId: orNull(Id),
  groupId: orNull(Id).describe("Allocation multi-personnes : lignes liées par un même groupe (BR-26)"),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  startDate: IsoDate,
  endDate: IsoDate,
  status: z.enum(["tentative", "confirmed"]),
  billable: z.boolean(),
  priority: z.number().int(),
  repeatState: z.enum(["none", "daily", "weekly", "monthly"]),
  repeatEndDate: orNull(IsoDate).describe("Fin de série ; null si repeatState = none"),
});

// Le mode impose son champ : heures par jour OU pourcentage des heures ouvrées brutes du jour (BR-24, plafond technique 500 %).
export const ScheduleAllocation = z
  .discriminatedUnion("mode", [
    allocationBase.extend({ mode: z.literal("hours"), hoursPerDay: z.number().gt(0).max(24), percent: z.null() }),
    allocationBase.extend({ mode: z.literal("percentage"), hoursPerDay: z.null(), percent: z.number().gt(0).max(500) }),
  ])
  .meta({ id: "ScheduleAllocation" });

export const ScheduleTimeoff = z
  .object({
    id: Id,
    version: Version,
    personId: Id,
    typeId: Id,
    startDate: IsoDate,
    endDate: IsoDate,
    scope: z.enum(["full_day", "partial"]),
    startHalf: z.enum(["am", "pm"]),
    endHalf: z.enum(["am", "pm"]),
    hoursPerDay: z.number().gt(0).max(24).nullable().describe("Renseigné seulement si scope = partial"),
    approvalStatus: z.enum(["pending", "approved", "declined"]),
  })
  .meta({ id: "ScheduleTimeoff" });

export const ScheduleTimeoffType = z
  .object({ id: Id, version: Version, name: z.string(), deducted: z.boolean().describe("Déduit de la capacité") })
  .meta({ id: "ScheduleTimeoffType" });

export const ScheduleHoliday = z
  .object({
    id: Id,
    version: Version,
    name: z.string(),
    date: IsoDate,
    country: z.string().regex(/^[A-Z]{2}$/).nullable().describe("null = tous pays"),
    departmentId: orNull(Id).describe("null = tous départements"),
    hoursOff: z.number().gt(0).max(24).nullable().describe("null = journée entière"),
  })
  .meta({ id: "ScheduleHoliday" });

export const ScheduleProject = z
  .object({
    id: Id,
    version: Version,
    name: z.string(),
    projectCode: z.string().nullable(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    status: z.enum(["tentative", "planned", "in_progress", "on_hold", "completed", "archived"]),
    nonBillable: z.boolean(),
    /** Bornes du projet (BR-37 : le client avertit d'une allocation hors bornes avec @wnext/engine) ; null = non bornée. */
    startDate: orNull(IsoDate),
    endDate: orNull(IsoDate),
  })
  .meta({ id: "ScheduleProject" });

export const ScheduleDepartment = z.object({ id: Id, version: Version, name: z.string() }).meta({ id: "ScheduleDepartment" });
export const ScheduleRole = z.object({ id: Id, version: Version, name: z.string() }).meta({ id: "ScheduleRole" });

export const ScheduleAccount = z
  .object({
    weekStart: z.number().int().min(1).max(7).describe("Premier jour affiché, ISO : 1 = lundi ... 7 = dimanche (affichage seulement)"),
    capacityThresholds: z.object({ underPercent: z.number().min(1).max(100) }).describe("Seuil de sous-allocation du compte ; la sur-allocation est fixe à 100 %"),
    timezone: z.string().min(1).describe("Fuseau IANA du compte (accounts.timezone) : « Aujourd'hui » et dates métier sont celles de ce fuseau, jamais celui du navigateur (BR-18)"),
  })
  .meta({ id: "ScheduleAccount" });

export const SchedulePage = z
  .object({
    nextCursor: z.string().nullable().describe("null = dernière page"),
    total: z.number().int().min(0).describe("Nombre total de personnes correspondant aux filtres"),
  })
  .meta({ id: "SchedulePage" });

export const ScheduleResponse = z
  .object({
    window: z.object({ from: IsoDate, to: IsoDate }),
    changeCursor: z.string().describe("Position du journal change_log à la lecture ; point de reprise du WebSocket"),
    page: SchedulePage,
    account: ScheduleAccount,
    people: z.array(SchedulePerson),
    allocations: z.array(ScheduleAllocation).describe("Allocations de la page recoupant la fenêtre (séries répétées incluses)"),
    timeoffs: z.array(ScheduleTimeoff),
    holidays: z.array(ScheduleHoliday).describe("Tous les fériés du compte dans la fenêtre ; le moteur applique pays et département"),
    projects: z.array(ScheduleProject).describe("Projets référencés par les allocations renvoyées"),
    timeoffTypes: z.array(ScheduleTimeoffType),
    departments: z.array(ScheduleDepartment),
    roles: z.array(ScheduleRole),
  })
  .meta({ id: "ScheduleResponse" });
export type ScheduleResponse = z.infer<typeof ScheduleResponse>;
