// Contrat GET /api/v1/schedule (fenêtre du Schedule : personnes, allocations, congés, fériés, projets).
import { describe, expect, it } from "vitest";
import "../src/zod-setup"; // doit précéder @wnext/contracts (extension .openapi de Zod)
import { ErrorCode, ScheduleQuery, ScheduleResponse } from "@wnext/contracts";
import { buildSpec } from "../src/openapi";
import { generateClient } from "../src/client";

const spec = buildSpec() as any;
const op = spec.paths["/api/v1/schedule"]?.get;

const person = { id: "1", version: 3, name: "Alice", peopleType: "employee", departmentId: "10", roleId: null, country: "FR",
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: ["front"], avatarUrl: null, active: true };
const hoursAlloc = { id: "100", version: 1, personId: "1", projectId: "50", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-03-02", endDate: "2026-03-06", mode: "hours", hoursPerDay: 6, percent: null, status: "confirmed", billable: true,
  priority: 0, repeatState: "none", repeatEndDate: null };
const payload = {
  window: { from: "2026-03-01", to: "2026-03-31" },
  changeCursor: "000000000042",
  page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: [person],
  allocations: [hoursAlloc],
  timeoffs: [{ id: "7", version: 1, personId: "1", typeId: "2", startDate: "2026-03-10", endDate: "2026-03-11", scope: "full_day",
    startHalf: "am", endHalf: "pm", hoursPerDay: null, approvalStatus: "pending" }],
  holidays: [{ id: "9", version: 1, name: "Férié", date: "2026-03-17", country: "FR", departmentId: null, hoursOff: null }],
  projects: [{ id: "50", version: 1, name: "Site web", projectCode: null, color: "#3B82F6", status: "in_progress", nonBillable: false }],
  timeoffTypes: [{ id: "2", version: 1, name: "Vacances", deducted: true }],
  departments: [{ id: "10", version: 1, name: "Design" }],
  roles: [],
};
const without = (o: any, k: string) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

describe("route GET /api/v1/schedule", () => {
  it("est décrite avec ses paramètres de requête", () => {
    expect(op?.operationId).toBe("getSchedule");
    const byName = Object.fromEntries(op.parameters.map((p: any) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["cursor", "departmentId", "from", "includeInactive", "limit", "projectId", "roleId", "tag", "to"]);
    expect(byName.from.required).toBe(true);
    expect(byName.to.required).toBe(true);
    for (const n of ["cursor", "departmentId", "includeInactive", "limit", "projectId", "roleId", "tag"]) expect(byName[n].required).toBeFalsy();
    expect(byName.limit.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 500 });
  });
  it("répond 200 ScheduleResponse et 400/401/500 ApiError", () => {
    expect(op.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/ScheduleResponse");
    for (const c of ["400", "401", "500"]) expect(op.responses[c].content["application/json"].schema.$ref).toBe("#/components/schemas/ApiError");
  });
  it("codes d'erreur stables dédiés (jamais de texte)", () => {
    expect(ErrorCode.options).toEqual(expect.arrayContaining(["SCHEDULE_RANGE_INVALID", "SCHEDULE_CURSOR_INVALID"]));
  });
  it("le client généré expose getSchedule avec from/to requis", () => {
    const src = generateClient(spec);
    expect(src).toContain("Promise<ApiResult<ScheduleResponse, ApiError>>");
    expect(src).toMatch(/async getSchedule\(query: \{\s+from: string;\s+to: string;/);
  });
});

describe("requête", () => {
  it("accepte une fenêtre seule ; refuse l'absence de from/to, une date invalide, une limite hors bornes", () => {
    expect(ScheduleQuery.safeParse({ from: "2026-03-01", to: "2026-03-31" }).success).toBe(true);
    expect(ScheduleQuery.safeParse({ from: "2026-03-01" }).success).toBe(false);
    expect(ScheduleQuery.safeParse({ from: "2026-13-01", to: "2026-03-31" }).success).toBe(false);
    expect(ScheduleQuery.safeParse({ from: "2026-03-01", to: "2026-03-31", limit: 501 }).success).toBe(false);
    expect(ScheduleQuery.safeParse({ from: "2026-03-01", to: "2026-03-31", limit: 0 }).success).toBe(false);
  });
});

describe("réponse", () => {
  it("accepte une charge utile complète", () => {
    expect(ScheduleResponse.safeParse(payload).success).toBe(true);
  });
  it("work_days_hours : exactement 7 valeurs entre 0 et 24 (index 0 = lundi)", () => {
    for (const wdh of [[8, 8, 8, 8, 8, 0], [8, 8, 8, 8, 8, 0, 0, 0], [8, 8, 8, 8, 8, 0, 25], [8, 8, 8, 8, 8, 0, -1]]) {
      expect(ScheduleResponse.safeParse({ ...payload, people: [{ ...person, workDaysHours: wdh }] }).success).toBe(false);
    }
  });
  it("allocation : le mode impose son champ (heures/jour ou pourcentage)", () => {
    const pct = { ...hoursAlloc, mode: "percentage", hoursPerDay: null, percent: 150 };
    expect(ScheduleResponse.safeParse({ ...payload, allocations: [pct] }).success).toBe(true);
    expect(ScheduleResponse.safeParse({ ...payload, allocations: [{ ...hoursAlloc, hoursPerDay: null }] }).success).toBe(false);
    expect(ScheduleResponse.safeParse({ ...payload, allocations: [{ ...pct, percent: 501 }] }).success).toBe(false);
    expect(ScheduleResponse.safeParse({ ...payload, allocations: [{ ...pct, percent: null }] }).success).toBe(false);
  });
  it("énumérations fermées : statut, mode, répétition, type de personne", () => {
    expect(ScheduleResponse.safeParse({ ...payload, allocations: [{ ...hoursAlloc, status: "maybe" }] }).success).toBe(false);
    expect(ScheduleResponse.safeParse({ ...payload, allocations: [{ ...hoursAlloc, repeatState: "yearly" }] }).success).toBe(false);
    expect(ScheduleResponse.safeParse({ ...payload, people: [{ ...person, peopleType: "robot" }] }).success).toBe(false);
  });
  it("champs obligatoires : version (verrou optimiste), curseur de changement, pagination", () => {
    expect(ScheduleResponse.safeParse({ ...payload, people: [without(person, "version")] }).success).toBe(false);
    expect(ScheduleResponse.safeParse(without(payload, "changeCursor")).success).toBe(false);
    expect(ScheduleResponse.safeParse(without(payload, "page")).success).toBe(false);
  });
  it("aucune donnée de coût, de taux, de budget ni d'e-mail dans la réponse (pas de fuite vers un Member)", () => {
    const names = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
          if (k === "properties") Object.keys(v as object).forEach((n) => names.add(n));
          walk(v);
        }
      }
    };
    walk(spec.components.schemas.ScheduleResponse);
    for (const ref of Object.keys(spec.components.schemas)) if (ref.startsWith("Schedule")) walk(spec.components.schemas[ref]);
    expect(names.size).toBeGreaterThan(30); // garde-fou : on a bien parcouru le contrat
    for (const bad of ["costRate", "rate", "rates", "rateCardId", "budget", "budgetType", "budgetAmount", "email", "currencyCode"]) {
      expect(names.has(bad), bad).toBe(false);
    }
  });
});
