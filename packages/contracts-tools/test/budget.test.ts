// Contrat des dépenses de projet et des lignes de budget.
import "../src/zod-setup";
import { describe, expect, it } from "vitest";
import {
  Money, ProjectBudgetLine, ProjectBudgetLineCreate, ProjectBudgetLineList, ProjectBudgetLineListQuery, ProjectBudgetLinePatch,
  ProjectExpense, ProjectExpenseCreate, ProjectExpenseList, ProjectExpenseListQuery, ProjectExpensePatch, routes,
} from "@wnext/contracts";
import { buildSpec } from "../src/openapi";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("montants", () => {
  it("chaînes décimales, 2 décimales au plus, jamais négatives ni flottantes", () => {
    for (const v of ["0", "12", "1250.5", "1250.50", "999999999999.99"]) expect(ok(Money, v), v).toBe(true);
    for (const v of ["", "-1", "1.234", "1e3", " 1", "1,5", "1000000000000", ".5", 12, null]) expect(ok(Money, v), String(v)).toBe(false);
  });
});

describe("dépenses", () => {
  const e = { projectId: "1", name: "Licences", amount: "1250.50" };
  it("création : projet, nom et montant ; devise ISO en majuscules ; date facultative et annulable", () => {
    expect(ok(ProjectExpenseCreate, e)).toBe(true);
    expect(ok(ProjectExpenseCreate, { ...e, currency: "EUR", spentOn: "2026-03-02" })).toBe(true);
    expect(ok(ProjectExpenseCreate, { ...e, spentOn: null })).toBe(true);
    for (const v of [{ name: "x", amount: "1" }, { projectId: "1", amount: "1" }, { projectId: "1", name: "x" }, { ...e, name: " " }, { ...e, amount: 12 }, { ...e, amount: "-5" }, { ...e, currency: "eur" }, { ...e, currency: "EURO" }, { ...e, spentOn: "2026-02-30" }]) {
      expect(ok(ProjectExpenseCreate, v), JSON.stringify(v)).toBe(false);
    }
  });
  it("patch : non vide, projet absent", () => {
    expect(ok(ProjectExpensePatch, {})).toBe(false);
    expect(ok(ProjectExpensePatch, { spentOn: null })).toBe(true);
    expect("projectId" in ProjectExpensePatch.parse({ projectId: "2", name: "x" })).toBe(false);
  });
  it("filtres et forme lue", () => {
    expect(ok(ProjectExpenseListQuery, { projectId: "1", spentFrom: "2026-01-01", spentTo: "2026-12-31", limit: 5 })).toBe(true);
    for (const v of [{ projectId: "" }, { spentFrom: "hier" }, { limit: 0 }]) expect(ok(ProjectExpenseListQuery, v), JSON.stringify(v)).toBe(false);
    const item = { id: "1", version: 1, projectId: "1", name: "x", amount: "1.00", currency: "USD", spentOn: null };
    expect(ok(ProjectExpense, item)).toBe(true);
    expect(ok(ProjectExpenseList, { items: [item], page: { nextCursor: null, total: 1 } })).toBe(true);
    expect(ok(ProjectExpense, { ...item, amount: 1 })).toBe(false);
  });
});

describe("lignes de budget", () => {
  const l = { projectId: "1", taskId: "2", hours: 40 };
  it("création : une cible exactement (tâche OU personne), au moins heures ou montant", () => {
    expect(ok(ProjectBudgetLineCreate, l)).toBe(true);
    expect(ok(ProjectBudgetLineCreate, { projectId: "1", personId: "3", amount: "5000.00" })).toBe(true);
    expect(ok(ProjectBudgetLineCreate, { ...l, amount: "100", hours: 0 })).toBe(true);
    for (const v of [
      { projectId: "1", hours: 4 }, { ...l, personId: "3" }, { projectId: "1", taskId: "2" }, { ...l, hours: -1 }, { ...l, hours: 4.123 },
      { ...l, hours: 100_000_000 }, { ...l, taskId: null }, { taskId: "2", hours: 4 }, { ...l, amount: 5 },
    ]) expect(ok(ProjectBudgetLineCreate, v), JSON.stringify(v)).toBe(false);
    expect(ok(ProjectBudgetLineCreate, { ...l, hours: 4.25 })).toBe(true);
  });
  it("patch : heures et montant seulement (cible immuable), null retire une valeur, non vide", () => {
    expect(ok(ProjectBudgetLinePatch, {})).toBe(false);
    expect(ok(ProjectBudgetLinePatch, { hours: null })).toBe(true);
    expect(ok(ProjectBudgetLinePatch, { amount: "12.5", hours: 3 })).toBe(true);
    expect(ok(ProjectBudgetLinePatch, { hours: 1.005 })).toBe(false);
    const parsed = ProjectBudgetLinePatch.parse({ taskId: "9", hours: 1 });
    expect("taskId" in parsed).toBe(false);
  });
  it("filtres et forme lue", () => {
    expect(ok(ProjectBudgetLineListQuery, { projectId: "1", taskId: "2", personId: "3" })).toBe(true);
    expect(ok(ProjectBudgetLineListQuery, { taskId: "" })).toBe(false);
    const item = { id: "1", version: 1, projectId: "1", taskId: "2", personId: null, hours: 40, amount: null };
    expect(ok(ProjectBudgetLine, item)).toBe(true);
    expect(ok(ProjectBudgetLine, { ...item, amount: "10.00" })).toBe(true);
    expect(ok(ProjectBudgetLineList, { items: [item], page: { nextCursor: null, total: 1 } })).toBe(true);
  });
});

describe("routes", () => {
  const byPath = (p: string) => routes.filter((r) => r.path.startsWith(p));
  it("dépenses et lignes : CRUD à plat ; la lecture documente 403 (données financières)", () => {
    for (const [p, ops] of [["/api/v1/project-expenses", "ProjectExpense"], ["/api/v1/project-budget-lines", "ProjectBudgetLine"]] as const) {
      const rs = byPath(p);
      expect(rs.map((r) => r.operationId).sort()).toEqual([`create${ops}`, `delete${ops}`, `get${ops}`, `list${ops}s`, `update${ops}`]);
      for (const r of rs) expect(r.responses[403], r.operationId).toBeDefined();
    }
  });
  it("lignes de budget : 409 d'unicité documenté à la création ; dépenses : aucun", () => {
    expect(routes.find((r) => r.operationId === "createProjectBudgetLine")!.responses[409]).toBeDefined();
    expect(routes.find((r) => r.operationId === "createProjectExpense")!.responses[409]).toBeUndefined();
  });
  it("les entités non financières gardent une lecture sans 403", () => {
    expect(routes.find((r) => r.operationId === "listMilestones")!.responses[403]).toBeUndefined();
    expect(routes.find((r) => r.operationId === "getPhase")!.responses[403]).toBeUndefined();
  });
  it("la spec contient les deux chemins", () => {
    const spec = buildSpec() as { paths: Record<string, unknown> };
    for (const p of ["/api/v1/project-expenses", "/api/v1/project-expenses/{id}", "/api/v1/project-budget-lines", "/api/v1/project-budget-lines/{id}"]) expect(spec.paths[p], p).toBeDefined();
  });
});
