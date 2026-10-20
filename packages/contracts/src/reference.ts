import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";
import { ScheduleDepartment, ScheduleHoliday, ScheduleProject, SchedulePage, ScheduleRole, ScheduleTimeoffType } from "./schedule";

// Lecture et écriture des entités de référence : départements, rôles, types de congé, jours fériés, projets. Choix de conception :
//  * Même mécanique que les allocations : verrou optimiste (PATCH et DELETE exigent If-Match "<version>"), 404 NOT_FOUND
//    (params.entity) pour une référence hors compte. Les `version` sont lues dans GET /schedule (champ ajouté aux listes de référence).
//  * Droits. Départements, rôles, types de congé et jours fériés sont de la CONFIGURATION du compte : owner et admin seulement
//    (403 FORBIDDEN sinon, y compris pour un project_manager). Les projets se créent et se modifient par owner, admin et project_manager.
//    Matrice à valider (décision produit ouverte).
//  * Unicité : un nom déjà pris dans le compte (département, rôle, type de congé), un même jour férié (date, pays, département, nom)
//    ou un code projet déjà utilisé donnent 409 ALREADY_EXISTS (params.entity, et params.field si c'est un champ précis).
//  * Suppression SANS cascade silencieuse (comme BR-10 : jamais de perte en silence). Un département, un rôle ou un type de congé
//    encore référencé est refusé : 409 REFERENCE_IN_USE, params = nombre de lignes liées par entité (ex. people, holidays). Il faut
//    d'abord réaffecter ou supprimer ces lignes. Un jour férié, lui, se supprime librement.
//  * PAS de DELETE pour les projets : il emporterait allocations, temps saisis, phases et budgets. On les archive (status "archived").
//  * Lecture : GET /x (liste paginée) et GET /x/{id} (une entité, pour relire la `version` après un VERSION_CONFLICT). Tout membre
//    authentifié peut lire, quel que soit son rôle (comme GET /schedule). Tri par `id` croissant, stable : le client trie à
//    l'affichage. Pagination par curseur opaque (`page.nextCursor`, null = dernière page) et `page.total` = nombre total
//    d'entités correspondant aux filtres. Défaut 200 par page, 500 au plus. Filtres : fériés `from`/`to` (dates incluses),
//    projets `status`. Paramètre inconnu ou répété : 400 VALIDATION_FAILED ; curseur illisible : 400 SCHEDULE_CURSOR_INVALID.
//  * Hors périmètre ici : clients, grilles de tarifs, devise, budget, phases et tâches (autres routes, autres droits), équipe du projet
//    (routes /team).

const name = z.string().min(1).max(200).regex(/\S/, "nom vide");
const tags = z.array(z.string().min(1).max(50).regex(/\S/)).max(50);
const noEmpty = (p: object) => Object.keys(p).length > 0;

export const ReferencePathParams = z.object({ id: Id });

// --- Lecture : requêtes et pages --------------------------------------------------------------------------------------
export const ReferenceListQuery = z.object({
  limit: z.number().int().min(1).max(500).optional().describe("Entités par page (défaut 200)"),
  cursor: z.string().min(1).optional().describe("Curseur de page renvoyé par page.nextCursor"),
});
export const HolidayListQuery = ReferenceListQuery.extend({
  from: IsoDate.optional().describe("Fériés à partir de cette date (incluse)"),
  to: IsoDate.optional().describe("Fériés jusqu'à cette date (incluse)"),
}).refine((q) => !q.from || !q.to || q.to >= q.from, { path: ["to"], message: "to < from" });
export const ProjectListQuery = ReferenceListQuery.extend({
  status: ScheduleProject.shape.status.optional().describe("Seulement les projets de ce statut (les archivés ne sont listés que sur demande : status=archived)"),
});

