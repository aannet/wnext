// @vitest-environment jsdom
// Rendu DOM de la grille et de l'en-tête (ADR-005 A2) : seules les lignes, blocs et cellules visibles existent, nœuds
// recyclés, écritures minimales.
import { describe, expect, it } from "vitest";
import type { GridModel, GridRow } from "../src/schedule/grid-model";
import { createGridRenderer } from "../src/schedule/grid-dom";
import { createHeaderRenderer } from "../src/schedule/grid-header";

const U = 48;
const row = (i: number, blocks: GridRow["blocks"] = [], heightPx = U): GridRow => ({ personId: String(i), name: `P${i}`, top: i * U, heightPx, overflow: heightPx > U, blocks, capY: heightPx - 14, cells: [] });
const model = (n: number, first: GridRow["blocks"] = []): GridModel => ({
  from: "2026-03-02", to: "2026-03-15", pxPerDay: 10, widthPx: 140, heightPx: n * U,
  rows: Array.from({ length: n }, (_, i) => row(i, i === 0 ? first : [])),
});
const blk = (key: string, x: number, over: Partial<GridRow["blocks"][number]> = {}) => ({
  key, allocationId: key.split(":")[0]!, x, y: 0, w: 20, h: 24, color: "#3B82F6", label: "Refonte", tentative: false, clippedStart: false, clippedEnd: false,
  startDate: "2026-03-03", endDate: "2026-03-04", hoursPerDay: 4, percent: null, repeat: "none" as const, ...over,
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
    // Origine explicite : sinon le bloc part de sa position statique, sous l'en-tête de ligne (décalé et rogné en bas).
    expect([el.style.position, el.style.top, el.style.left]).toEqual(["absolute", "0px", "0px"]);
    expect(el.style.backgroundColor).not.toBe("");
    expect([el.style.backgroundColor, el.style.color]).toEqual(["rgb(59, 130, 246)", "rgb(0, 0, 0)"]); // noir : 5,7:1, blanc : 3,7:1
    const tentative = root.querySelector('[data-key="101:0"]') as HTMLElement;
    expect(tentative.classList.contains("wn-tentative")).toBe(true);
    expect([tentative.style.borderColor, tentative.style.color]).toEqual(["rgb(59, 130, 246)", "rgb(0, 0, 0)"]);
    expect(tentative.style.backgroundColor).not.toBe(el.style.backgroundColor);
    r.render(model(3, [blk("100:0", 50)]), 0, 3 * U);
    expect(root.querySelector('[data-key="100:0"]')).toBe(el);
    expect(el.style.transform).toBe("translate(50px, 0px)");
    expect(root.querySelector('[data-key="101:0"]')).toBeNull();
  });

  it("libellé accessible d'un bloc : posé à la création, recalculé seulement si projet, dates ou quantité changent", () => {
    const root = document.createElement("div");
    const calls: string[] = [];
    const r = createGridRenderer(root, { blockLabel: (b) => { calls.push(b.key); return `${b.label} ${b.startDate} ${b.endDate} ${b.hoursPerDay}`; } });
    r.render(model(2, [blk("100:0", 10)]), 0, 2 * U);
    const el = root.querySelector('[data-key="100:0"]')!;
    expect(el.getAttribute("aria-label")).toBe("Refonte 2026-03-03 2026-03-04 4");
    r.render(model(2, [blk("100:0", 50)]), 0, 2 * U); // déplacé en pixels seulement (nouvelle tranche) : libellé inchangé
    expect(calls).toEqual(["100:0"]);
    r.render(model(2, [blk("100:0", 50, { endDate: "2026-03-06", hoursPerDay: 6 })]), 0, 2 * U);
    expect(el.getAttribute("aria-label")).toBe("Refonte 2026-03-03 2026-03-06 6");
    expect(calls).toHaveLength(2);
  });

  it("horizontal : surface à la largeur de la piste, blocs décalés de l'origine, seuls ceux de [left, right] ont un nœud", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    const m = model(1, [blk("1:0", 0), blk("2:0", 500), blk("3:0", 2000)]);
    r.render(m, 0, U, { surfaceWidth: 10_000, originX: 1000, left: 1400, right: 2000 });
    expect((root.firstElementChild as HTMLElement).style.width).toBe("10000px");
    expect([...root.querySelectorAll(".wn-block[data-key]")].map((e) => e.getAttribute("data-key"))).toEqual(["2:0"]);
    expect((root.querySelector('[data-key="2:0"]') as HTMLElement).style.transform).toBe("translate(1500px, 0px)");
    r.render(m, 0, U, { surfaceWidth: 10_000, originX: 1000, left: 2800, right: 3200 }); // défilement : 2:0 recyclé pour 3:0
    expect([...root.querySelectorAll(".wn-block[data-key]")].map((e) => e.getAttribute("data-key"))).toEqual(["3:0"]);
    expect(r.stats().blocksCreated).toBe(1);
    r.render(m, 0, U, { surfaceWidth: 10_000, originX: 900, left: 2800, right: 3200 }); // piste allongée à gauche
    expect((root.querySelector('[data-key="3:0"]') as HTMLElement).style.transform).toBe("translate(2900px, 0px)");
  });

  it("ligne en débordement (> 100 %) : plus haute, mais pas colorée en entier (la surcharge se lit par cellule dans la bande) ; destroy vide le conteneur", () => {
    const root = document.createElement("div");
    const r = createGridRenderer(root);
    const m = model(2);
    m.rows[0] = row(0, [], 1.5 * U);
    r.render(m, 0, 2 * U);
    const el = root.querySelector("[role=row]") as HTMLElement;
    expect(el.style.height).toBe(`${1.5 * U}px`);
    expect(el.className).toBe("wn-row");
    r.destroy();
    expect(root.childElementCount).toBe(0);
  });
});

describe("createHeaderRenderer", () => {
  it("en-tête collé en haut, cellules de la fenêtre seulement, nœuds recyclés ; coin masqué aux lecteurs d'écran", () => {
    const root = document.createElement("div");
    const h = createHeaderRenderer(root, { heightPx: 32, gutterPx: 140 });
    const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ from: `d${from + i}`, x: 140 + (from + i) * 10, w: 10, label: `L${from + i}` }));
    h.render(items(0, 5), 1000);
    const bar = root.firstElementChild as HTMLElement;
    expect([bar.getAttribute("role"), bar.style.position, bar.style.width]).toEqual(["row", "sticky", "1000px"]);
    expect(bar.querySelector(".wn-corner")!.getAttribute("aria-hidden")).toBe("true");
    const cells = () => [...root.querySelectorAll("[role=columnheader]")].map((e) => [e.getAttribute("data-from"), e.textContent]);
    expect(cells()[0]).toEqual(["d0", "L0"]);
    for (let s = 1; s < 200; s++) h.render(items(s, 5), 3000);
    expect(h.stats().cellsCreated).toBe(5);
    expect(cells().sort()).toEqual([["d199", "L199"], ["d200", "L200"], ["d201", "L201"], ["d202", "L202"], ["d203", "L203"]]);
    expect((root.querySelector('[data-from="d199"]') as HTMLElement).style.transform).toBe("translateX(2130px)");
    h.destroy();
    expect(root.childElementCount).toBe(0);
  });
});
