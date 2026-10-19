// Moteur de layout d'une ligne (ADR-002 §6) : géométrie seule, indépendante du rendu (ADR-005).
import { describe, expect, it } from "vitest";
import { addDays } from "../src/dates";
import { blockFraction, layoutRow, referenceHours, snapHours, type LayoutBlock } from "../src/layout";

const b = (id: string, startDate: string, endDate: string, fraction: number): LayoutBlock => ({ id, startDate, endDate, fraction });
const FROM = "2026-03-02"; // lundi
const TO = "2026-03-15";

describe("hauteur des blocs", () => {
  it("heures / journée de référence (la plus longue), % tel quel", () => {
    expect(referenceHours([8, 8, 8, 8, 8, 0, 0])).toBe(8);
    expect(referenceHours([7, 7, 7, 7, 4, 0, 0])).toBe(7);
    expect(referenceHours([0, 0, 0, 0, 0, 0, 0])).toBe(8);
    expect(blockFraction({ mode: "hours", hoursPerDay: 6, percent: null }, [8, 8, 8, 8, 8, 0, 0])).toBe(0.75);
    expect(blockFraction({ mode: "percentage", hoursPerDay: null, percent: 50 }, [8, 8, 8, 8, 8, 0, 0])).toBe(0.5);
  });

  it("aimantation des heures au demi-pas, jamais sous un pas", () => {
    expect(snapHours(0.76, 8)).toBe(6);
    expect(snapHours(0.8, 8)).toBe(6.5);
    expect(snapHours(0.01, 8)).toBe(0.5);
    expect(snapHours(0.6, 8, 1)).toBe(5);
  });
});

// @BR-01
describe("empilement", () => {
  it("blocs disjoints dans le temps : tous en bas, ligne de hauteur 1", () => {
    const r = layoutRow([b("a", "2026-03-02", "2026-03-04", 0.75), b("b", "2026-03-05", "2026-03-06", 1)], FROM, TO);
    expect(r.placed.map((p) => [p.id, p.col, p.span, p.y])).toEqual([["a", 0, 3, 0], ["b", 3, 2, 0]]);
    expect(r).toMatchObject({ height: 1, overflow: false });
  });

  it("chevauchement : empilés ; somme > 100 % => débordement visible (sur-allocation jamais bloquée)", () => {
    const r = layoutRow([b("a", "2026-03-02", "2026-03-06", 0.75), b("b", "2026-03-04", "2026-03-05", 0.5)], FROM, TO);
    expect(r.placed.find((p) => p.id === "b")).toMatchObject({ y: 0.75, h: 0.5 });
    expect(r.height).toBeCloseTo(1.25);
    expect(r.overflow).toBe(true);
  });

  it("deux moitiés le même jour : pile exacte de 100 %, pas de débordement", () => {
    const r = layoutRow([b("a", "2026-03-02", "2026-03-02", 0.5), b("b", "2026-03-02", "2026-03-02", 0.5)], FROM, TO);
    expect(r).toMatchObject({ height: 1, overflow: false });
  });

  it("un trou libre plus bas est réutilisé (le spike empilait toujours au-dessus du plus haut)", () => {
    // p1 occupe le bas lun-mar, p2 est posé au-dessus mar-ven ; p3 (jeu-ven) se loge en bas, là où p1 n'est plus.
    const r = layoutRow([
      b("p1", "2026-03-02", "2026-03-03", 0.5),
      b("p2", "2026-03-03", "2026-03-06", 0.25),
      b("p3", "2026-03-05", "2026-03-06", 0.5),
    ], FROM, TO);
    const y = Object.fromEntries(r.placed.map((p) => [p.id, p.y]));
    expect(y).toEqual({ p1: 0, p2: 0.5, p3: 0 });
    expect(r.height).toBe(1);
  });

  it("le bloc le plus long d'abord : les blocs courts de jours distincts se posent chacun au-dessus de lui", () => {
    const r = layoutRow([
      b("lun", "2026-03-02", "2026-03-02", 0.5),
      b("mer", "2026-03-04", "2026-03-04", 0.25),
      b("tout", "2026-03-02", "2026-03-04", 0.25),
    ], FROM, TO);
    expect(Object.fromEntries(r.placed.map((p) => [p.id, p.y]))).toEqual({ tout: 0, lun: 0.25, mer: 0.25 });
  });

  it("ordre déterministe : début, plus long d'abord, puis id ; indépendant de l'ordre d'entrée", () => {
    const blocks = [b("z", "2026-03-02", "2026-03-03", 0.25), b("y", "2026-03-02", "2026-03-06", 0.25), b("x", "2026-03-02", "2026-03-03", 0.25)];
    const r1 = layoutRow(blocks, FROM, TO);
    const r2 = layoutRow([...blocks].reverse(), FROM, TO);
    expect(r1).toEqual(r2);
    expect(r1.placed.map((p) => p.id)).toEqual(["y", "x", "z"]);
  });

  it("aucun chevauchement de rectangles, sur 300 lignes aléatoires (graine fixe)", () => {
    let s = 7;
    const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let row = 0; row < 300; row++) {
      const blocks: LayoutBlock[] = [];
      for (let i = 0; i < 12; i++) {
        const start = addDays(FROM, Math.floor(r() * 20) - 3);
        blocks.push(b(`b${i}`, start, addDays(start, Math.floor(r() * 6)), [0.25, 0.5, 0.75, 1][Math.floor(r() * 4)]!));
      }
      const { placed, height } = layoutRow(blocks, FROM, TO);
      for (const p of placed) {
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y + p.h).toBeLessThanOrEqual(height + 1e-9);
        for (const q of placed) {
          if (p === q) continue;
          const timeOverlap = p.col < q.col + q.span && q.col < p.col + p.span;
          const yOverlap = p.y < q.y + q.h - 1e-9 && q.y < p.y + p.h - 1e-9;
          expect(timeOverlap && yOverlap, `${p.id} / ${q.id}`).toBe(false);
        }
      }
    }
  });
});

describe("fenêtre", () => {
  it("coupe aux bords et le signale ; ignore les blocs hors fenêtre et invalides", () => {
    const r = layoutRow([
      b("avant", "2026-02-25", "2026-03-03", 0.5),
      b("apres", "2026-03-14", "2026-03-20", 0.5),
      b("hors", "2026-04-01", "2026-04-02", 0.5),
      b("nul", "2026-03-05", "2026-03-05", 0),
      b("inverse", "2026-03-06", "2026-03-05", 0.5),
    ], FROM, TO);
    expect(r.placed).toEqual([
      { id: "avant", col: 0, span: 2, clippedStart: true, clippedEnd: false, y: 0, h: 0.5 },
      { id: "apres", col: 12, span: 2, clippedStart: false, clippedEnd: true, y: 0, h: 0.5 },
    ]);
  });

  it("ligne vide : hauteur 1, rien à dessiner", () => {
    expect(layoutRow([], FROM, TO)).toEqual({ placed: [], height: 1, overflow: false });
  });
});
