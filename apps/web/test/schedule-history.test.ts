// Historique d'annulation de l'écran (BR-40, ADR-001 §9) : enregistrement des écritures réussies, undo / redo par le même
// chemin d'écriture, abandon sur conflit, invalidation ciblée, limite, découpe non annulable, API record (lot E).
import type { ScheduleResponse } from "@wnext/contracts";
import type { BlockPatch } from "@wnext/engine";
import { describe, expect, it, vi } from "vitest";
import { patched, type EditOutcome, type GroupEditOutcome, type ScheduleEditor } from "../src/data/allocation-edits";
import { createHistory, labelOf } from "../src/schedule/history";

type Alloc = ScheduleResponse["allocations"][number];
const alloc = (id: string, over: Partial<Alloc> = {}) => ({
  id, version: 1, personId: "1", projectId: "1", phaseId: null, taskId: null, groupId: null, name: null, notes: null,
  startDate: "2026-10-20", endDate: "2026-10-21", status: "confirmed" as const, billable: true, priority: 0,
  repeatState: "none" as const, repeatEndDate: null, mode: "hours" as const, hoursPerDay: 4, percent: null, ...over,
}) as Alloc;

/** Éditeur en mémoire : applique le patch (version + 1), ou rend le résultat forcé du prochain appel. */
function memoryEditor(initial: Alloc[]) {
  const rows = new Map(initial.map((a) => [a.id, a]));
  const forced: EditOutcome[] = [];
  const editor = {
    updateAllocation: vi.fn(async (id: string, patch: BlockPatch): Promise<EditOutcome> => {
      const f = forced.shift();
      if (f) return f;
      const a = rows.get(id);
      if (!a) return { ok: false, error: "NOT_FOUND" };
      rows.set(id, { ...patched(a, patch), version: a.version + 1 });
      return { ok: true };
    }),
    splitOccurrence: vi.fn(async (): Promise<EditOutcome> => ({ ok: true })),
  } satisfies ScheduleEditor;
  return { editor, rows, force: (o: EditOutcome) => forced.push(o), read: (id: string) => rows.get(id) };
}

function setup(initial: Alloc[] = [alloc("1"), alloc("2", { personId: "2" })], limit?: number) {
  const m = memoryEditor(initial);
  const h = createHistory({ editor: m.editor, read: m.read, now: () => 1000, limit });
  return { ...m, h };
}

describe("libellé d'une écriture", () => {
  it("déplacement, redimensionnement, charge", () => {
    expect(labelOf({ startDate: "2026-10-22", endDate: "2026-10-23" }, alloc("1"))).toBe("allocation.move");
    expect(labelOf({ personId: "2" }, alloc("1"))).toBe("allocation.move");
    expect(labelOf({ endDate: "2026-10-23" }, alloc("1"))).toBe("allocation.resize");
    expect(labelOf({ startDate: "2026-10-19", endDate: "2026-10-21" }, alloc("1"))).toBe("allocation.resize");
    expect(labelOf({ hoursPerDay: 6 }, alloc("1"))).toBe("allocation.load");
  });
});

