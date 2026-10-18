import type { ProjectBudgetLine, ProjectBudgetLineCreate, ProjectBudgetLinePatch, ProjectExpense, ProjectExpenseCreate, ProjectExpensePatch } from "@wnext/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "./db";
import { ApiFailure } from "./failure";
import { reader, remove } from "./reference";
import type { Row } from "./schedule";
import { assertWriter, day, idParam, invalid, isId, lockAndCheck, notFound } from "./write";

// Dépenses de projet et lignes de budget (contrat : packages/contracts/src/budget.ts). Données FINANCIÈRES : owner, admin et
// project_manager lisent ET écrivent (garde ici en plus de la couche HTTP). Même mécanique que project-structure.ts (verrou
// optimiste, RLS + account_id). Montants en NUMERIC(14,2) lus comme chaînes à 2 décimales, jamais en flottant.
// Ces tables ne sont pas dans le journal temps réel. Les dépenses sont journalisées à la suppression (delete_log), pas les lignes de budget.

const idOf = (v: unknown) => String(v);
const orNullId = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** NUMERIC -> chaîne à 2 décimales ("12" -> "12.00"), sans passer par un flottant. */
const money = (v: unknown): string => {
  const [int, frac = ""] = String(v).split(".");
  return `${int}.${frac.padEnd(2, "0").slice(0, 2)}`;
};
const orNullMoney = (v: unknown) => (v === null || v === undefined ? null : money(v));

async function assertProject(tx: Queryable, accountId: string, id: string) {
  if (!isId(id) || !(await tx.query("SELECT 1 FROM projects WHERE id = $1::bigint AND account_id = $2::bigint", [id, accountId])).rows.length) throw notFound("project");
}

/** 23503 (la référence a disparu entre la vérification et l'écriture) -> 404 ; 23505 -> ALREADY_EXISTS ; 23514/22003/22P02 (CHECK, hors bornes) -> 400. */
function translate(reference: string, unique?: string): (err: unknown) => never {
  return (err) => {
    const code = (err as { code?: string })?.code;
    if (code === "23503") throw notFound(reference);
    if (code === "23505" && unique) throw new ApiFailure("ALREADY_EXISTS", { entity: unique });
    if (code === "23514" || code === "22003") throw invalid("body");
    throw err;
  };
}

// --- Dépenses ---------------------------------------------------------------------------------------------------------
export const EXPENSE_COLUMNS = "id, row_version, project_id, name, amount, currency, spent_on";
const toExpense = (r: Row): ProjectExpense => ({
  id: idOf(r.id), version: Number(r.row_version), projectId: idOf(r.project_id), name: String(r.name), amount: money(r.amount), currency: String(r.currency).trim(),
  spentOn: r.spent_on === null || r.spent_on === undefined ? null : day(r.spent_on),
});
const failExpense = translate("project");

export async function createExpense(db: Db, ctx: RequestContext, body: ProjectExpenseCreate): Promise<ProjectExpense> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertProject(tx, ctx.accountId, body.projectId);
    const { rows } = await tx.query<Row>(
      `INSERT INTO project_expenses (account_id, project_id, name, amount, currency, spent_on)
       VALUES ($1::bigint, $2::bigint, $3, $4::numeric, COALESCE($5, (SELECT currency_code FROM accounts WHERE id = $1::bigint)), $6::date) RETURNING ${EXPENSE_COLUMNS}`,
      [ctx.accountId, body.projectId, body.name, body.amount, body.currency ?? null, body.spentOn ?? null],
    ).catch(failExpense);
    return toExpense(rows[0]!);
  });
}

export async function updateExpense(db: Db, ctx: RequestContext, id: string, expected: number, patch: ProjectExpensePatch): Promise<ProjectExpense> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "project_expenses", EXPENSE_COLUMNS, "project_expense", ctx.accountId, id, expected);
    const { rows } = await tx.query<Row>(
      `UPDATE project_expenses SET name = $3, amount = $4::numeric, currency = $5, spent_on = $6::date
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $7::int RETURNING ${EXPENSE_COLUMNS}`,
      [id, ctx.accountId, patch.name ?? cur.name, patch.amount ?? money(cur.amount), patch.currency ?? String(cur.currency).trim(), patch.spentOn !== undefined ? patch.spentOn : cur.spent_on === null ? null : day(cur.spent_on), expected],
    ).catch(failExpense);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toExpense(rows[0]);
  });
}

export const deleteExpense = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, { table: "project_expenses", entity: "project_expense", columns: EXPENSE_COLUMNS, writers: true, dependents: {} }, id, expected);

