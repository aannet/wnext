// Données de démonstration locales (?demo=1, tests navigateur et banc) : 300 personnes, allocations pseudo-aléatoires à
// graine fixe. Jamais importé par l'API ; côté tests, par la mesure de défilement et par test/demo.test.ts.
// Charge réaliste (un tirage uniforme et indépendant empilait des blocs partout : lignes hautes et surcharges sur presque
// toutes les personnes) : chaque personne a un profil et un fil continu d'allocations bout à bout.
//  * ~6 % vides, ~8 % en surcharge (fil à 7-8 h plus des ajouts ponctuels), les autres chargées entre 60 et 100 %.
//  * Un bloc sur trois environ est partagé entre deux projets en parallèle (empilés, somme <= la journée : pas de surcharge).
//  * Une personne sur sept (dont la première) a une série hebdomadaire d'une journée (2 h), fil plafonné à 6 h.
import type { ScheduleResponse } from "@wnext/contracts";
import { addDays } from "@wnext/engine";

type Alloc = ScheduleResponse["allocations"][number];

export function demoSchedule(today: string, people = 300): ScheduleResponse {
  let seed = 7;
  const rnd = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  const colors = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#0EA5E9"];
  const projects = colors.map((color, i) => ({
    id: String(i + 1), version: 1, name: `Projet ${String.fromCharCode(65 + i)}`, projectCode: null, color,
    status: "in_progress" as const, nonBillable: false, startDate: null, endDate: null,
  }));
  const from = addDays(today, -180);
  const to = addDays(from, 364);
  const allocations: Alloc[] = [];
  const add = (personId: string, projectId: string, startDate: string, endDate: string, hoursPerDay: number, over: Partial<Alloc> = {}) => {
    allocations.push({
      id: String(allocations.length + 1), version: 1, personId, projectId, phaseId: null, taskId: null, groupId: null, name: null, notes: null,
      startDate, endDate, status: rnd(6) === 0 ? "tentative" : "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null,
      mode: "hours", hoursPerDay, percent: null, ...over,
    } as Alloc);
  };
  const clamp = (h: number, max: number) => Math.min(max, Math.max(1, h));

  for (let p = 1; p <= people; p++) {
    const id = String(p);
    const profile = rnd(100);
    if (p !== 1 && profile < 6) continue; // vide
    const overloaded = p !== 1 && profile < 14;
    const series = p % 7 === 1;
    const mine = [rnd(colors.length), rnd(colors.length), rnd(colors.length)].map((i) => String(i + 1));
    const max = series ? 6 : 8;
    const target = overloaded ? 8 : clamp(Math.round(8 * (0.6 + rnd(41) / 100)), max);
    if (series) {
      // Premier jour ouvré (lundi à vendredi) après le début de la fenêtre, puis chaque semaine.
      let d = addDays(from, rnd(7));
      while (new Date(`${d}T00:00:00Z`).getUTCDay() % 6 === 0) d = addDays(d, 1);
      add(id, mine[2]!, d, d, 2, { repeatState: "weekly", repeatEndDate: to, status: "confirmed" });
    }
    let cursor = from;
    while (cursor <= to) {
      const end = addDays(cursor, 3 + rnd(12));
      const h = overloaded ? 7 + rnd(2) : clamp(target + rnd(3) - 1, max);
      if (h >= 4 && rnd(3) === 0) {
        add(id, mine[0]!, cursor, end, Math.ceil(h / 2));
        add(id, mine[1]!, cursor, end, h - Math.ceil(h / 2));
      } else {
        add(id, mine[rnd(2)]!, cursor, end, h);
      }
      if (overloaded && rnd(2) === 0) add(id, mine[2]!, addDays(cursor, rnd(3)), addDays(cursor, 2 + rnd(3)), 2 + rnd(3));
      cursor = addDays(end, rnd(8) === 0 ? 2 + rnd(3) : 1);
    }
  }
  return {
    window: { from, to }, changeCursor: "0", page: { nextCursor: null, total: people },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: Array.from({ length: people }, (_, i) => ({
      id: String(i + 1), version: 1, name: `Personne ${i + 1}`, peopleType: "employee" as const, departmentId: null, roleId: null,
      country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
    })),
    allocations, timeoffs: [], holidays: [], projects, timeoffTypes: [], departments: [], roles: [],
  };
}
