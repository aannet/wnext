// Source de démonstration (?demo=1) : mêmes interfaces que la source branchée sur l'API, sans aucun appel réseau. Les gestes
// s'appliquent tout de suite au magasin local (version + 1), pour que l'écran et les futurs tests navigateur les exercent.
// Congés et allocations (record-edits) aussi ; le chevauchement de congés est refusé comme par l'API (TIMEOFF_OVERLAP).
// Aucun temps saisi en démo. Retrait d'un projet (BR-10) : récapitulatif et confirmation calculés localement (team-removal).
// Pop-in du créneau : changement de projet (le projet d'arrivée, connu de la démo, entre dans le magasin), groupe (BR-26 :
// une ligne par personne, même groupId ; « tout le groupe » : chaque ligne du groupe, version + 1).
import type { ScheduleResponse } from "@wnext/contracts";
import { emptyStore, ingestSchedule, remove, snapshot, upsert, type ScheduleStore } from "../schedule/store";
import { localSplit, patched, type EditOutcome } from "./allocation-edits";
import { allocationFromCreate, groupMembers, overlapsTimeoff, patchedTimeoff, timeoffFromCreate } from "./record-edits";
import type { ScheduleSource, ScheduleSourceState } from "./schedule-source";
import { localRemoval } from "./team-removal";

