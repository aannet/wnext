// Gestes sur un bloc et équivalents clavier (ADR-002 §5-6, WCAG 2.5.7).
import { describe, expect, it } from "vitest";
import { applyGesture, keyGesture, pointerGesture, type GestureBlock } from "../src/gestures";

const blk = (over: Partial<GestureBlock> = {}): GestureBlock => ({
  personId: "p1", startDate: "2026-03-02", endDate: "2026-03-04", mode: "hours", hoursPerDay: 6, percent: null,
  repeatState: "none", repeatEndDate: null, ...over,
});

describe("applyGesture", () => {
  it("déplacer : décale début et fin, change de personne ; aucun effet => null", () => {
    expect(applyGesture(blk(), { kind: "move", days: 2 })).toEqual({ patch: { startDate: "2026-03-04", endDate: "2026-03-06" }, series: false });
    expect(applyGesture(blk(), { kind: "move", days: 0, personId: "p2" })).toEqual({ patch: { personId: "p2" }, series: false });
    expect(applyGesture(blk(), { kind: "move", days: 0, personId: "p1" })).toBeNull();
    expect(applyGesture(blk(), { kind: "move", days: 0.4 })).toBeNull(); // aimanté à la journée
  });

  it("étirer : jamais sous un jour, de chaque côté", () => {
    expect(applyGesture(blk(), { kind: "resizeEnd", days: 3 })!.patch).toEqual({ endDate: "2026-03-07" });
    expect(applyGesture(blk(), { kind: "resizeEnd", days: -10 })!.patch).toEqual({ endDate: "2026-03-02" });
    expect(applyGesture(blk(), { kind: "resizeStart", days: -1 })!.patch).toEqual({ startDate: "2026-03-01" });
    expect(applyGesture(blk(), { kind: "resizeStart", days: 10 })!.patch).toEqual({ startDate: "2026-03-04" });
    expect(applyGesture(blk({ endDate: "2026-03-02" }), { kind: "resizeEnd", days: -1 })).toBeNull();
  });

  // @BR-01
  it("hauteur : aimantée, bornée au contrat, sur-allocation permise (24 h)", () => {
    expect(applyGesture(blk(), { kind: "height", delta: 1.3 })!.patch).toEqual({ hoursPerDay: 7.5 });
    expect(applyGesture(blk(), { kind: "height", delta: 30 })!.patch).toEqual({ hoursPerDay: 24 });
    expect(applyGesture(blk(), { kind: "height", delta: -30 })!.patch).toEqual({ hoursPerDay: 0.5 });
    const pct = blk({ mode: "percentage", hoursPerDay: null, percent: 50 });
    expect(applyGesture(pct, { kind: "height", delta: 12 })!.patch).toEqual({ percent: 60 });
    expect(applyGesture(pct, { kind: "height", delta: 1000 })!.patch).toEqual({ percent: 500 });
  });

  // @BR-25
  it("série répétée : déplacer décale la série entière et le signale ; étirer au-delà de la fin de série la repousse", () => {
    const s = blk({ repeatState: "weekly", repeatEndDate: "2026-03-31" });
    expect(applyGesture(s, { kind: "move", days: 1 })).toEqual({
      patch: { startDate: "2026-03-03", endDate: "2026-03-05", repeatEndDate: "2026-04-01" }, series: true,
    });
    const short = blk({ repeatState: "weekly", repeatEndDate: "2026-03-05" });
    expect(applyGesture(short, { kind: "resizeEnd", days: 3 })!.patch).toEqual({ endDate: "2026-03-07", repeatEndDate: "2026-03-07" });
  });
});

describe("pointeur", () => {
  const scale = { pxPerDay: 40, rowHeightPx: 48, refHours: 8, mode: "hours" as const };
  it("dx en jours aimantés, dy vers le haut = plus d'heures", () => {
    expect(pointerGesture("move", 61, 0, scale)).toEqual({ kind: "move", days: 2 });
    expect(pointerGesture("resizeEnd", -19, 0, scale)).toEqual({ kind: "resizeEnd", days: 0 });
    expect(pointerGesture("height", 0, -12, scale)).toEqual({ kind: "height", delta: 2 });
    expect(pointerGesture("height", 0, 24, { ...scale, mode: "percentage" })).toEqual({ kind: "height", delta: -50 });
  });
});

describe("clavier (chaque geste a son équivalent)", () => {
  const rows = ["p0", "p1", "p2"];
  it("flèches : déplacer, Maj : fin, Alt : début, ↑↓ : hauteur, Ctrl+↑↓ : personne", () => {
    const b = blk();
    expect(keyGesture({ key: "ArrowRight" }, b)).toEqual({ kind: "move", days: 1 });
    expect(keyGesture({ key: "ArrowLeft", shiftKey: true }, b)).toEqual({ kind: "resizeEnd", days: -1 });
    expect(keyGesture({ key: "ArrowLeft", altKey: true }, b)).toEqual({ kind: "resizeStart", days: -1 });
    expect(keyGesture({ key: "ArrowUp" }, b)).toEqual({ kind: "height", delta: 0.5 });
    expect(keyGesture({ key: "ArrowDown" }, blk({ mode: "percentage", hoursPerDay: null, percent: 50 }))).toEqual({ kind: "height", delta: -5 });
    expect(keyGesture({ key: "ArrowUp", ctrlKey: true }, b, rows)).toEqual({ kind: "move", days: 0, personId: "p0" });
    expect(keyGesture({ key: "ArrowDown", metaKey: true }, b, rows)).toEqual({ kind: "move", days: 0, personId: "p2" });
    expect(keyGesture({ key: "ArrowUp", ctrlKey: true }, blk({ personId: "p0" }), rows)).toBeNull();
    expect(keyGesture({ key: "Enter" }, b)).toBeNull();
  });

  it("chaque type de geste pointeur est atteignable au clavier", () => {
    const b = blk();
    const kinds = new Set(
      [{ key: "ArrowRight" }, { key: "ArrowRight", shiftKey: true }, { key: "ArrowRight", altKey: true }, { key: "ArrowUp" }, { key: "ArrowDown", ctrlKey: true }]
        .map((k) => keyGesture(k, b, rows)?.kind),
    );
    expect([...kinds].sort()).toEqual(["height", "move", "resizeEnd", "resizeStart"]);
  });
});

describe("combinaisons sans effet et cas limites", () => {
  it("Ctrl + ← / →, Maj ou Alt + ↑ / ↓ : aucun geste ; personne hors de rowOrder : aucun changement de ligne", () => {
    const b = blk();
    expect(keyGesture({ key: "ArrowLeft", ctrlKey: true }, b)).toBeNull();
    expect(keyGesture({ key: "ArrowUp", shiftKey: true }, b)).toBeNull();
    expect(keyGesture({ key: "ArrowDown", altKey: true }, b)).toBeNull();
    expect(keyGesture({ key: "ArrowDown", ctrlKey: true }, blk({ personId: "inconnu" }), ["p0", "p1"])).toBeNull();
  });

  it("hauteur déjà au plafond : aucun patch", () => {
    expect(applyGesture(blk({ hoursPerDay: 24 }), { kind: "height", delta: 1 })).toBeNull();
    expect(applyGesture(blk({ mode: "percentage", hoursPerDay: null, percent: 500 }), { kind: "height", delta: 5 })).toBeNull();
  });
});
