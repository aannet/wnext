// @vitest-environment jsdom
// Jauge de la colonne Personnes et surcharge journalière (RT-063, cadrage n°4 D2) : la jauge passe au rouge (état over) dès
// qu'un jour de la période affichée dépasse sa capacité (> 100 %, BR-38), même si la somme de la période reste sous 100 % ;
// « +N h » = somme des dépassements journaliers ; infobulle « N jours en surcharge » ; plus d'orange (100 % exact = ok).
// Jauge et bande de capacité d'une même ligne toujours d'accord.
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n";
import { gaugeLabeler } from "../src/schedule/gauge-label";
import { createGridRenderer } from "../src/schedule/grid-dom";
import { buildGrid, gaugeOf } from "../src/schedule/grid-model";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string) => ({
  id, version: 1, name: `P${id}`, peopleType: "employee" as const, departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, personId: string, from: string, to: string, hoursPerDay: number): Alloc => ({
  id, version: 1, personId, projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: from, endDate: to, status: "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay, percent: null,
} as Alloc);
// Semaine du lundi 2 mars 2026 (40 h de capacité).
//  * P1 : 9,6 h le lundi (120 %), 6,1 h du mardi au vendredi : 34 h sur 40 h (85 %), un seul jour en surcharge (+1,6 h).
//  * P2 : 8 h du lundi au vendredi : 100 % exact, aucun jour en surcharge.
//  * P3 : 10 h lundi et mardi (+2 h chacun), rien ensuite : 20 h sur 40 h (50 %), deux jours en surcharge (+4 h).
const snap = {
  window: { from: "2026-03-02", to: "2026-03-15" }, changeCursor: "0", page: { nextCursor: null, total: 3 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" },
  people: [person("1"), person("2"), person("3")],
  allocations: [
    alloc("a", "1", "2026-03-02", "2026-03-02", 9.6), alloc("b", "1", "2026-03-03", "2026-03-06", 6.1),
    alloc("c", "2", "2026-03-02", "2026-03-06", 8),
    alloc("d", "3", "2026-03-02", "2026-03-03", 10),
  ],
  timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [], roles: [],
} as unknown as ScheduleResponse;
const range = { from: "2026-03-02", to: "2026-03-15" };
const week = { from: "2026-03-02", to: "2026-03-08" };

describe("jauge : surcharge jour par jour (RT-063)", () => {
  const m = buildGrid(snap, range, 96, "day");
  const gauge = (i: number, p = week) => gaugeOf(m.rows[i]!, p, m.thresholds);

  it("85 % sur la semaine avec un jour à 120 % : état over, +1,6 h, un jour en surcharge", () => {
    expect(gauge(0)).toMatchObject({ plannedHours: 34, capacityHours: 40, percent: 85, state: "over", overHours: 1.6, overDays: 1, fill: 85 });
  });

  it("50 % sur la semaine avec deux jours à 125 % : over, « +N h » = somme des dépassements journaliers (+4 h)", () => {
    expect(gauge(2)).toMatchObject({ percent: 50, state: "over", overHours: 4, overDays: 2 });
  });

  it("100 % exact : plus d'état « full » (même rendu que ok) ; aucun jour en surcharge", () => {
    expect(gauge(1)).toMatchObject({ percent: 100, state: "ok", overHours: 0, overDays: 0 });
  });

  it("période sans le jour surchargé : la jauge ne le compte pas", () => {
    // Mardi au dimanche : 24,4 h sur 32 h (76 %), sous le seuil de sous-allocation.
    expect(gauge(0, { from: "2026-03-03", to: "2026-03-08" })).toMatchObject({ state: "under", overDays: 0, overHours: 0 });
  });

  it("jauge et bande de la même ligne d'accord : over dans la jauge si et seulement si une cellule visible est over", () => {
    for (const row of m.rows) {
      const cells = row.cells.filter((c) => c.from >= week.from && c.to <= week.to);
      expect(gaugeOf(row, week, m.thresholds).state === "over").toBe(cells.some((c) => c.state === "over"));
    }
  });

  it("rendu : classe wn-gauge-over, ▲ et +N h dans le texte, même si la somme reste sous 100 %", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    r.render(m, 0, 400, undefined, week);
    const g = root.querySelector<HTMLElement>(".wn-gauge")!;
    expect(g.className).toBe("wn-gauge wn-gauge-over");
    expect(g.querySelector(".wn-gauge-value")!.textContent).toBe("▲ 85 % +1.6 h");
    r.destroy();
  });
});

describe("jauge : infobulle « N jours en surcharge » (i18n)", () => {
  const m = buildGrid(snap, range, 96, "day");
  const g = (i: number) => gaugeOf(m.rows[i]!, week, m.thresholds);

  it("FR : texte ▲ et dépassement ; infobulle avec le nombre de jours en surcharge (accord au pluriel)", () => {
    const fr = gaugeLabeler(createI18n("fr"));
    expect(fr(g(0)).text).toMatch(/^▲ 85\s% \+1,6 h$/);
    expect(fr(g(0)).title).toBe("Du 2 mars au 8 mars : 34 h planifiées sur 40 h de capacité · 1 jour en surcharge");
    expect(fr(g(2)).title).toBe("Du 2 mars au 8 mars : 20 h planifiées sur 40 h de capacité · 2 jours en surcharge");
    expect(fr(g(1)).title).toBe("Du 2 mars au 8 mars : 40 h planifiées sur 40 h de capacité");
  });

  it("EN", () => {
    const en = gaugeLabeler(createI18n("en"));
    expect(en(g(0)).title).toBe("Mar 2 to Mar 8: 34 h planned of 40 h capacity · 1 day overbooked");
    expect(en(g(2)).title).toBe("Mar 2 to Mar 8: 20 h planned of 40 h capacity · 2 days overbooked");
  });
});
