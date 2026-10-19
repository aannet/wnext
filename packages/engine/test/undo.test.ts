// Annulation de session et cascades différées (BR-40, ADR-001 §10).
import { describe, expect, it } from "vitest";
import {
  CASCADE_DELAY_MS, cancelCascade, dropFailedStep, emptyCascadeQueue, emptyUndo, invalidateUndo, invertOp, pruneUndo, recordAction, redoStep,
  remapId, scheduleCascade, takeDueCascades, undoStep, type Action, type Op,
} from "../src/undo";

const move = (id: string, from: string, to: string, at = 0): Action => ({
  label: "allocation.move", at,
  ops: [{ kind: "update", entity: "allocations", id, before: { startDate: from }, after: { startDate: to } }],
});
const create = (id: string, at = 0): Action => ({ label: "allocation.create", at, ops: [{ kind: "create", entity: "allocations", id, after: { hoursPerDay: 4 } }] });
const del = (id: string, at = 0): Action => ({ label: "allocation.delete", at, ops: [{ kind: "delete", entity: "allocations", id, before: { hoursPerDay: 4 } }] });

// @BR-40
describe("pile d'annulation", () => {
  it("inverse : créer <-> supprimer, modifier échange avant et après ; double inversion = identité", () => {
    const ops: Op[] = [...create("1").ops, ...del("2").ops, ...move("3", "a", "b").ops];
    for (const o of ops) expect(invertOp(invertOp(o))).toEqual(o);
    expect(invertOp(create("1").ops[0]!)).toEqual({ kind: "delete", entity: "allocations", id: "1", before: { hoursPerDay: 4 } });
  });

  it("undo puis redo : opérations inverses puis originales, libellé rendu", () => {
    let s = recordAction(emptyUndo(), move("1", "2026-03-02", "2026-03-04"));
    const u = undoStep(s);
    expect(u.label).toBe("allocation.move");
    expect(u.ops).toEqual([{ kind: "update", entity: "allocations", id: "1", before: { startDate: "2026-03-04" }, after: { startDate: "2026-03-02" } }]);
    s = u.state;
    const r = redoStep(s);
    expect(r.ops).toEqual(move("1", "2026-03-02", "2026-03-04").ops);
    expect(r.state.undo).toHaveLength(1);
    expect(r.state.redo).toHaveLength(0);
  });

  it("action groupée (report assisté) : annulée en bloc, dans l'ordre inverse", () => {
    const a: Action = { label: "timeoff.reschedule", at: 0, ops: [...move("1", "a", "b").ops, ...del("2").ops] };
    const u = undoStep(recordAction(emptyUndo(), a));
    expect(u.ops!.map((o) => `${o.kind}:${o.id}`)).toEqual(["create:2", "update:1"]);
  });

  it("une nouvelle action vide le redo ; pile vide : rien à faire", () => {
    let s = recordAction(emptyUndo(), create("1"));
    s = undoStep(s).state;
    expect(s.redo).toHaveLength(1);
    s = recordAction(s, create("2"));
    expect(s.redo).toHaveLength(0);
    expect(undoStep(emptyUndo()).ops).toBeNull();
    expect(redoStep(emptyUndo()).ops).toBeNull();
  });

  it("au moins 20 actions gardées ; au-delà de la limite la plus ancienne tombe", () => {
    expect(() => emptyUndo(19)).toThrow(/UNDO_LIMIT_TOO_SMALL/);
    let s = emptyUndo(20);
    for (let i = 0; i < 25; i++) s = recordAction(s, create(String(i)));
    expect(s.undo).toHaveLength(20);
    expect(s.undo[0]!.ops[0]!.id).toBe("5");
  });

  it("une modification sans effet n'est pas enregistrée", () => {
    expect(recordAction(emptyUndo(), move("1", "a", "a")).undo).toHaveLength(0);
  });

  it("suppression annulée : l'entité revient sous un nouvel id, les actions qui la visent suivent", () => {
    let s = recordAction(emptyUndo(), move("7", "a", "b"));
    s = recordAction(s, del("7"));
    const u = undoStep(s);
    expect(u.ops).toEqual([{ kind: "create", entity: "allocations", id: "7", after: { hoursPerDay: 4 } }]);
    s = remapId(u.state, "allocations", "7", "70"); // le serveur a recréé l'allocation sous l'id 70
    const u2 = undoStep(s);
    expect(u2.ops![0]).toMatchObject({ kind: "update", id: "70" });
    expect(redoStep(s).ops![0]).toMatchObject({ kind: "delete", id: "70" });
  });

  it("échec d'exécution (conflit de version) : l'action est abandonnée", () => {
    const s = recordAction(recordAction(emptyUndo(), create("1")), move("1", "a", "b"));
    const u = undoStep(s);
    const after = dropFailedStep(u.state, "undo");
    expect(after.redo).toHaveLength(0);
    expect(after.undo).toHaveLength(1);
    const r = redoStep(undoStep(s).state);
    expect(dropFailedStep(r.state, "redo").undo).toHaveLength(1);
  });

  it("cascade exécutée : les actions qui touchent les allocations supprimées sont retirées", () => {
    let s = recordAction(emptyUndo(), move("1", "a", "b"));
    s = recordAction(s, move("2", "a", "b"));
    s = invalidateUndo(s, "allocations", ["1"]);
    expect(s.undo.map((a) => a.ops[0]!.id)).toEqual(["2"]);
    expect(invalidateUndo(s, "people", ["2"]).undo).toHaveLength(1); // autre entité : rien
  });

  it("durée de vie : les actions trop anciennes sont retirées", () => {
    let s = recordAction(emptyUndo(), create("1", 0));
    s = recordAction(s, create("2", 50_000));
    expect(pruneUndo(s, 60_000, 30_000).undo.map((a) => a.ops[0]!.id)).toEqual(["2"]);
  });
});

