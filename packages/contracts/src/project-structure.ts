import { z } from "zod";
import { Id, IsoDate, Version, orNull } from "./common";
import { ReferenceListQuery } from "./reference";
import { SchedulePage, ScheduleProject } from "./schedule";

// Clients, phases et tâches de projet. Même mécanique que les entités de référence (reference.ts) : lecture paginée par curseur
// sur `id` et lecture par id ouvertes à tout membre, écriture avec verrou optimiste (If-Match), 404 NOT_FOUND (params.entity)
// pour une référence hors compte, suppression SANS cascade silencieuse (409 REFERENCE_IN_USE, params = nombre de lignes liées).
//  * Droits. Ce sont des données de PROJET, pas de configuration : owner, admin et project_manager écrivent (403 FORBIDDEN sinon).
//    Matrice à valider (décision produit ouverte).
//  * Routes à plat : /clients, /phases, /project-tasks. Phases et tâches portent `projectId` (obligatoire à la création, IMMUABLE
//    ensuite : déplacer une phase vers un autre projet n'a pas de sens) et se filtrent par `projectId` en lecture.
//  * Une tâche peut dépendre d'une phase DU MÊME projet (`phaseId`, modifiable, null = hors phase) ; une phase d'un autre projet
//    ou d'un autre compte donne 404 NOT_FOUND (params.entity = "phase").
//  * `position` ordonne les phases d'un projet et les tâches d'un projet (0..32767, sans unicité : l'ordre à égalité est celui de
//    l'id). Absente à la création, elle vaut la dernière position du projet + 1.
//  * Suppression refusée tant que des lignes y renvoient : client -> projets ; phase -> tâches, allocations, temps saisis, jalons ;
//    tâche -> allocations, temps saisis, lignes de budget. Il faut d'abord les réaffecter ou les supprimer.
//  * Pas de dates de phase contraintes par celles du projet (non imposé ici). Hors Schedule : ces entités ne sont PAS diffusées par le
//    temps réel (le journal ne couvre que les entités de la grille) ; un client qui les affiche les relit par REST.
//  * Jalons (/milestones) : une date d'échéance (`dueDate`) rattachée à un projet et, en option, à une phase DU MÊME projet (même règle
//    que les tâches : phase d'un autre projet ou compte -> 404 params.entity = phase). `projectId` est fixé à la création. Liste filtrable
//    par `projectId`, `phaseId` et par intervalle d'échéance `dueFrom`/`dueTo` (bornes incluses, indépendantes, pas de limite de durée ; intervalle inversé = liste vide),
//    paginée sur `id`. Aucune unicité (deux jalons peuvent porter le même nom et la même date). Suppression libre : rien n'y renvoie.
//    Pas de sens dans le Schedule ni dans le temps réel (les jalons ne sont pas dans le journal) ; un client les relit par REST.
//  * Hors périmètre : dépenses, lignes de budget, grilles de tarifs.

const name = z.string().min(1).max(200).regex(/\S/, "nom vide");
const noEmpty = (p: object) => Object.keys(p).length > 0;
const position = z.number().int().min(0).max(32767);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const tags = z.array(z.string().min(1).max(50).regex(/\S/)).max(50);
const datesOrdered = (p: { startDate?: string | null; endDate?: string | null }) => !p.startDate || !p.endDate || p.endDate >= p.startDate;
const datesIssue = { path: ["endDate"], message: "endDate < startDate" };

const pageOf = <T extends z.ZodType>(item: T, id: string) => z.object({ items: z.array(item), page: SchedulePage }).meta({ id });

// --- Clients ----------------------------------------------------------------------------------------------------------
export const Client = z
  .object({ id: Id, version: Version, name: z.string(), shortName: z.string().nullable(), tags: z.array(z.string()) })
  .meta({ id: "Client" });
const clientFields = { name, shortName: z.string().min(1).max(50).regex(/\S/).nullable().optional(), tags: tags.optional() };
export const ClientCreate = z.object(clientFields).meta({ id: "ClientCreate" });
export const ClientPatch = z.object(clientFields).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "ClientPatch" });
export const ClientList = pageOf(Client, "ClientList");

