// @vitest-environment jsdom
// Rendu DOM de la grille (ADR-005 A2) : seules les lignes visibles existent, nœuds recyclés, écritures minimales.
import { describe, expect, it } from "vitest";
import type { GridModel, GridRow } from "../src/schedule/grid-model";
import { createGridRenderer } from "../src/schedule/grid-dom";

const U = 48;
const row = (i: number, blocks: GridRow["blocks"] = [], heightPx = U): GridRow => ({ personId: String(i), name: `P${i}`, top: i * U, heightPx, overflow: heightPx > U, blocks });
const model = (n: number, first: GridRow["blocks"] = []): GridModel => ({
  from: "2026-03-02", to: "2026-03-15", pxPerDay: 10, widthPx: 140, heightPx: n * U,
  rows: Array.from({ length: n }, (_, i) => row(i, i === 0 ? first : [])),
});
const blk = (key: string, x: number, over: Partial<GridRow["blocks"][number]> = {}) => ({
  key, allocationId: key.split(":")[0]!, x, y: 0, w: 20, h: 24, color: "#3B82F6", label: "Refonte", tentative: false, clippedStart: false, clippedEnd: false, ...over,
});

describe("createGridRenderer", () => {
  it("300 personnes : seules les lignes visibles (plus la marge) sont dans le DOM, surface à la taille réelle", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root, { overscan: 2 });
    r.render(model(300), 0, 5 * U);
    expect(root.querySelectorAll("[role=row]")).toHaveLength(7);
    const surface = root.firstElementChild as HTMLElement;
    expect([surface.style.width, surface.style.height]).toEqual(["140px", `${300 * U}px`]);
  });

  it("défilement : les nœuds de ligne sont recyclés, jamais recréés", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root, { overscan: 2 });
    const m = model(300);
    r.render(m, 50 * U + 7, 5 * U); // milieu, position fractionnaire : le plus grand nombre de lignes visibles
    const created = r.stats().rowsCreated;
    for (let s = 0; s < 100 * U; s += 13) r.render(m, s, 5 * U);
    expect(r.stats().rowsCreated).toBe(created);
    const names = [...root.querySelectorAll("[role=rowheader]")].map((e) => e.textContent).filter((t) => t !== "");
    expect(names).toContain("P101");
  });

  it("bloc : position, taille, couleur, tentatif ; même clé = même nœud après déplacement", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    r.render(model(3, [blk("100:0", 10), blk("101:0", 30, { tentative: true })]), 0, 3 * U);
    const el = root.querySelector('[data-key="100:0"]') as HTMLElement;
    expect([el.style.transform, el.style.width, el.style.height, el.getAttribute("role"), el.textContent])
      .toEqual(["translate(10px, 0px)", "20px", "24px", "gridcell", "Refonte"]);
    expect(el.style.backgroundColor).not.toBe("");
    expect(root.querySelector('[data-key="101:0"]')!.classList.contains("wn-tentative")).toBe(true);
    r.render(model(3, [blk("100:0", 50)]), 0, 3 * U);
    expect(root.querySelector('[data-key="100:0"]')).toBe(el);
    expect(el.style.transform).toBe("translate(50px, 0px)");
    expect(root.querySelector('[data-key="101:0"]')).toBeNull();
  });

  it("ligne en débordement (> 100 %) marquée ; destroy vide le conteneur", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    const m = model(2);
    m.rows[0] = row(0, [], 1.5 * U);
    r.render(m, 0, 2 * U);
    expect(root.querySelector("[role=row]")!.classList.contains("wn-overflow")).toBe(true);
    r.destroy();
    expect(root.childElementCount).toBe(0);
  });
});
