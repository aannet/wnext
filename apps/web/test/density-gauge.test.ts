// @vitest-environment jsdom
// Densité d'affichage (RT-005 à RT-007) et jauge par personne sur la période visible (RT-008, Q3) : hauteurs par densité,
// mémorisation locale tolérante, calcul de la jauge (sommes cumulées, état du moteur), texte et infobulle
// (rendu et scroller : gauge-render.test.ts).
import type { ScheduleResponse } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n";
import {
  DEFAULT_DENSITY, DENSITIES, DENSITY_METRICS, DENSITY_STORAGE_KEY, isDensity, readStoredDensity, storeDensity,
} from "../src/schedule/density";
import { gaugeLabeler } from "../src/schedule/gauge-label";
import { buildGrid, gaugeOf, initialsOf, type GridGauge } from "../src/schedule/grid-model";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string, name: string, extra: { roleId?: string; departmentId?: string } = {}) => ({
  id, version: 1, name, peopleType: "employee" as const, departmentId: extra.departmentId ?? null, roleId: extra.roleId ?? null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, personId: string, from: string, to: string, hoursPerDay: number, status: "confirmed" | "tentative" = "confirmed"): Alloc => ({
  id, version: 1, personId, projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: from, endDate: to, status, billable: true, priority: 0, repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay, percent: null,
} as Alloc);
// Semaine du lundi 2 mars 2026. Alice : 10 h lundi et mardi, 4 h mercredi (24 h sur 40). Bruno : rien.
const snap: ScheduleResponse = {
  window: { from: "2026-03-02", to: "2026-03-15" }, changeCursor: "0", page: { nextCursor: null, total: 2 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "UTC" },
  people: [person("1", "Alice Martin", { roleId: "r1", departmentId: "d1" }), person("2", "Bruno")],
  allocations: [alloc("1", "1", "2026-03-02", "2026-03-03", 10), alloc("2", "1", "2026-03-04", "2026-03-04", 4)],
  timeoffs: [], holidays: [],
  projects: [{ id: "10", version: 1, name: "Refonte", projectCode: null, color: "#3B82F6", status: "planned", nonBillable: false, startDate: null, endDate: null }],
  timeoffTypes: [], departments: [{ id: "d1", name: "Design" }], roles: [{ id: "r1", name: "Designer" }],
} as ScheduleResponse;
const range = { from: "2026-03-02", to: "2026-03-15" };

describe("densité : hauteurs fixes", () => {
  it("trois niveaux, défaut standard ; compacte = les dimensions d'avant le réglage (48 + 14 px)", () => {
    expect(DENSITIES).toEqual(["compact", "standard", "airy"]);
    expect(DEFAULT_DENSITY).toBe("standard");
    expect(DENSITY_METRICS.compact).toEqual({ rowUnitPx: 48, capPx: 14 });
  });

  it("~12 / ~8 / ~6 personnes entières dans la zone de lignes de l'écran de référence 1920 × 1080 (787 px mesurés)", () => {
    const visible = (zone: number) => DENSITIES.map((d) => Math.floor(zone / (DENSITY_METRICS[d].rowUnitPx + DENSITY_METRICS[d].capPx)));
    expect(visible(787)).toEqual([12, 8, 6]);
    // Marge : l'en-tête de la page peut gagner ou perdre ~40 px sans changer le compte.
    expect(visible(744)).toEqual([12, 8, 6]);
    expect(visible(805)).toEqual([12, 8, 6]);
  });

  it("chaque niveau grossit les blocs et la bande ; hauteur de bloc multiple de 8 (heure entière d'une journée de 8 h)", () => {
    const [c, s, a] = DENSITIES.map((d) => DENSITY_METRICS[d]);
    expect(c!.rowUnitPx < s!.rowUnitPx && s!.rowUnitPx < a!.rowUnitPx).toBe(true);
    expect(c!.capPx < s!.capPx && s!.capPx < a!.capPx).toBe(true);
    for (const d of DENSITIES) expect(DENSITY_METRICS[d].rowUnitPx % 8).toBe(0);
  });

  it("buildGrid suit la densité : hauteur de ligne, ordonnée de la bande, blocs ; le modèle porte ses hauteurs", () => {
    for (const d of DENSITIES) {
      const { rowUnitPx, capPx } = DENSITY_METRICS[d];
      const m = buildGrid(snap, range, 96, "day", DENSITY_METRICS[d]);
      expect([m.rowUnitPx, m.capPx]).toEqual([rowUnitPx, capPx]);
      const bruno = m.rows[1]!;
      expect([bruno.heightPx, bruno.capY, bruno.top]).toEqual([rowUnitPx + capPx, rowUnitPx, m.rows[0]!.heightPx]);
      expect(m.rows[0]!.blocks[0]!.y % 1).toBe(0);
    }
    expect(buildGrid(snap, range, 96).rowUnitPx).toBe(48); // défaut : compacte
  });

  it("isDensity n'accepte que les trois niveaux", () => {
    expect(["compact", "standard", "airy"].every(isDensity)).toBe(true);
    expect([null, undefined, "", "dense", 3].some(isDensity)).toBe(false);
  });
});

describe("densité : mémorisation locale", () => {
  const store = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

  it("écrite puis relue sous la clé dédiée", () => {
    const s = store();
    expect(readStoredDensity(s)).toBe("standard");
    storeDensity("airy", s);
    expect(s.m.get(DENSITY_STORAGE_KEY)).toBe("airy");
    expect(readStoredDensity(s)).toBe("airy");
  });

  it("valeur illisible, stockage absent ou qui lève (navigation privée, quota) : défaut, sans exception", () => {
    const s = store();
    s.m.set(DENSITY_STORAGE_KEY, "énorme");
    expect(readStoredDensity(s)).toBe("standard");
    expect(readStoredDensity(undefined)).toBe("standard");
    const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(readStoredDensity(broken)).toBe("standard");
    expect(() => storeDensity("compact", broken)).not.toThrow();
  });
});

describe("jauge : calcul sur une période", () => {
  const m = buildGrid(snap, range, 96, "day");
  const alice = m.rows[0]!;
  const gauge = (from: string, to: string, row = alice) => gaugeOf(row, { from, to }, m.thresholds);

  // RT-063 (D2) : lundi et mardi à 10 h dépassent leur capacité ; la semaine (60 %) passe en surcharge, +4 h sur deux jours.
  it("semaine : 24 h planifiées sur 40 h, 60 %, mais deux jours en surcharge : état over, +4 h (RT-063)", () => {
    expect(gauge("2026-03-02", "2026-03-08")).toEqual({
      from: "2026-03-02", to: "2026-03-08", plannedHours: 24, capacityHours: 40, overHours: 4, overDays: 2, percent: 60, state: "over", fill: 60,
    });
    expect(gauge("2026-03-04", "2026-03-08")).toMatchObject({ plannedHours: 4, capacityHours: 24, overDays: 0, state: "under" });
  });

  it("lundi et mardi : dépassement de 4 h, 125 %, barre pleine (bornée à 100)", () => {
    expect(gauge("2026-03-02", "2026-03-03")).toMatchObject({ plannedHours: 20, capacityHours: 16, overHours: 4, percent: 125, state: "over", fill: 100 });
  });

  it("week-end seul : ni capacité ni charge, pourcentage absent ; personne sans charge : 0 %", () => {
    expect(gauge("2026-03-07", "2026-03-08")).toMatchObject({ plannedHours: 0, capacityHours: 0, percent: null, state: "unavailable", fill: 0 });
    expect(gauge("2026-03-02", "2026-03-06", m.rows[1]!)).toMatchObject({ plannedHours: 0, capacityHours: 40, percent: 0, state: "under" });
  });

  it("période débordant des jours chargés : bornée à la tranche (l'infobulle dit la période réellement comptée) ; hors tranche : indisponible", () => {
    // 100 % sur la période, mais lundi et mardi en surcharge : over (RT-063 ; l'état « full » n'est plus affiché).
    expect(gauge("2026-02-20", "2026-03-04")).toMatchObject({ from: "2026-03-02", to: "2026-03-04", plannedHours: 24, capacityHours: 24, overDays: 2, state: "over" });
    expect(gauge("2026-04-01", "2026-04-10")).toMatchObject({ percent: null, state: "unavailable" });
  });

  it("identité de la ligne : initiales, rôle et département résolus ; vides s'ils manquent", () => {
    expect([alice.initials, alice.role, alice.department]).toEqual(["AM", "Designer", "Design"]);
    expect([m.rows[1]!.initials, m.rows[1]!.role, m.rows[1]!.department]).toEqual(["B", "", ""]);
    expect(["jean-paul  de la Tour", "  émile ", "Ünal Öz"].map(initialsOf)).toEqual(["JT", "É", "ÜÖ"]);
  });
});

describe("jauge : texte et infobulle (catalogue)", () => {
  const g = (over: Partial<GridGauge>): GridGauge => ({
    from: "2026-03-02", to: "2026-03-06", plannedHours: 24, capacityHours: 40, overHours: 0, overDays: 0, percent: 60, state: "under", fill: 60, ...over,
  });
  const fr = gaugeLabeler(createI18n("fr"));
  const en = gaugeLabeler(createI18n("en"));

  it("FR : pourcentage ; dépassement avec ▲ et « +N h » (redondance non chromatique) ; infobulle du … au …", () => {
    expect(fr(g({})).text).toMatch(/^60\s%$/);
    expect(fr(g({})).title).toBe("Du 2 mars au 6 mars : 24 h planifiées sur 40 h de capacité");
    expect(fr(g({ state: "over", percent: 125, overHours: 4, plannedHours: 20, capacityHours: 16 })).text).toMatch(/^▲ 125\s% \+4 h$/);
    expect(fr(g({ state: "over", percent: null, overHours: 3, plannedHours: 3, capacityHours: 0 })).text).toBe("▲ +3 h");
    expect(fr(g({ state: "unavailable", percent: null, plannedHours: 0, capacityHours: 0 })).text).toBe("—");
    expect(fr(g({ from: "2026-03-02", to: "2026-03-02" })).title).toBe("Le 2 mars : 24 h planifiées sur 40 h de capacité");
  });

  it("EN", () => {
    expect(en(g({})).text).toBe("60%");
    expect(en(g({})).title).toBe("Mar 2 to Mar 6: 24 h planned of 40 h capacity");
  });
});