describe("enregistrement", () => {
  it("une écriture réussie devient une action ; un échec n'est pas enregistré", async () => {
    const t = setup();
    expect(t.h.getState()).toEqual({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
    t.force({ ok: false, error: "NETWORK" });
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    expect(t.h.getState().canUndo).toBe(false);
    expect(await t.h.editor.updateAllocation("1", { startDate: "2026-10-22", endDate: "2026-10-23" })).toEqual({ ok: true });
    expect(t.h.getState()).toEqual({ canUndo: true, canRedo: false, undoLabel: "allocation.move", redoLabel: null });
  });

  it("abonnés prévenus à chaque changement de pile", async () => {
    const t = setup();
    const l = vi.fn();
    const off = t.h.subscribe(l);
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    expect(l).toHaveBeenCalledTimes(1);
    await t.h.undo();
    expect(l).toHaveBeenCalledTimes(2);
    off();
    await t.h.redo();
    expect(l).toHaveBeenCalledTimes(2);
  });

  it("limite : la plus ancienne action tombe", async () => {
    const t = setup(undefined, 20);
    for (let i = 0; i < 25; i++) await t.h.editor.updateAllocation("1", { hoursPerDay: 1 + (i % 2) });
    let n = 0;
    while ((await t.h.undo())?.ok) n++;
    expect(n).toBe(20);
  });
});

describe("annuler / rétablir", () => {
  it("undo rejoue l'état d'avant par l'éditeur (champs modifiés seulement), redo l'état d'après", async () => {
    const t = setup();
    await t.h.editor.updateAllocation("1", { startDate: "2026-10-22", endDate: "2026-10-23" });
    expect(await t.h.undo()).toEqual({ ok: true, direction: "undo", label: "allocation.move" });
    expect(t.editor.updateAllocation).toHaveBeenLastCalledWith("1", { startDate: "2026-10-20", endDate: "2026-10-21" });
    expect(t.rows.get("1")).toMatchObject({ startDate: "2026-10-20", version: 3 });
    expect(t.h.getState()).toEqual({ canUndo: false, canRedo: true, undoLabel: null, redoLabel: "allocation.move" });
    expect(await t.h.redo()).toEqual({ ok: true, direction: "redo", label: "allocation.move" });
    expect(t.rows.get("1")).toMatchObject({ startDate: "2026-10-22", version: 4 });
    // L'undo et le redo ne s'enregistrent pas eux-mêmes : une seule action dans la pile.
    expect(t.h.getState()).toEqual({ canUndo: true, canRedo: false, undoLabel: "allocation.move", redoLabel: null });
  });

  it("pile vide : rien à faire", async () => {
    const t = setup();
    expect(await t.h.undo()).toBeNull();
    expect(await t.h.redo()).toBeNull();
    expect(t.editor.updateAllocation).not.toHaveBeenCalled();
  });

  it("une nouvelle écriture vide le redo", async () => {
    const t = setup();
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    await t.h.undo();
    await t.h.editor.updateAllocation("2", { hoursPerDay: 2 });
    expect(t.h.getState().canRedo).toBe(false);
  });

  it("undo successifs lancés sans attendre : exécutés l'un après l'autre, dans l'ordre", async () => {
    const t = setup();
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    await t.h.editor.updateAllocation("2", { hoursPerDay: 2 });
    const [a, b] = await Promise.all([t.h.undo(), t.h.undo()]);
    expect([a?.ok, b?.ok]).toEqual([true, true]);
    expect(t.editor.updateAllocation.mock.calls.slice(-2).map((c) => c[0])).toEqual(["2", "1"]);
    expect(t.h.getState().canUndo).toBe(false);
  });

  it("VERSION_CONFLICT ou NOT_FOUND pendant un undo : l'action est abandonnée (ni undo ni redo)", async () => {
    for (const error of ["VERSION_CONFLICT", "NOT_FOUND"] as const) {
      const t = setup();
      await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
      t.force({ ok: false, error });
      expect(await t.h.undo()).toEqual({ ok: false, direction: "undo", label: "allocation.load", error, dropped: true });
      expect(t.h.getState()).toMatchObject({ canUndo: false, canRedo: false });
    }
  });

  it("VERSION_CONFLICT pendant un redo : abandonnée aussi", async () => {
    const t = setup();
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    await t.h.undo();
    t.force({ ok: false, error: "VERSION_CONFLICT" });
    expect(await t.h.redo()).toMatchObject({ ok: false, direction: "redo", dropped: true });
    expect(t.h.getState()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("réseau ou bloc occupé : l'action reste dans la pile, on peut réessayer", async () => {
    for (const error of ["NETWORK", "BUSY"] as const) {
      const t = setup();
      await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
      t.force({ ok: false, error });
      expect(await t.h.undo()).toMatchObject({ ok: false, error, dropped: false });
      expect(t.h.getState()).toMatchObject({ canUndo: true, canRedo: false });
      expect(await t.h.undo()).toMatchObject({ ok: true });
    }
  });
});

describe("invalidation et découpe", () => {
  it("invalidate ne retire que les actions qui touchent les entités nommées", async () => {
    const t = setup();
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    await t.h.editor.updateAllocation("2", { hoursPerDay: 2 });
    t.h.invalidate("allocations", ["2"]);
    expect(t.h.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.load" });
    await t.h.undo();
    expect(t.editor.updateAllocation).toHaveBeenLastCalledWith("1", { hoursPerDay: 4 });
    t.h.invalidate("allocations", ["1"]);
    expect(t.h.getState()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("découpe d'une occurrence : non annulable, et les actions antérieures sur la série sont retirées", async () => {
    const t = setup([alloc("1", { repeatState: "weekly", repeatEndDate: "2026-12-01" }), alloc("2")]);
    await t.h.editor.updateAllocation("2", { hoursPerDay: 2 });
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    expect(await t.h.editor.splitOccurrence("1", 1, { hoursPerDay: 3 })).toEqual({ ok: true });
    expect(t.editor.splitOccurrence).toHaveBeenCalledWith("1", 1, { hoursPerDay: 3 });
    expect(t.h.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.load" });
    await t.h.undo();
    expect(t.editor.updateAllocation).toHaveBeenLastCalledWith("2", { hoursPerDay: 4 });
    expect(t.h.getState().canUndo).toBe(false);
  });
});

describe("« Tout le groupe » (BR-26, RT-042)", () => {
  const group = () => [alloc("1", { groupId: "G" }), alloc("2", { personId: "2", groupId: "G", projectId: "2" }), alloc("3", { personId: "2" })];
  /** `hidden` : lignes hors de la fenêtre chargée (read ne les voit pas) ; `unknown` : lignes écrites dont l'état d'avant n'a pas pu être lu. */
  function groupSetup(extra: Alloc[] = [], opts: { hidden?: string[]; unknown?: string[] } = {}) {
    const m = memoryEditor([...group(), ...extra]);
    const updateAllocationGroup = vi.fn(async (id: string, patch: BlockPatch): Promise<GroupEditOutcome> => {
      const g = m.rows.get(id)?.groupId;
      if (!g) return { ok: false, error: "NOT_FOUND" };
      const before = [...m.rows.values()].filter((a) => a.groupId === g);
      for (const a of before) m.rows.set(a.id, { ...patched(a, patch), version: a.version + 1 });
      const unknown = opts.unknown ?? [];
      return { ok: true, before: before.filter((a) => !unknown.includes(a.id)), unknown };
    });
    const editor = { ...m.editor, updateAllocationGroup };
    const read = (id: string) => (opts.hidden?.includes(id) ? undefined : m.rows.get(id));
    const h = createHistory({ editor, read, now: () => 1000 });
    return { ...m, h, updateAllocationGroup };
  }

  it("une action, une op par ligne écrite (champs d'avant de chaque ligne) ; undo rejoue chaque ligne, redo aussi", async () => {
    const t = groupSetup();
    expect(await t.h.editor.updateAllocationGroup!("1", { startDate: "2026-10-22", endDate: "2026-10-23" })).toMatchObject({ ok: true });
    expect(t.updateAllocationGroup).toHaveBeenCalledWith("1", { startDate: "2026-10-22", endDate: "2026-10-23" });
    expect(t.h.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.move" });
    await t.h.undo();
    expect(t.editor.updateAllocation.mock.calls).toEqual([
      ["2", { startDate: "2026-10-20", endDate: "2026-10-21" }],
      ["1", { startDate: "2026-10-20", endDate: "2026-10-21" }],
    ]);
    expect([...t.rows.values()].map((a) => [a.id, a.startDate])).toEqual([["1", "2026-10-20"], ["2", "2026-10-20"], ["3", "2026-10-20"]]);
    await t.h.redo();
    expect([...t.rows.values()].map((a) => a.startDate)).toEqual(["2026-10-22", "2026-10-22", "2026-10-20"]);
  });

  it("ligne hors de la fenêtre (absente du snapshot) déplacée avec le groupe : Ctrl+Z la rend aussi, à ses propres dates", async () => {
    const t = groupSetup([alloc("4", { personId: "3", groupId: "G", startDate: "2027-03-01", endDate: "2027-03-02" })], { hidden: ["4"] });
    await t.h.editor.updateAllocationGroup!("1", { startDate: "2026-10-22", endDate: "2026-10-23" });
    await t.h.undo();
    expect(t.editor.updateAllocation.mock.calls.map(([id]) => id).sort()).toEqual(["1", "2", "4"]);
    expect(t.rows.get("4")).toMatchObject({ startDate: "2027-03-01", endDate: "2027-03-02" });
  });

  it("ligne écrite dont l'état d'avant est inconnu : pas d'action (rien de faux à rejouer), les actions qui touchent le groupe sont retirées", async () => {
    const t = groupSetup([], { unknown: ["9"] });
    await t.h.editor.updateAllocation("1", { hoursPerDay: 6 });
    await t.h.editor.updateAllocation("3", { hoursPerDay: 2 });
    expect(await t.h.editor.updateAllocationGroup!("1", { projectId: "3" })).toMatchObject({ ok: true, unknown: ["9"] });
    expect(t.h.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.load" });
    await t.h.undo();
    expect(t.editor.updateAllocation).toHaveBeenLastCalledWith("3", { hoursPerDay: 4 });
    expect(t.h.getState().canUndo).toBe(false);
  });

  it("projet changé pour tout le groupe : chaque ligne rend son propre projet d'origine", async () => {
    const t = groupSetup();
    await t.h.editor.updateAllocationGroup!("2", { projectId: "3" });
    expect(t.h.getState().undoLabel).toBe("allocation.edit");
    await t.h.undo();
    expect([...t.rows.values()].map((a) => a.projectId)).toEqual(["1", "2", "1"]);
  });

  it("échec : rien d'enregistré ; éditeur sans écriture de groupe : pas d'écriture de groupe proposée", async () => {
    const t = groupSetup();
    expect(await t.h.editor.updateAllocationGroup!("3", { projectId: "3" })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(t.h.getState().canUndo).toBe(false);
    const plain = setup(group());
    expect(plain.h.editor.updateAllocationGroup).toBeUndefined();
  });
});

describe("record : actions arbitraires (créations, suppressions du lot E)", () => {
  it("undo d'une création = suppression ; redo = recréation sous un nouvel id, remappé dans la pile", async () => {
    const execute = vi.fn(async (op: { kind: string; id: string }) => (op.kind === "create" ? { ok: true as const, id: "new-9" } : { ok: true as const }));
    const m = memoryEditor([]);
    const h = createHistory({ editor: m.editor, read: m.read, execute, now: () => 0 });
    h.record({ label: "allocation.create", ops: [{ kind: "create", entity: "allocations", id: "9", after: { personId: "1" } }] });
    expect(h.getState()).toMatchObject({ canUndo: true, undoLabel: "allocation.create" });
    await h.undo();
    expect(execute).toHaveBeenLastCalledWith({ kind: "delete", entity: "allocations", id: "9", before: { personId: "1" } });
    await h.redo();
    expect(execute).toHaveBeenLastCalledWith({ kind: "create", entity: "allocations", id: "9", after: { personId: "1" } });
    await h.undo();
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "delete", id: "new-9" }));
  });

  it("sans exécuteur pour une création : UNSUPPORTED, l'action est abandonnée", async () => {
    const m = memoryEditor([]);
    const h = createHistory({ editor: m.editor, read: m.read });
    h.record({ label: "allocation.create", ops: [{ kind: "create", entity: "allocations", id: "9", after: {} }] });
    expect(await h.undo()).toMatchObject({ ok: false, error: "UNSUPPORTED", dropped: true });
  });
});
