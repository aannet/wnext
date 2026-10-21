// Modèle de la pop-in du créneau : brouillons (édition, création à 8 h par défaut), contrôles, patch des seuls champs changés
// (projet -> tâche remise à zéro, mode), corps de création (une personne ou groupe BR-26), droits BR-33, recherche sans accents,
// surcharge signalée (BR-01) et clés d'erreur traduites.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n";
import {
  canWriteProject, createBody, createDraft, editDraft, editPatch, projectOptions, searchOptions, slotErrorKey, slotIssues, slotOverloads,
} from "../src/schedule/slot-model";

type Alloc = ScheduleResponse["allocations"][number];
const alloc = (over: Partial<Alloc> = {}) => ({
  id: "a", version: 3, personId: "1", projectId: "1", phaseId: null, taskId: "t1", groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 8, percent: null, ...over,
}) as Alloc;
const data = (allocations: Alloc[]): ScheduleResponse => ({
  window: { from: "2025-10-01", to: "2027-10-01" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
  people: ["1", "2"].map((id) => ({ id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null,
    country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true })),
  allocations, timeoffs: [], holidays: [], timeoffTypes: [], departments: [], roles: [],
  projects: ["1", "2"].map((id) => ({ id, version: 1, name: `Projet ${id}`, projectCode: null, color: "#3B82F6", status: "in_progress" as const, nonBillable: false, startDate: null, endDate: null })),
});

describe("brouillons et contrôles", () => {
  it("création : une personne, 8 h par jour, confirmé, sans projet (à choisir)", () => {
    const d = createDraft("1", "2026-10-22", "2026-10-23");
    expect(d).toMatchObject({ allocationId: null, personIds: ["1"], hours: "8", mode: "hours", status: "confirmed", projectId: null });
    expect(slotIssues(d)).toEqual(["project"]);
  });

  it("contrôles : personne, dates, heures et pourcentage hors bornes ; édition à une seule personne ; fin de série", () => {
    expect(slotIssues({ ...createDraft(null, "2026-10-23", "2026-10-22", "1"), hours: "25" })).toEqual(["person", "dates", "hours"]);
    expect(slotIssues({ ...createDraft("1", "2026-10-22", "2026-10-22", "1"), mode: "percentage", percent: "0" })).toEqual(["percent"]);
    expect(slotIssues({ ...editDraft(alloc()), personIds: ["1", "2"] })).toEqual(["people"]);
    expect(slotIssues({ ...createDraft("1", "2026-10-22", "2026-10-22", "1"), personIds: ["1", "2"], hours: "7,5" })).toEqual([]);
    const series = alloc({ repeatState: "weekly", repeatEndDate: "2026-10-31" });
    expect(slotIssues({ ...editDraft(series), endDate: "2026-11-02" }, series)).toEqual(["dates"]);
  });
});

describe("patch d'édition", () => {
  it("seuls les champs changés ; changer de projet emporte la tâche choisie (ou null)", () => {
    const a = alloc();
    expect(editPatch(a, editDraft(a))).toEqual({});
    expect(editPatch(a, { ...editDraft(a), projectId: "2", taskId: null })).toEqual({ projectId: "2", taskId: null });
    expect(editPatch(a, { ...editDraft(a), taskId: "t2" })).toEqual({ taskId: "t2" });
    expect(editPatch(a, { ...editDraft(a), personIds: ["2"], status: "tentative", notes: "à confirmer", hours: "6" }))
      .toEqual({ personId: "2", status: "tentative", notes: "à confirmer", hoursPerDay: 6 });
  });

  it("changer de mode : mode, quantité du nouveau mode et l'autre à null ; une note vidée devient null", () => {
    const a = alloc({ notes: "x" });
    expect(editPatch(a, { ...editDraft(a), mode: "percentage", percent: "50", notes: " " })).toEqual({ mode: "percentage", percent: 50, hoursPerDay: null, notes: null });
  });
});

describe("création", () => {
  it("une personne : POST /allocations ; plusieurs : groupe BR-26 avec la charge commune", () => {
    const d = { ...createDraft("1", "2026-10-22", "2026-10-23", "2"), taskId: "t3" };
    expect(createBody(d)).toEqual({ kind: "one", body: { personId: "1", projectId: "2", taskId: "t3", startDate: "2026-10-22", endDate: "2026-10-23", status: "confirmed", load: { mode: "hours", hoursPerDay: 8 } } });
    expect(createBody({ ...d, personIds: ["1", "2"], status: "tentative" })).toEqual({
      kind: "group",
      body: { projectId: "2", taskId: "t3", startDate: "2026-10-22", endDate: "2026-10-23", status: "tentative", load: { mode: "hours", hoursPerDay: 8 }, members: [{ personId: "1" }, { personId: "2" }] },
    });
  });
});

describe("droits (BR-33) et référentiel", () => {
  const me = (role: "owner" | "admin" | "project_manager" | "member", person: string | null = "p9") => ({ role, person: person ? { id: person, name: "Moi" } : null });
  const list = [
    { id: "1", name: "Zèbre", status: "in_progress" as const, projectManagerId: "p9" },
    { id: "2", name: "Écluse", status: "planned" as const, projectManagerId: "p1" },
    { id: "3", name: "Archive", status: "archived" as const, projectManagerId: "p9" },
  ];

  it("owner et admin : tout ; project_manager : ses projets ; member : aucun ; sans profil : tout", () => {
    expect([me("owner"), me("admin"), me("project_manager"), me("member"), undefined].map((m) => list.filter((p) => canWriteProject(m, p)).map((p) => p.id)))
      .toEqual([["1", "2", "3"], ["1", "2", "3"], ["1", "3"], [], ["1", "2", "3"]]);
  });

  it("options : sans archivés, autorisées, triées ; le projet courant reste proposé", () => {
    expect(projectOptions(list, me("owner"), null).map((p) => p.name)).toEqual(["Écluse", "Zèbre"]);
    expect(projectOptions(list, me("project_manager"), "2").map((p) => p.id)).toEqual(["2", "1"]);
  });

  it("recherche sans casse ni accents", () => {
    expect(searchOptions(list, "ecl").map((p) => p.id)).toEqual(["2"]);
    expect(searchOptions(list, "  ").map((p) => p.id)).toEqual(["1", "2", "3"]);
  });
});

describe("surcharge (BR-01) et erreurs", () => {
  it("signalée pour chaque personne en dépassement, jamais pour celle qui reste sous sa capacité", () => {
    const s = data([alloc({ id: "x", personId: "1", hoursPerDay: 4 })]);
    const d = { ...createDraft("1", "2026-10-20", "2026-10-20", "2"), personIds: ["1", "2"], hours: "6" };
    expect(slotOverloads(s, d)).toEqual(["1"]);
    const a = alloc({ id: "x", personId: "1", hoursPerDay: 4 });
    expect(slotOverloads(s, { ...editDraft(a), hours: "8" }, a)).toEqual([]);
    expect(slotOverloads(s, { ...editDraft(a), hours: "9" }, a)).toEqual(["1"]);
  });

  it("codes stables traduits, jamais le texte de l'API", () => {
    const i18n = createI18n("fr");
    expect(i18n._(slotErrorKey("FORBIDDEN"))).toBe("Vous n’avez pas le droit d’écrire sur ce projet.");
    expect(slotErrorKey("TIMEOFF_OVERLAP")).toBe("schedule.slot.error.other");
    expect(createI18n("en")._(slotErrorKey("VERSION_CONFLICT"))).toMatch(/^Someone else changed/);
  });
});
