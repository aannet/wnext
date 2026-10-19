// Moteur à l'échelle cible du Schedule (300 personnes x 12 mois, ADR-002 / ADR-005) : temps de calcul complet, une fois.
// Hors make check (mesure) : npm run perf:engine. Budgets larges (machine de CI plus lente), mesures notées dans le commit.
import { expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS, addDays, capacityCellsByPerson, expandOccurrences, layoutRow, utilization,
  type AllocationInput, type TimeoffInput,
} from "../../packages/engine/src/index";

const P = 300;
const FROM = "2026-01-05";
const TO = addDays(FROM, 364);

function dataset() {
  let s = 1;
  const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const people = Array.from({ length: P }, (_, i) => ({ id: String(i), active: true, workDaysHours: [8, 8, 8, 8, 8, 0, 0], country: i % 2 ? "FR" : "DE", departmentId: String(i % 5) }));
  const allocations: (AllocationInput & { id: string })[] = [];
  for (const p of people) {
    for (let d = 0; d < 360;) {
      const len = 1 + Math.floor(r() * 10);
      const weekly = r() < 0.05;
      allocations.push({
        id: String(allocations.length), personId: p.id, startDate: addDays(FROM, d), endDate: addDays(FROM, d + len - 1),
        mode: r() < 0.2 ? "percentage" : "hours", hoursPerDay: 4, percent: 50, status: r() < 0.1 ? "tentative" : "confirmed", billable: true,
        repeatState: weekly ? "weekly" : "none", repeatEndDate: weekly ? addDays(FROM, d + len + 60) : null,
        projectTentative: false, projectNonBillable: false, phaseNonBillable: false, taskBillable: null,
      });
      const a = allocations.at(-1)!;
      if (a.mode === "hours") a.percent = null; else a.hoursPerDay = null;
      d += len + Math.floor(r() * 3);
    }
  }
  const holidays = Array.from({ length: 22 }, (_, i) => ({ hdate: addDays(FROM, i * 16), country: i % 2 ? "FR" : "DE", departmentId: null, hoursOff: null }));
  const timeoffs: TimeoffInput[] = people.slice(0, 100).map((p, i) => ({
    personId: p.id, startDate: addDays(FROM, i), endDate: addDays(FROM, i + 4), scope: "full_day", startHalf: "am", endHalf: "pm",
    hoursPerDay: null, deducted: true, approvalStatus: "approved",
  }));
  return { people, allocations, holidays, timeoffs };
}

const time = <T,>(f: () => T): [T, number] => { const t = performance.now(); const v = f(); return [v, performance.now() - t]; };

it(`${P} personnes x 365 jours : utilisation, barres de capacité et layout dans le budget`, () => {
  const { people, allocations, holidays, timeoffs } = dataset();
  const [rows, tUtil] = time(() => utilization({ people, holidays, timeoffs, allocations, from: FROM, to: TO }));
  const [, tCells] = time(() => capacityCellsByPerson(rows, { from: FROM, to: TO }, "week", 1, DEFAULT_THRESHOLDS));
  const W1 = addDays(FROM, 100), W2 = addDays(FROM, 160);
  const byPerson = new Map<string, typeof allocations>();
  for (const a of allocations) (byPerson.get(a.personId) ?? byPerson.set(a.personId, []).get(a.personId)!).push(a);
  const [, tLayout] = time(() => {
    for (const p of people) {
      layoutRow((byPerson.get(p.id) ?? []).flatMap((a) =>
        expandOccurrences(a, W1, W2).map((o) => ({ id: `${a.id}:${o.index}`, startDate: o.startDate, endDate: o.endDate, fraction: 0.5 }))), W1, W2);
    }
  });
  console.log(`moteur à l'échelle : ${JSON.stringify({ allocations: allocations.length, rows: rows.length, utilizationMs: Math.round(tUtil), capacityCellsMs: Math.round(tCells), layout61DaysMs: Math.round(tLayout) })}`);
  expect(rows).toHaveLength(P * 365);
  expect(tUtil).toBeLessThan(400);
  expect(tCells).toBeLessThan(150);
  expect(tLayout).toBeLessThan(250);
}, 60_000);