export function createDemoSource(initial: ScheduleResponse): ScheduleSource {
  let store: ScheduleStore = ingestSchedule(emptyStore(), initial);
  // Données initiales déjà passées par le magasin : même ordre des personnes qu'après une écriture (sinon la grille se
  // réordonne au premier geste).
  // Comme l'API, le planning n'expose que les personnes actives.
  const view = (): ScheduleResponse => {
    const d = snapshot(store, initial.window.from, initial.window.to);
    return d.people.every((p) => p.active) ? d : { ...d, people: d.people.filter((p) => p.active) };
  };
  let state: ScheduleSourceState = { data: view(), loading: false, error: null, realtime: "stopped" };
  const listeners = new Set<() => void>();
  const projectListeners = new Set<() => void>();
  const known = new Map(initial.projects.map((p) => [p.id, p] as const));
  let seq = 0;
  /** Projet d'une écriture absent du magasin (projet d'arrivée) : repris des projets connus de la démo. */
  const ensureProject = (id: string | undefined) => {
    const p = id === undefined ? undefined : known.get(id);
    if (p && !store.tables.projects.has(p.id)) store = upsert(store, "projects", { ...p });
  };
  const changed = (): EditOutcome => {
    state = { ...state, data: view() };
    for (const l of listeners) l();
    return { ok: true };
  };

  return {
    listProjects: async () => [...known.values()].map((p) => ({ id: p.id, name: p.name })),
    onProjectsChange: (l) => { projectListeners.add(l); return () => projectListeners.delete(l); },
    // Projet créé ou modifié depuis l'écran Projets : les blocs prennent la nouvelle couleur au retour sur le planning.
    projectChanged(p) {
      known.set(p.id, p);
      if (store.tables.projects.has(p.id)) { store = upsert(store, "projects", { ...p }); changed(); }
      for (const l of projectListeners) l();
    },
    // Personnes, équipes, rôles, types de congé et fériés écrits depuis Personnes ou Réglages : le planning les voit au retour.
    directoryChanged(kind, entity) {
      store = upsert(store, kind, { ...entity } as never);
      changed();
    },
    directoryRemoved(kind, id) {
      store = remove(store, kind, id);
      changed();
    },
    accountChanged(account) {
      store = { ...store, account };
      changed();
    },
    personDeactivated(personId, asOf, disposition, replacementId) {
      if (!disposition) return;
      for (const a of [...store.tables.allocations.values()]) {
        if (a.personId !== personId || (a.repeatEndDate ?? a.endDate) < asOf) continue;
        store = disposition === "delete" || !replacementId ? remove(store, "allocations", a.id) : upsert(store, "allocations", { ...a, personId: replacementId, version: a.version + 1 });
      }
      changed();
    },
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setViewport() {},
    onForeignChange: () => () => {}, // aucune autre source en démo
    start() {},
    stop() {},
    async updateAllocation(id, patch) {
      const a = store.tables.allocations.get(id);
      if (!a) return { ok: false, error: "NOT_FOUND" };
      ensureProject(patch.projectId);
      store = upsert(store, "allocations", { ...patched(a, patch), version: a.version + 1 });
      return changed();
    },
    async updateAllocationGroup(id, patch) {
      const g = store.tables.allocations.get(id)?.groupId;
      if (!g) return { ok: false, error: "NOT_FOUND" };
      ensureProject(patch.projectId);
      for (const a of [...store.tables.allocations.values()]) if (a.groupId === g) store = upsert(store, "allocations", { ...patched(a, patch), version: a.version + 1 });
      return changed();
    },
    async createTimeoff(body) {
      const t = timeoffFromCreate(body, `demo-${++seq}`, 1);
      if (overlapsTimeoff(store.tables.timeoffs.values(), t)) return { ok: false, error: "TIMEOFF_OVERLAP" };
      store = upsert(store, "timeoffs", t);
      changed();
      return { ok: true, id: t.id };
    },
    async updateTimeoff(id, patch) {
      const t = store.tables.timeoffs.get(id);
      if (!t) return { ok: false, error: "NOT_FOUND" };
      const next = { ...patchedTimeoff(t, patch), version: t.version + 1 };
      if (overlapsTimeoff(store.tables.timeoffs.values(), next)) return { ok: false, error: "TIMEOFF_OVERLAP" };
      store = upsert(store, "timeoffs", next);
      return changed();
    },
    async deleteTimeoff(id) {
      if (!store.tables.timeoffs.has(id)) return { ok: false, error: "NOT_FOUND" };
      store = remove(store, "timeoffs", id);
      return changed();
    },
    async createAllocation(body) {
      const a = allocationFromCreate(body, `demo-${++seq}`, 1);
      ensureProject(body.projectId);
      store = upsert(store, "allocations", a);
      changed();
      return { ok: true, id: a.id };
    },
    async createAllocationGroup(body) {
      const groupId = `demo-group-${++seq}`;
      ensureProject(body.projectId);
      const ids = groupMembers(body).map((m) => {
        const a = { ...allocationFromCreate(m, `demo-${++seq}`, 1), groupId };
        store = upsert(store, "allocations", a);
        return a.id;
      });
      changed();
      return { ok: true, ids };
    },
    async deleteAllocation(id) {
      if (!store.tables.allocations.has(id)) return { ok: false, error: "NOT_FOUND" };
      store = remove(store, "allocations", id);
      return changed();
    },
    loggedTime: async () => [],
    // BR-10 : même règle que l'API (moteur), sur les allocations locales ; ni temps saisi ni équipe en démo.
    async teamRemovalSummary(projectId, personId) {
      return { ok: true, summary: localRemoval(store.tables.allocations.values(), projectId, personId).summary };
    },
    async removeFromTeam(projectId, personId, confirmation) {
      const r = localRemoval(store.tables.allocations.values(), projectId, personId, confirmation);
      if (!r.outcome.ok) return r.outcome;
      for (const id of r.deleteIds) store = remove(store, "allocations", id);
      changed();
      return r.outcome;
    },
    async splitOccurrence(id, index, patch) {
      const a = store.tables.allocations.get(id);
      if (!a) return { ok: false, error: "NOT_FOUND" };
      const r = localSplit(a, index, patch, () => `demo-${++seq}`);
      if (!r.ok) return r;
      const { before, occurrence, after } = r.split;
      store = before ? upsert(store, "allocations", { ...before, version: a.version + 1 }) : remove(store, "allocations", id);
      store = upsert(store, "allocations", { ...occurrence, version: 1 });
      if (after) store = upsert(store, "allocations", { ...after, version: 1 });
      return changed();
    },
  };
}
