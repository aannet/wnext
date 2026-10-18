// Vue horizontale du Schedule (ADR-002 §2-3) : zoom, centre conservé, « Aujourd'hui », chargement par blocs.
import { describe, expect, it } from "vitest";
import { addDays } from "../src/dates";
import {
  CHUNK_DAYS, dateAtX, dayNumber, goToday, headerCells, loadChunks, mergeChunks, page, scrollBy, setZoom,
  viewAt, visibleRange, weekStartOf, xOfDate,
} from "../src/viewport";

const SCALE = { day: 100, week: 20, month: 5 };

describe("vue et zoom", () => {
  it("vue centrée sur le milieu d'un jour : plage visible symétrique", () => {
    const v = viewAt("2026-03-11", "day", 700, SCALE); // 7 jours visibles
    expect(visibleRange(v)).toEqual({ from: "2026-03-08", to: "2026-03-14" });
  });

  it("changer de zoom conserve le point central", () => {
    const v = viewAt("2026-03-11", "day", 700, SCALE);
    for (const z of ["week", "month", "day"] as const) {
      const w = setZoom(v, z, SCALE);
      expect(w.center).toBe(v.center);
      expect(dateAtX(w, w.widthPx / 2)).toBe("2026-03-11");
    }
    expect(visibleRange(setZoom(v, "week", SCALE))).toEqual({ from: "2026-02-22", to: "2026-03-28" }); // 35 jours
  });

  it("« Aujourd'hui » recentre sans changer le zoom", () => {
    const v = setZoom(viewAt("2025-01-01", "day", 700, SCALE), "month", SCALE);
    const t = goToday(v, "2026-10-19");
    expect(t.zoom).toBe("month");
    expect(dateAtX(t, t.widthPx / 2)).toBe("2026-10-19");
  });

  it("x <-> date : aller-retour à la journée", () => {
    const v = viewAt("2026-03-11", "week", 1000, SCALE);
    for (const d of ["2026-03-01", "2026-03-11", "2026-03-30"]) {
      expect(dateAtX(v, xOfDate(v, d) + 1)).toBe(d);
      expect(dateAtX(v, xOfDate(v, d) + SCALE.week - 1)).toBe(d);
    }
  });

  it("défilement et précédent / suivant (une largeur de vue)", () => {
    const v = viewAt("2026-03-11", "day", 700, SCALE);
    expect(dateAtX(scrollBy(v, 250), 350)).toBe("2026-03-14"); // milieu du 11 + 2,5 j
    expect(visibleRange(page(v, 1))).toEqual({ from: "2026-03-15", to: "2026-03-21" });
    expect(visibleRange(page(v, -1))).toEqual({ from: "2026-03-01", to: "2026-03-07" });
  });

  it("bornes de la plage planifiable : la vue ne sort pas", () => {
    const bounds = { first: "2026-01-01", last: "2026-12-31" };
    const v = goToday(viewAt("2026-06-01", "day", 700, SCALE), "2025-06-01", bounds);
    expect(visibleRange(v).from).toBe("2026-01-01");
    const w = scrollBy(viewAt("2026-12-20", "day", 700, SCALE), 10_000, bounds);
    expect(visibleRange(w).to).toBe("2026-12-31");
  });
});

describe("semaines et en-têtes", () => {
  it("début de semaine selon week_start (ISO 1 = lundi, 7 = dimanche)", () => {
    expect(weekStartOf("2026-03-11", 1)).toBe("2026-03-09"); // mercredi -> lundi
    expect(weekStartOf("2026-03-11", 7)).toBe("2026-03-08"); // -> dimanche
    expect(weekStartOf("2026-03-09", 1)).toBe("2026-03-09");
    expect(weekStartOf("2026-03-08", 1)).toBe("2026-03-02"); // dimanche -> lundi précédent
  });

  it("en-têtes : jours, semaines alignées, mois entiers", () => {
    const r = { from: "2026-02-26", to: "2026-03-03" };
    expect(headerCells(r, "day", 1).map((c) => c.from)).toEqual(["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(headerCells(r, "week", 1)).toEqual([
      { from: "2026-02-23", to: "2026-03-01", kind: "week" },
      { from: "2026-03-02", to: "2026-03-08", kind: "week" },
    ]);
    expect(headerCells({ from: "2026-12-15", to: "2027-02-01" }, "month", 1).map((c) => [c.from, c.to])).toEqual([
      ["2026-12-01", "2026-12-31"], ["2027-01-01", "2027-01-31"], ["2027-02-01", "2027-02-28"],
    ]);
  });
});

describe("chargement par blocs", () => {
  it("blocs de 4 semaines alignés sur week_start, couvrant la vue et le préchargement", () => {
    const v = viewAt("2026-03-11", "week", 700, SCALE);
    const chunks = loadChunks(v, 1, 14);
    const r = visibleRange(v);
    expect(chunks[0]!.from <= addDays(r.from, -14)).toBe(true);
    expect(chunks.at(-1)!.to >= addDays(r.to, 14)).toBe(true);
    for (const c of chunks) {
      expect(weekStartOf(c.from, 1)).toBe(c.from);
      expect(dayNumber(c.to) - dayNumber(c.from) + 1).toBe(CHUNK_DAYS);
    }
  });

  it("clés stables : défiler d'un jour réutilise les mêmes blocs", () => {
    const v = viewAt("2026-03-11", "day", 700, SCALE);
    const a = loadChunks(v, 1).map((c) => c.from);
    const b = loadChunks(scrollBy(v, SCALE.day), 1).map((c) => c.from);
    expect(b.filter((x) => !a.includes(x)).length).toBeLessThanOrEqual(1);
    expect(a.filter((x) => b.includes(x)).length).toBeGreaterThanOrEqual(a.length - 1);
  });

  it("regroupement en requêtes contiguës de 400 jours au plus", () => {
    const chunks = Array.from({ length: 30 }, (_, i) => ({ from: addDays("2026-01-05", i * 28), to: addDays("2026-01-05", i * 28 + 27) }));
    const reqs = mergeChunks(chunks);
    expect(reqs.length).toBeGreaterThan(1);
    for (const q of reqs) expect(dayNumber(q.to) - dayNumber(q.from)).toBeLessThanOrEqual(400);
    expect(reqs[0]!.from).toBe("2026-01-05");
    expect(reqs.at(-1)!.to).toBe(chunks.at(-1)!.to);
    expect(mergeChunks([chunks[0]!, chunks[2]!])).toHaveLength(2); // trou : deux requêtes
  });
});
