import { z } from "zod";
import { Id, IsoDate, Version, orNull } from "./common";
import { ReferenceListQuery } from "./reference";
import { SchedulePage } from "./schedule";

// Dépenses de projet et lignes de budget. Même mécanique que project-structure.ts : liste paginée par curseur sur `id`, lecture par id,
// écriture avec verrou optimiste (If-Match), 404 NOT_FOUND (params.entity) pour une référence hors compte, routes à plat.
//  * Droits. Ce sont des données FINANCIÈRES : lecture ET écriture réservées à owner, admin et project_manager (403 FORBIDDEN pour member
//    et guest, y compris en lecture, avant la validation de la requête). Matrice à valider (décision produit ouverte).
//  * Montants : chaînes décimales (`"1250.50"`, 12 chiffres entiers au plus, 2 décimales au plus, jamais négatives), jamais des flottants :
//    la valeur lue est toujours normalisée à 2 décimales. Les heures d'une ligne de budget sont un nombre (2 décimales au plus).
//  * Devise : code ISO 4217 à 3 majuscules ; absente à la création d'une dépense, elle vaut la devise du compte. Aucune conversion.
//  * Dépenses (/project-expenses) : `projectId` fixé à la création ; `spentOn` facultative (null = dépense prévue sans date).
//    Liste filtrable par `projectId` et par intervalle de date `spentFrom`/`spentTo` (bornes incluses ; les dépenses sans date en sont
//    exclues dès qu'une borne est donnée). Suppression libre, journalisée (delete_log, BR-14).
//  * Lignes de budget (/project-budget-lines) : une ligne vise UNE tâche du projet (`taskId`) OU UNE personne (`personId`), jamais les
//    deux ni aucune. La cible est fixée à la création (pour la changer : supprimer puis recréer). Une cible ne porte qu'une ligne par
//    projet (409 ALREADY_EXISTS, params.entity = budget_line). Au moins `hours` ou `amount` est renseigné ; PATCH modifie l'un ou
//    l'autre (null le retire) et refuse (400) un état sans valeur. Tâche d'un autre projet ou d'un autre compte : 404 (entity =
//    project_task) ; personne hors compte : 404 (entity = person). Pas besoin d'être dans l'équipe du projet.
//    Suppression libre.
//  * Le budget global du projet (type, baseline, répartition, burn : BR-22) n'est PAS dans ce contrat : seules les lignes le sont.
//  * Hors Schedule et hors temps réel (volontaire : données financières, voir ChangeEntity) : un client relit ces entités par REST.

const name = z.string().min(1).max(200).regex(/\S/, "nom vide");
const noEmpty = (p: object) => Object.keys(p).length > 0;

/** Montant décimal : 12 chiffres entiers et 2 décimales au plus, jamais négatif. */
export const Money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).describe('Montant décimal en chaîne, 2 décimales au plus : "1250.50"');
const Currency = z.string().regex(/^[A-Z]{3}$/).describe("Code ISO 4217 en majuscules");
const BudgetHours = z.number().min(0).max(99_999_999.99).refine((h) => Math.abs(h * 100 - Math.round(h * 100)) < 1e-6, { message: "2 décimales au plus" });
const pageOf = <T extends z.ZodType>(item: T, id: string) => z.object({ items: z.array(item), page: SchedulePage }).meta({ id });

// --- Dépenses ---------------------------------------------------------------------------------------------------------
export const ProjectExpense = z
  .object({ id: Id, version: Version, projectId: Id, name: z.string(), amount: Money, currency: z.string(), spentOn: orNull(IsoDate) })
  .meta({ id: "ProjectExpense" });
const expenseFields = {
  name,
  amount: Money,
  currency: Currency.optional().describe("Défaut : devise du compte"),
  spentOn: orNull(IsoDate).optional(),
};
export const ProjectExpenseCreate = z.object({ projectId: Id, ...expenseFields }).meta({ id: "ProjectExpenseCreate" });
export const ProjectExpensePatch = z.object(expenseFields).partial().refine(noEmpty, { message: "corps vide" }).meta({ id: "ProjectExpensePatch" });
export const ProjectExpenseListQuery = ReferenceListQuery.extend({
  projectId: Id.optional().describe("Seulement les dépenses de ce projet"),
  spentFrom: IsoDate.optional().describe("Dépensées à partir de cette date (incluse)"),
  spentTo: IsoDate.optional().describe("Dépensées jusqu'à cette date (incluse)"),
});
export const ProjectExpenseList = pageOf(ProjectExpense, "ProjectExpenseList");

// --- Lignes de budget -------------------------------------------------------------------------------------------------
export const ProjectBudgetLine = z
  .object({ id: Id, version: Version, projectId: Id, taskId: orNull(Id), personId: orNull(Id), hours: z.number().nullable(), amount: orNull(Money) })
  .meta({ id: "ProjectBudgetLine" });
export const ProjectBudgetLineCreate = z
  .object({
    projectId: Id,
    taskId: Id.optional().describe("Une tâche du projet (exclusif avec personId)"),
    personId: Id.optional().describe("Une personne (exclusif avec taskId)"),
    hours: BudgetHours.optional(),
    amount: Money.optional(),
  })
  .refine((l) => (l.taskId === undefined) !== (l.personId === undefined), { path: ["taskId"], message: "taskId ou personId, pas les deux" })
  .refine((l) => l.hours !== undefined || l.amount !== undefined, { path: ["hours"], message: "heures ou montant requis" })
  .meta({ id: "ProjectBudgetLineCreate" });
export const ProjectBudgetLinePatch = z
  .object({ hours: BudgetHours.nullable(), amount: Money.nullable() })
  .partial()
  .refine(noEmpty, { message: "corps vide" })
  .meta({ id: "ProjectBudgetLinePatch" });
export const ProjectBudgetLineListQuery = ReferenceListQuery.extend({
  projectId: Id.optional().describe("Seulement les lignes de ce projet"),
  taskId: Id.optional().describe("Seulement la ligne de cette tâche"),
  personId: Id.optional().describe("Seulement la ligne de cette personne"),
});
export const ProjectBudgetLineList = pageOf(ProjectBudgetLine, "ProjectBudgetLineList");

export type ProjectExpense = z.infer<typeof ProjectExpense>;
export type ProjectExpenseCreate = z.infer<typeof ProjectExpenseCreate>;
export type ProjectExpensePatch = z.infer<typeof ProjectExpensePatch>;
export type ProjectBudgetLine = z.infer<typeof ProjectBudgetLine>;
export type ProjectBudgetLineCreate = z.infer<typeof ProjectBudgetLineCreate>;
export type ProjectBudgetLinePatch = z.infer<typeof ProjectBudgetLinePatch>;
