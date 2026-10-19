// Magasin client du Schedule : fusion des fenêtres, flux temps réel (références seules), mutations optimistes.
import type { Change, ScheduleResponse } from "@wnext/contracts";
import { scheduleUtilization } from "@wnext/engine";
import { describe, expect, it } from "vitest";
import {
  applyChanges, applyOptimistic, confirmOptimistic, emptyStore, hasWindow, ingestSchedule, rollbackOptimistic, snapshot, upsert,
} from "../src/schedule/store";

type Alloc = ScheduleResponse["allocations"][number];
const person = (id: string, version = 1, name = `P${id}`): ScheduleResponse["people"][number] => ({
  id, version, name, peopleType: "employee", departmentId: null, roleId: null, country: null,
  workDaysHours: [8, 8, 8, 8, 8, 0, 0], tags: [], avatarUrl: null, active: true,
});
const alloc = (id: string, version = 1, over: Partial<Alloc> = {}): Alloc => ({
  id, version, personId: "1", projectId: "10", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-03-02", endDate: "2026-03-04", status: "confirmed", billable: true, priority: 0,
  repeatState: "none", repeatEndDate: null, mode: "hours", hoursPerDay: 4, percent: null, ...over,
} as Alloc);
const project = { id: "10", version: 1, name: "Pr", projectCode: null, color: "#3B82F6", status: "planned" as const, nonBillable: false };

const page = (from: string, to: string, over: Partial<ScheduleResponse> = {}): ScheduleResponse => ({
  window: { from, to }, changeCursor: "5", page: { nextCursor: null, total: 1 },
  account: { weekStart: 1, capacityThresholds: { underPercent: 80 } },
  people: [person("1")], allocations: [], timeoffs: [], holidays: [], projects: [project], timeoffTypes: [], departments: [], roles: [],
  ...over,
});
const change = (entity: Change["entity"], id: string, op: Change["op"], version: number | null, seq = "1"): Change =>
  ({ seq, entity, id, op, version } as Change);

describe("fusion des fenêtres", () => {
  it("deux fenêtres se cumulent ; une entité vue dans les deux n'existe qu'une fois", () => {
    let s = ingestSchedule(emptyStore(), page("2026-03-02", "2026-03-29", { allocations: [alloc("100")] }));
    s = ingestSchedule(s, page("2026-03-30", "2026-04-26", { allocations: [alloc("100"), alloc("101", 1, { startDate: "2026-04-01", endDate: "2026-04-02" })] }));
    expect(s.tables.allocations.size).toBe(2);
    expect(hasWindow(s, { from: "2026-03-02", to: "2026-03-29" })).toBe(true);
    expect(hasWindow(s, { from: "2026-05-01", to: "2026-05-28" })).toBe(false);
  });

  it("une fenêtre en retard (version plus ancienne) ne fait jamais reculer l'état", () => {
    let s = ingestSchedule(emptyStore(), page("2026-03-02", "2026-03-29", { allocations: [alloc("100", 3, { hoursPerDay: 6 })] }));
    s = ingestSchedule(s, page("2026-03-02", "2026-03-29", { allocations: [alloc("100", 2, { hoursPerDay: 2 })] }));
    expect(s.tables.allocations.get("100")).toMatchObject({ version: 3, hoursPerDay: 6 });
  });
});

describe("flux temps réel", () => {
  const base = () => ingestSchedule(emptyStore(), page("2026-03-02", "2026-03-29", { allocations: [alloc("100", 2)] }));

  it("update plus récent : à recharger ; déjà connu (version <=) : rien", () => {
    const r = applyChanges(base(), [change("allocations", "100", "update", 3), change("allocations", "100", "update", 2)]);
    expect(r.refetch).toEqual([{ kind: "allocations", id: "100" }]);
    expect(applyChanges(base(), [change("allocations", "100", "update", 2)]).refetch).toEqual([]);
  });

  it("insert inconnu : à recharger ; doublons fusionnés", () => {
    const r = applyChanges(base(), [change("allocations", "200", "insert", 1), change("allocations", "200", "update", 2)]);
    expect(r.refetch).toEqual([{ kind: "allocations", id: "200" }]);
  });

  it("delete : retiré, et un chargement tardif ne le ressuscite pas", () => {
    const r = applyChanges(base(), [change("allocations", "100", "update", 3), change("allocations", "100", "delete", null)]);
    expect(r.refetch).toEqual([]); // supprimée après la modification : plus rien à recharger
    expect(r.store.tables.allocations.has("100")).toBe(false);
    const late = ingestSchedule(r.store, page("2026-03-02", "2026-03-29", { allocations: [alloc("100", 3)] }));
    expect(late.tables.allocations.has("100")).toBe(false);
    expect(upsert(late, "allocations", alloc("100", 9)).tables.allocations.has("100")).toBe(false);
  });

  it("entités hors Schedule rendues à l'appelant", () => {
    const r = applyChanges(base(), [change("phases", "7", "update", 2), change("project_team", "10", "update", 5)]);
    expect(r.other.map((c) => c.entity)).toEqual(["phases", "project_team"]);
    expect(r.refetch).toEqual([]);
  });
});