const pageOf = <T extends z.ZodType>(item: T, id: string) => z.object({ items: z.array(item), page: SchedulePage }).meta({ id });
export const DepartmentList = pageOf(ScheduleDepartment, "DepartmentList");
export const RoleList = pageOf(ScheduleRole, "RoleList");
export const TimeoffTypeList = pageOf(ScheduleTimeoffType, "TimeoffTypeList");
export const HolidayList = pageOf(ScheduleHoliday, "HolidayList");

// --- Départements et rôles : un nom ---------------------------------------------------------------------------------
export const DepartmentCreate = z.object({ name }).meta({ id: "DepartmentCreate" });
export const DepartmentPatch = z.object({ name }).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "DepartmentPatch" });
export const RoleCreate = z.object({ name }).meta({ id: "RoleCreate" });
export const RolePatch = z.object({ name }).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "RolePatch" });

// --- Types de congé ---------------------------------------------------------------------------------------------------
const typeFields = { name, deducted: z.boolean().optional().describe("Déduit de la capacité ; défaut true") };
export const TimeoffTypeCreate = z.object(typeFields).meta({ id: "TimeoffTypeCreate" });
export const TimeoffTypePatch = z.object(typeFields).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "TimeoffTypePatch" });

// --- Jours fériés -----------------------------------------------------------------------------------------------------
// country null = tous pays ; departmentId null = tous départements ; hoursOff null = journée entière.
const holidayFields = {
  name,
  date: IsoDate,
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  departmentId: orNull(Id).optional(),
  hoursOff: z.number().gt(0).max(24).nullable().optional(),
};
export const HolidayCreate = z.object(holidayFields).meta({ id: "HolidayCreate" });
export const HolidayPatch = z.object(holidayFields).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "HolidayPatch" });

// --- Projets ----------------------------------------------------------------------------------------------------------
const projectFields = {
  name,
  projectCode: z.string().min(1).max(100).regex(/\S/).nullable().optional().describe("Référence externe, unique dans le compte"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe("Défaut #3B82F6"),
  startDate: orNull(IsoDate).optional(),
  endDate: orNull(IsoDate).optional(),
  status: ScheduleProject.shape.status.optional().describe("Défaut planned ; \"archived\" tient lieu de suppression"),
  projectManagerId: orNull(Id).optional().describe("Une personne du compte"),
  clientId: orNull(Id).optional().describe("Un client du compte ; null = sans client"),
  nonBillable: z.boolean().optional(),
  tags: tags.optional(),
  notes: z.string().max(5000).nullable().optional(),
};
export const ProjectCreate = z
  .object(projectFields)
  .refine((p) => !p.startDate || !p.endDate || p.endDate >= p.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .meta({ id: "ProjectCreate" });
export const ProjectPatch = z
  .object(projectFields)
  .partial()
  .refine(noEmpty, { message: "corps vide" })
  .refine((p) => !p.startDate || !p.endDate || p.endDate >= p.startDate, { path: ["endDate"], message: "endDate < startDate" })
  .meta({ id: "ProjectPatch" });

/** Projet complet : la forme du Schedule plus ce qui ne s'affiche pas dans la grille. */
export const ProjectDetail = ScheduleProject.extend({
  projectManagerId: orNull(Id),
  clientId: orNull(Id),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
}).meta({ id: "ProjectDetail" });

export const ProjectList = pageOf(ProjectDetail, "ProjectList");

export type DepartmentCreate = z.infer<typeof DepartmentCreate>;
export type DepartmentPatch = z.infer<typeof DepartmentPatch>;
export type RoleCreate = z.infer<typeof RoleCreate>;
export type RolePatch = z.infer<typeof RolePatch>;
export type TimeoffTypeCreate = z.infer<typeof TimeoffTypeCreate>;
export type TimeoffTypePatch = z.infer<typeof TimeoffTypePatch>;
export type HolidayCreate = z.infer<typeof HolidayCreate>;
export type HolidayPatch = z.infer<typeof HolidayPatch>;
export type ProjectCreate = z.infer<typeof ProjectCreate>;
export type ProjectPatch = z.infer<typeof ProjectPatch>;
export type ProjectDetail = z.infer<typeof ProjectDetail>;
