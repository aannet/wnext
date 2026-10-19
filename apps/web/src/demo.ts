// Données de démonstration locales (npm run dev) : 300 personnes, allocations pseudo-aléatoires à graine fixe, en attendant
// le branchement sur GET /schedule (authentification OIDC requise). Jamais importé par les tests ni par l'API.
import type { ScheduleResponse } from "@wnext/contracts";
import { addDays } from "@wnext/engine";

export function demoSchedule(today: string, people = 300): ScheduleResponse {
  let seed = 7;
  const rnd = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  const colors = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#0EA5E9"];
  const projects = colors.map((color, i) => ({
    id: String(i + 1), version: 1, name: `Projet ${String.fromCharCode(65 + i)}`, projectCode: null, color,
    status: "in_progress" as const, nonBillable: false, startDate: null, endDate: null,
  }));
  const from = addDays(today, -180);
  const allocations: ScheduleResponse["allocations"] = [];
  for (let p = 1; p <= people; p++) {
    for (let k = 0; k < 40; k++) {
      const start = addDays(from, rnd(365));
      allocations.push({
        id: String(allocations.length + 1), version: 1, personId: String(p), projectId: String(rnd(colors.length) + 1),
        phaseId: null, taskId: null, groupId: null, name: null, notes: null, startDate: start, endDate: addDays(start, rnd(8)),
        status: rnd(5) === 0 ? "tentative" : "confirmed", billable: true, priority: 0, repeatState: "none", repeatEndDate: null,
        mode: "hours", hoursPerDay: [2, 4, 6, 8][rnd(4)]!, percent: null,
      });
    }
  }
  return {
    window: { from, to: addDays(from, 364) }, changeCursor: "0", page: { nextCursor: null, total: people },
    account: { weekStart: 1, capacityThresholds: { underPercent: 80 }, timezone: "Europe/Paris" },
    people: Array.from({ length: people }, (_, i) => ({
      id: String(i + 1), version: 1, name: `Personne ${i + 1}`, peopleType: "employee" as const, departmentId: null, roleId: null,
      country: null, workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
    })),
    allocations, timeoffs: [], holidays: [], projects, timeoffTypes: [], departments: [], roles: [],
  };
}