describe("mutations optimistes", () => {
  const base = () => ingestSchedule(emptyStore(), page("2026-03-02", "2026-03-29", { allocations: [alloc("100", 2)] }));

  it("modification : visible tout de suite, puis la version du serveur la remplace", () => {
    let s = applyOptimistic(base(), "m1", "allocations", "100", alloc("100", 2, { startDate: "2026-03-03" }));
    expect(s.tables.allocations.get("100")!.startDate).toBe("2026-03-03");
    s = confirmOptimistic(s, "m1", alloc("100", 3, { startDate: "2026-03-03" }));
    expect(s.tables.allocations.get("100")).toMatchObject({ version: 3, startDate: "2026-03-03" });
    expect(s.pending.size).toBe(0);
  });

  it("échec (409, réseau) : retour exact à l'état d'avant", () => {
    const before = base().tables.allocations.get("100");
    let s = applyOptimistic(base(), "m1", "allocations", "100", alloc("100", 2, { hoursPerDay: 8 }));
    s = rollbackOptimistic(s, "m1");
    expect(s.tables.allocations.get("100")).toEqual(before);
    expect(s.pending.size).toBe(0);
  });

  it("échec alors qu'une version serveur plus récente est déjà arrivée : on garde le serveur", () => {
    let s = applyOptimistic(base(), "m1", "allocations", "100", alloc("100", 2, { hoursPerDay: 8 }));
    s = upsert(s, "allocations", alloc("100", 4, { hoursPerDay: 1 })); // rechargée après un changement d'un autre client
    s = rollbackOptimistic(s, "m1");
    expect(s.tables.allocations.get("100")).toMatchObject({ version: 4, hoursPerDay: 1 });
  });

  it("création : id temporaire remplacé par celui du serveur ; échec : disparaît", () => {
    let s = applyOptimistic(base(), "m1", "allocations", "tmp-1", alloc("tmp-1", 1));
    expect(s.tables.allocations.has("tmp-1")).toBe(true);
    const ok = confirmOptimistic(s, "m1", alloc("300", 1));
    expect([...ok.tables.allocations.keys()].sort()).toEqual(["100", "300"]);
    expect(rollbackOptimistic(s, "m1").tables.allocations.has("tmp-1")).toBe(false);
  });

  it("suppression : disparaît tout de suite ; confirmée, pierre tombale ; refusée, revient", () => {
    let s = applyOptimistic(base(), "m1", "allocations", "100", null);
    expect(s.tables.allocations.has("100")).toBe(false);
    expect(rollbackOptimistic(s, "m1").tables.allocations.has("100")).toBe(true);
    s = confirmOptimistic(s, "m1", null);
    expect(s.tombstones.has("allocations:100")).toBe(true);
  });

  it("identifiant de mutation réutilisé : refusé ; confirmation inconnue : sans effet", () => {
    const s = applyOptimistic(base(), "m1", "allocations", "100", null);
    expect(() => applyOptimistic(s, "m1", "allocations", "100", null)).toThrow(/DUPLICATE_MUTATION/);
    expect(confirmOptimistic(s, "inconnue", null)).toBe(s);
    expect(rollbackOptimistic(s, "inconnue")).toBe(s);
  });
});

describe("snapshot -> moteur", () => {
  it("la vue d'une fenêtre alimente le moteur de capacité comme une réponse du serveur", () => {
    let s = ingestSchedule(emptyStore(), page("2026-03-02", "2026-03-29", {
      allocations: [alloc("100", 1, { hoursPerDay: 6 }), alloc("101", 1, { startDate: "2026-04-20", endDate: "2026-04-21" })],
    }));
    s = applyOptimistic(s, "m1", "allocations", "100", alloc("100", 1, { hoursPerDay: 10 }));
    const snap = snapshot(s, "2026-03-02", "2026-03-08");
    expect(snap.allocations.map((a) => a.id)).toEqual(["100"]); // 101 hors fenêtre
    const monday = scheduleUtilization(snap).find((r) => r.day === "2026-03-02")!;
    expect(monday).toMatchObject({ capacityHours: 8, plannedHours: 10, isOverbooked: true }); // l'optimiste compte déjà
  });

  it("magasin vide : refus explicite", () => {
    expect(() => snapshot(emptyStore(), "2026-03-02", "2026-03-08")).toThrow(/STORE_EMPTY/);
  });
});
