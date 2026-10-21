// Démo locale (?demo=1) : charge réaliste dans la vue initiale (zoom jour, 1600 px), pas de lignes hautes ni de surcharge
// partout. Régression : le tirage uniforme précédent donnait 250 lignes sur 300 en débordement sur la tranche chargée
// (hauteur moyenne 97 px au lieu de 62) et une charge moyenne de ~30 %.
import { chunkCover, neighborDays, viewAt, visibleRange } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import { demoSchedule } from "../src/demo";
import { buildGrid, CAP_PX, ROW_UNIT_PX } from "../src/schedule/grid-model";

const today = "2026-10-20";
const s = demoSchedule(today);
const v = viewAt(today, "day", 1600 - 32 - 140);
const g = buildGrid(s, chunkCover(v, 1, neighborDays(v)), v.pxPerDay, "day");
const seen = visibleRange(v);
const perPerson = g.rows.map((r) => {
  const cells = r.cells.filter((c) => c.from >= seen.from && c.to <= seen.to);
  const planned = cells.reduce((a, c) => a + c.plannedHours, 0);
  const capacity = cells.reduce((a, c) => a + c.capacityHours, 0);
  return { load: capacity ? planned / capacity : 0, over: cells.some((c) => c.state === "over") };
});
const share = (f: (x: (typeof perPerson)[number]) => boolean) => perPerson.filter(f).length / perPerson.length;

describe("demoSchedule", () => {
  it("vue initiale : la majorité des personnes entre 60 et 100 %, quelques-unes en surcharge, quelques-unes vides", () => {
    expect(share((x) => x.load >= 0.6 && x.load <= 1 && !x.over)).toBeGreaterThan(0.7);
    expect(share((x) => x.over)).toBeGreaterThan(0.03);
    expect(share((x) => x.over)).toBeLessThan(0.15);
    expect(share((x) => x.load === 0)).toBeGreaterThan(0.03);
    expect(share((x) => x.load === 0)).toBeLessThan(0.1);
  });

  it("lignes : hauteur d'une unité sauf surcharge (empilement > 100 % rare sur la tranche chargée)", () => {
    const base = ROW_UNIT_PX + CAP_PX;
    expect(g.rows.filter((r) => r.heightPx === base).length / g.rows.length).toBeGreaterThan(0.85);
    expect(g.rows.filter((r) => r.overflow).length / g.rows.length).toBeLessThan(0.15);
  });

  it("des blocs partagés entre deux projets (empilés sans surcharge), du tentatif et des séries hebdomadaires", () => {
    const stacked = g.rows.some((r) => !r.overflow && r.blocks.some((b) => b.y > 0));
    expect(stacked).toBe(true);
    expect(s.allocations.some((a) => a.status === "tentative")).toBe(true);
    const weekly = s.allocations.filter((a) => a.repeatState === "weekly");
    expect(weekly.length).toBeGreaterThan(30);
    expect(weekly.some((a) => a.personId === "3")).toBe(true);
    expect(weekly.some((a) => a.personId === "1")).toBe(false);
    expect(s.allocations.length).toBeLessThan(20_000); // ordre de grandeur du banc inchangé (12 000 auparavant)
  });

  it("congés : la semaine prochaine, une demi-journée, tous approuvés (RT-022), aucun pour la première personne ; rendus sur leur ligne", () => {
    expect(s.timeoffs.map((t) => t.personId)).toEqual(["2", "4", "5"]);
    expect(s.timeoffs.some((t) => t.startHalf === "pm" && t.startDate === t.endDate)).toBe(true);
    expect(s.timeoffs.every((t) => t.approvalStatus === "approved")).toBe(true);
    expect(s.timeoffs.every((t) => t.startDate > today && s.timeoffTypes.some((x) => x.id === t.typeId))).toBe(true);
    expect(g.rows[1]!.timeoffs).toHaveLength(1);
    expect(g.rows[0]!.timeoffs).toEqual([]);
  });

  it("horaire daté (@BR-19) : la personne 6 passe à 4 jours (vendredi chômé) lundi prochain ; la bande de capacité le suit", () => {
    const p6 = s.people[5]!;
    expect(p6.workDaysHours).toEqual([8, 8, 8, 8, 0, 0, 0]);
    expect(p6.workSchedule).toHaveLength(2);
    const monday = p6.workSchedule![1]!.validFrom!;
    expect(monday > today).toBe(true);
    const fridays = [-3, 4].map((d) => { const x = new Date(`${monday}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); });
    const row = g.rows.find((r) => r.personId === "6")!;
    expect(fridays.map((f) => row.cells.find((c) => c.from === f)?.capacityHours)).toEqual([8, 0]);
  });

  it("phases (@BR-37) : deux phases contiguës sur le projet A, ses allocations rattachées à la phase de leur début", () => {
    expect(s.phases!.map((p) => [p.projectId, p.name])).toEqual([["1", "Conception"], ["1", "Réalisation"]]);
    const [a, b] = s.phases!;
    const onA = s.allocations.filter((x) => x.projectId === "1");
    expect(onA.length).toBeGreaterThan(0);
    for (const x of onA) expect(x.phaseId).toBe(x.startDate <= a!.endDate! ? a!.id : b!.id);
    expect(s.allocations.filter((x) => x.projectId !== "1").every((x) => x.phaseId === null)).toBe(true);
  });
});