export const expenseReader = reader({
  restricted: true, table: "project_expenses", columns: EXPENSE_COLUMNS, entity: "project_expense", map: toExpense,
  filters: (q, bind) => [
    ...(q.projectId ? [`project_id = ${bind(idParam("projectId", q.projectId))}::bigint`] : []),
    ...(q.spentFrom ? [`spent_on >= ${bind(q.spentFrom)}::date`] : []),
    ...(q.spentTo ? [`spent_on <= ${bind(q.spentTo)}::date`] : []),
  ],
});

// --- Lignes de budget -------------------------------------------------------------------------------------------------
export const BUDGET_LINE_COLUMNS = "id, row_version, project_id, project_task_id, person_id, hours, amount";
const toBudgetLine = (r: Row): ProjectBudgetLine => ({
  id: idOf(r.id), version: Number(r.row_version), projectId: idOf(r.project_id), taskId: orNullId(r.project_task_id), personId: orNullId(r.person_id),
  hours: r.hours === null || r.hours === undefined ? null : Number(r.hours), amount: orNullMoney(r.amount),
});
const failLine = translate("project_task", "budget_line");

export async function createBudgetLine(db: Db, ctx: RequestContext, body: ProjectBudgetLineCreate): Promise<ProjectBudgetLine> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    await assertProject(tx, ctx.accountId, body.projectId);
    if (body.taskId !== undefined && (!isId(body.taskId) || !(await tx.query("SELECT 1 FROM project_tasks WHERE id = $1::bigint AND project_id = $2::bigint AND account_id = $3::bigint", [body.taskId, body.projectId, ctx.accountId])).rows.length)) throw notFound("project_task");
    if (body.personId !== undefined && (!isId(body.personId) || !(await tx.query("SELECT 1 FROM people WHERE id = $1::bigint AND account_id = $2::bigint", [body.personId, ctx.accountId])).rows.length)) throw notFound("person");
    const { rows } = await tx.query<Row>(
      `INSERT INTO project_budget_lines (account_id, project_id, project_task_id, person_id, hours, amount)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::numeric, $6::numeric) RETURNING ${BUDGET_LINE_COLUMNS}`,
      [ctx.accountId, body.projectId, body.taskId ?? null, body.personId ?? null, body.hours ?? null, body.amount ?? null],
    ).catch(failLine);
    return toBudgetLine(rows[0]!);
  });
}

export async function updateBudgetLine(db: Db, ctx: RequestContext, id: string, expected: number, patch: ProjectBudgetLinePatch): Promise<ProjectBudgetLine> {
  assertWriter(ctx);
  return withContext(db, ctx, async (tx) => {
    const cur = await lockAndCheck(tx, "project_budget_lines", BUDGET_LINE_COLUMNS, "project_budget_line", ctx.accountId, id, expected);
    const hours = patch.hours !== undefined ? patch.hours : cur.hours === null ? null : Number(cur.hours);
    const amount = patch.amount !== undefined ? patch.amount : orNullMoney(cur.amount);
    if (hours === null && amount === null) throw invalid("hours"); // état résultant : une ligne garde au moins une valeur
    const { rows } = await tx.query<Row>(
      `UPDATE project_budget_lines SET hours = $3::numeric, amount = $4::numeric
        WHERE id = $1::bigint AND account_id = $2::bigint AND row_version = $5::int RETURNING ${BUDGET_LINE_COLUMNS}`,
      [id, ctx.accountId, hours, amount, expected],
    ).catch(failLine);
    if (!rows[0]) throw new ApiFailure("VERSION_CONFLICT", { currentVersion: Number(cur.row_version) + 1 });
    return toBudgetLine(rows[0]);
  });
}

export const deleteBudgetLine = (db: Db, ctx: RequestContext, id: string, expected: number) =>
  remove(db, ctx, { table: "project_budget_lines", entity: "project_budget_line", columns: BUDGET_LINE_COLUMNS, writers: true, dependents: {} }, id, expected);

export const budgetLineReader = reader({
  restricted: true, table: "project_budget_lines", columns: BUDGET_LINE_COLUMNS, entity: "project_budget_line", map: toBudgetLine,
  filters: (q, bind) => [
    ...(q.projectId ? [`project_id = ${bind(idParam("projectId", q.projectId))}::bigint`] : []),
    ...(q.taskId ? [`project_task_id = ${bind(idParam("taskId", q.taskId))}::bigint`] : []),
    ...(q.personId ? [`person_id = ${bind(idParam("personId", q.personId))}::bigint`] : []),
  ],
});
