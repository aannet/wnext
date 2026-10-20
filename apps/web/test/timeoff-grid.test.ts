// @vitest-environment jsdom
// Congés dans la grille du Schedule (BR-04) : fond par congé derrière les blocs, demi-journée en demi-cellule, rognage à la
// tranche, statut par motif, libellé accessible FR / EN ; la bande de capacité les déduit déjà.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n";
import { createGridRenderer } from "../src/schedule/grid-dom";
import { buildGrid, ROW_UNIT_PX, TIMEOFF_TONES, type GridTimeoff } from "../src/schedule/grid-model";
import { timeoffLabeler } from "../src/schedule/timeoff-label";

type Timeoff = ScheduleResponse["timeoffs"][number];
const person = (id: string) => ({
  id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const off = (id: string, over: Partial<Timeoff> = {}): Timeoff => ({
  id, version: 1, personId: "1", typeId: "t1", startDate: "2026-03-03", endDate: "2026-03-04", scope: "full_day", startHalf: "am", endHalf: "pm",
  hoursPerDay: null, approvalStatus: "approved", ...over,
});
const snap = (timeoffs: Timeoff[], allocations: ScheduleResponse["allocations"] = []): ScheduleResponse => ({
  window: { from: "2026-03-02", to: "2026-03-15" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" }, people: [person("1"), person("2")], allocations, timeoffs, holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [{ id: "t1", version: 1, name: "Congés payés", deducted: true }, { id: "t2", version: 1, name: "Formation", deducted: false }], departments: [], roles: [],
});
const range = { from: "2026-03-02", to: "2026-03-15" };

describe("congés du modèle", () => {
  it("un fond par congé sur la ligne de sa personne, sur toute la hauteur des blocs, nom et teinte du type", () => {
    const g = buildGrid(snap([off("o1")]), range, 40);
    expect(g.rows[0]!.timeoffs).toEqual([expect.objectContaining({
      key: "o1", timeoffId: "o1", x: 40, w: 80, h: ROW_UNIT_PX, typeName: "Congés payés", status: "approved", startDate: "2026-03-03", endDate: "2026-03-04",
    })]);
    expect(g.rows[1]!.timeoffs).toEqual([]);
    const tone = g.rows[0]!.timeoffs[0]!.tone;
    expect(tone).toBeGreaterThanOrEqual(0);
    expect(tone).toBeLessThan(TIMEOFF_TONES);
  });
  it("demi-journées : l'après-midi commence au milieu du jour, le matin finit au milieu", () => {
    const g = buildGrid(snap([off("pm", { startHalf: "pm" }), off("am", { startDate: "2026-03-06", endDate: "2026-03-06", endHalf: "am" })]), range, 40);
    const [a, b] = g.rows[0]!.timeoffs;
    expect([a!.x, a!.w]).toEqual([60, 60]);
    expect([b!.x, b!.w]).toEqual([160, 20]);
  });
  it("rogné à la tranche (les demi-journées hors tranche ne décalent rien), type inconnu sans nom, statut transporté", () => {
    const g = buildGrid(snap([off("o", { startDate: "2026-02-20", startHalf: "pm", endDate: "2026-03-20", endHalf: "am", typeId: "zz", approvalStatus: "pending" })]), range, 10);
    expect(g.rows[0]!.timeoffs[0]).toMatchObject({ x: 0, w: 140, typeName: "", status: "pending" });
    expect(buildGrid(snap([off("o", { startDate: "2026-04-01", endDate: "2026-04-02" })]), range, 10).rows[0]!.timeoffs).toEqual([]);
  });
});

describe("congés dans le DOM", () => {
  const label = timeoffLabeler(createI18n("fr"));
  it("nœud focalisable sous les blocs, classes de teinte et de statut, libellé ; recyclé ; timeoffAt", () => {
    const alloc = { id: "a", version: 1, personId: "1", projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
      startDate: "2026-03-03", endDate: "2026-03-03", status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null,
      mode: "hours", hoursPerDay: 8, percent: null } as ScheduleResponse["allocations"][number];
    const root = document.createElement("div");
    const r = createGridRenderer(root, { timeoffLabel: label });
    const g = buildGrid(snap([off("o1", { approvalStatus: "pending" })], [alloc]), range, 40);
    r.render(g, 0, 400);
    const el = root.querySelector<HTMLElement>('[data-timeoff="o1"]')!;
    expect(el.getAttribute("role")).toBe("gridcell");
    expect(el.tabIndex).toBe(-1);
    expect(el.classList.contains("wn-timeoff-pending")).toBe(true);
    expect(el.className).toMatch(/wn-timeoff-tone-\d/);
    expect([el.style.transform, el.style.width, el.style.height]).toEqual(["translate(40px, 0px)", "80px", `${ROW_UNIT_PX}px`]);
    expect(el.textContent).toBe("Congés payés");
    expect(el.getAttribute("aria-label")).toBe("Congés payés, du mar. 3 mars au mer. 4 mars, en attente");
    // Dessous : avant le bloc dans l'ordre du document.
    const block = root.querySelector<HTMLElement>(".wn-block[data-key]")!;
    expect(el.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(r.timeoffAt(el)?.timeoff.timeoffId).toBe("o1");
    expect(r.timeoffAt(block)).toBeNull();
    r.render(buildGrid(snap([off("o1", { endDate: "2026-03-05" })], [alloc]), range, 40), 0, 400);
    expect(root.querySelector('[data-timeoff="o1"]')).toBe(el);
    expect([el.style.width, el.classList.contains("wn-timeoff-pending")]).toEqual(["120px", false]);
    r.render(buildGrid(snap([]), range, 40), 0, 400);
    expect(root.querySelector('[data-timeoff="o1"]')).toBeNull();
  });
});

describe("libellé d'un congé", () => {
  const t = (over: Partial<GridTimeoff> = {}) => ({
    typeName: "Congés payés", startDate: "2026-10-19", endDate: "2026-10-21", startHalf: "am" as const, endHalf: "pm" as const,
    status: "approved" as const, scope: "full_day" as const, hoursPerDay: null, ...over,
  });
  it("FR : plage, demi-journées, jour seul, partiel, refusé, type inconnu", () => {
    const l = timeoffLabeler(createI18n("fr"));
    expect(l(t())).toBe("Congés payés, du lun. 19 oct. au mer. 21 oct.");
    expect(l(t({ startHalf: "pm", endHalf: "am" }))).toBe("Congés payés, du lun. 19 oct. (après-midi) au mer. 21 oct. (matin)");
    expect(l(t({ endDate: "2026-10-19", endHalf: "am" }))).toBe("Congés payés, le lun. 19 oct. (matin)");
    expect(l(t({ endDate: "2026-10-19", scope: "partial", hoursPerDay: 2, status: "declined", typeName: "" }))).toBe("Congé, le lun. 19 oct., 2 h par jour, refusé");
  });
  it("EN", () => {
    const l = timeoffLabeler(createI18n("en"));
    expect(l(t({ startDate: "2026-10-19", endDate: "2026-10-19", startHalf: "pm", status: "pending" }))).toBe("Congés payés, Mon, Oct 19 (afternoon), pending");
  });
});

describe("bande de capacité et congés", () => {
  it("la capacité du jour déduit le congé (journée entière, demi-journée) ; un type non déduit ne change rien", () => {
    const g = buildGrid(snap([off("full", { endDate: "2026-03-03" }), off("half", { startDate: "2026-03-05", endDate: "2026-03-05", endHalf: "am" }),
      off("nd", { startDate: "2026-03-06", endDate: "2026-03-06", typeId: "t2" })]), range, 10, "day");
    const cap = (d: string) => g.rows[0]!.cells.find((c) => c.from === d)!.capacityHours;
    expect([cap("2026-03-02"), cap("2026-03-03"), cap("2026-03-05"), cap("2026-03-06")]).toEqual([8, 0, 4, 8]);
  });
});