// @BR-10 @BR-40
describe("cascades différées de 10 s (ADR-001 §10)", () => {
  it("rien n'est échu avant 10 s ; à 10 s la cascade est rendue une seule fois", () => {
    let q = scheduleCascade(emptyCascadeQueue<{ projectId: string }>(), "team:1:2", { projectId: "1" }, 1_000);
    let t = takeDueCascades(q, 1_000 + CASCADE_DELAY_MS - 1);
    expect(t.due).toHaveLength(0);
    q = t.queue;
    t = takeDueCascades(q, 1_000 + CASCADE_DELAY_MS);
    expect(t.due.map((d) => d.payload)).toEqual([{ projectId: "1" }]);
    expect(takeDueCascades(t.queue, 1e12).due).toHaveLength(0);
  });

  it("« Annuler » avant l'échéance : jamais exécutée ; après : sans effet", () => {
    const q = scheduleCascade(emptyCascadeQueue<string>(), "k", "x", 0);
    const c = cancelCascade(q, "k", 9_999);
    expect(c.cancelled).toBe(true);
    expect(takeDueCascades(c.queue, 1e12).due).toHaveLength(0);
    expect(cancelCascade(q, "k", 10_000).cancelled).toBe(false);
    expect(cancelCascade(q, "absente", 0).cancelled).toBe(false);
  });

  it("reprogrammer la même clé repart de zéro ; plusieurs échéances rendues dans l'ordre", () => {
    let q = scheduleCascade(emptyCascadeQueue<string>(), "a", "a1", 0);
    q = scheduleCascade(q, "b", "b", 1_000);
    q = scheduleCascade(q, "a", "a2", 5_000);
    expect(q.pending).toHaveLength(2);
    expect(takeDueCascades(q, 20_000).due.map((d) => d.payload)).toEqual(["b", "a2"]);
  });
});

describe("remapId ciblé", () => {
  it("ne touche que l'entité et l'id visés", () => {
    let s = recordAction(emptyUndo(), { label: "x", at: 0, ops: [...move("7", "a", "b").ops, { kind: "update", entity: "people", id: "7", before: { name: "a" }, after: { name: "b" } }] });
    s = remapId(s, "allocations", "7", "70");
    expect(s.undo[0]!.ops.map((o) => `${o.entity}:${o.id}`)).toEqual(["allocations:70", "people:7"]);
  });
});