// --- Phases -----------------------------------------------------------------------------------------------------------
export const Phase = z
  .object({
    id: Id,
    version: Version,
    projectId: Id,
    name: z.string(),
    startDate: orNull(IsoDate),
    endDate: orNull(IsoDate),
    status: ScheduleProject.shape.status,
    color: z.string().nullable(),
    nonBillable: z.boolean(),
    notes: z.string().nullable(),
    position,
  })
  .meta({ id: "Phase" });
const phaseFields = {
  name,
  startDate: orNull(IsoDate).optional(),
  endDate: orNull(IsoDate).optional(),
  status: ScheduleProject.shape.status.optional().describe("Défaut planned"),
  color: color.nullable().optional().describe("null = couleur du projet"),
  nonBillable: z.boolean().optional(),
  notes: z.string().max(5000).nullable().optional(),
  position: position.optional().describe("Défaut : dernière position du projet + 1"),
};
export const PhaseCreate = z
  .object({ projectId: Id, ...phaseFields })
  .refine(datesOrdered, datesIssue)
  .meta({ id: "PhaseCreate" });
export const PhasePatch = z
  .object(phaseFields)
  .partial()
  .refine(noEmpty, { message: "corps vide" })
  .refine(datesOrdered, datesIssue)
  .meta({ id: "PhasePatch" });
export const PhaseListQuery = ReferenceListQuery.extend({ projectId: Id.optional().describe("Seulement les phases de ce projet") });
export const PhaseList = pageOf(Phase, "PhaseList");

// --- Tâches de projet -------------------------------------------------------------------------------------------------
export const ProjectTask = z
  .object({ id: Id, version: Version, projectId: Id, phaseId: orNull(Id), name: z.string(), billable: z.boolean(), position })
  .meta({ id: "ProjectTask" });
const taskFields = {
  name,
  phaseId: orNull(Id).optional().describe("Une phase du même projet ; null = hors phase"),
  billable: z.boolean().optional().describe("Défaut true"),
  position: position.optional().describe("Défaut : dernière position du projet + 1"),
};
export const ProjectTaskCreate = z.object({ projectId: Id, ...taskFields }).meta({ id: "ProjectTaskCreate" });
export const ProjectTaskPatch = z.object(taskFields).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "ProjectTaskPatch" });
export const ProjectTaskListQuery = ReferenceListQuery.extend({
  projectId: Id.optional().describe("Seulement les tâches de ce projet"),
  phaseId: Id.optional().describe("Seulement les tâches de cette phase"),
});
export const ProjectTaskList = pageOf(ProjectTask, "ProjectTaskList");

// --- Jalons -----------------------------------------------------------------------------------------------------------
export const Milestone = z
  .object({ id: Id, version: Version, projectId: Id, phaseId: orNull(Id), name: z.string(), dueDate: IsoDate })
  .meta({ id: "Milestone" });
const milestoneFields = {
  name,
  phaseId: orNull(Id).optional().describe("Une phase du même projet ; null = jalon du projet"),
  dueDate: IsoDate,
};
export const MilestoneCreate = z.object({ projectId: Id, ...milestoneFields }).meta({ id: "MilestoneCreate" });
export const MilestonePatch = z.object(milestoneFields).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "MilestonePatch" });
export const MilestoneListQuery = ReferenceListQuery.extend({
  projectId: Id.optional().describe("Seulement les jalons de ce projet"),
  phaseId: Id.optional().describe("Seulement les jalons de cette phase"),
  dueFrom: IsoDate.optional().describe("Échéance à partir de cette date (incluse)"),
  dueTo: IsoDate.optional().describe("Échéance jusqu'à cette date (incluse)"),
});
export const MilestoneList = pageOf(Milestone, "MilestoneList");

export type Client = z.infer<typeof Client>;
export type Milestone = z.infer<typeof Milestone>;
export type MilestoneCreate = z.infer<typeof MilestoneCreate>;
export type MilestonePatch = z.infer<typeof MilestonePatch>;
export type ClientCreate = z.infer<typeof ClientCreate>;
export type ClientPatch = z.infer<typeof ClientPatch>;
export type Phase = z.infer<typeof Phase>;
export type PhaseCreate = z.infer<typeof PhaseCreate>;
export type PhasePatch = z.infer<typeof PhasePatch>;
export type ProjectTask = z.infer<typeof ProjectTask>;
export type ProjectTaskCreate = z.infer<typeof ProjectTaskCreate>;
export type ProjectTaskPatch = z.infer<typeof ProjectTaskPatch>;
