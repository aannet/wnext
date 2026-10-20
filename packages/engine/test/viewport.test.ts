// Vue horizontale du Schedule (ADR-002 §2-3) : zoom, centre conservé, « Aujourd'hui », chargement par blocs.
import { describe, expect, it } from "vitest";
import { addDays } from "../src/dates";
import {
  CHUNK_DAYS, chunkCover, coreRange, coversRange, dateAtX, dayNumber, extendTrack, goToday, headerCells, loadChunks, mergeChunks,
  neighborDays, page, scrollBy, scrollLeftOf, setZoom, stepPeriod, todayIn, trackAround, trackDays, trackWidthPx, viewAt,
  viewAtScroll, visibleRange, weekStartOf, xOfDate,
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

describe("bornes et cas limites", () => {
  it("chargement : les blocs ne débordent pas de la plage planifiable de plus d'un bloc", () => {
    const bounds = { first: "2026-03-01", last: "2026-03-31" };
    const v = viewAt("2026-03-15", "month", 2000, SCALE); // vue plus large que la plage
    const chunks = loadChunks(v, 1, 28, bounds);
    expect(chunks[0]!.from <= bounds.first && chunks[0]!.to >= bounds.first).toBe(true);
    expect(chunks.at(-1)!.from <= bounds.last && chunks.at(-1)!.to >= bounds.last).toBe(true);
    expect(chunks.length).toBeLessThanOrEqual(3);
    // bornes plus larges que la vue élargie : aucune coupe
    expect(loadChunks(v, 1, 28, { first: "2020-01-01", last: "2030-12-31" })).toEqual(loadChunks(v, 1, 28));
  });

  it("vue plus large que la plage planifiable : centrée sur la plage", () => {
    const bounds = { first: "2026-03-01", last: "2026-03-10" }; // 10 jours, vue de 35
    const v = goToday(viewAt("2026-01-01", "week", 700, SCALE), "2026-06-01", bounds);
    expect(v.center).toBe((dayNumber("2026-03-01") + dayNumber("2026-03-10") + 1) / 2);
  });

  it("déplacement à l'intérieur des bornes : vue inchangée (même objet)", () => {
    const bounds = { first: "2026-01-01", last: "2026-12-31" };
    const v = viewAt("2026-06-01", "day", 700, SCALE);
    expect(scrollBy(v, 0, bounds)).toEqual(v);
  });

  it("regroupement : entrée dans le désordre triée d'abord", () => {
    const c = (from: string) => ({ from, to: addDays(from, 27) });
    expect(mergeChunks([c("2026-02-02"), c("2026-01-05")])).toEqual([{ from: "2026-01-05", to: "2026-03-01" }]);
  });
});

// @BR-18
describe("todayIn", () => {
  it("date du jour dans le fuseau du compte, pas en UTC", () => {
    const t = new Date("2026-10-18T23:30:00Z");
    expect(todayIn("UTC", t)).toBe("2026-10-18");
    expect(todayIn("Europe/Paris", t)).toBe("2026-10-19");
    expect(todayIn("America/Los_Angeles", t)).toBe("2026-10-18");
    expect(todayIn("Pacific/Kiritimati", new Date("2026-10-18T10:30:00Z"))).toBe("2026-10-19"); // UTC+14
  });

  it("changement d'heure : minuit local juste après le passage à l'heure d'hiver", () => {
    expect(todayIn("Europe/Paris", new Date("2026-10-24T22:30:00Z"))).toBe("2026-10-25");
    expect(todayIn("Europe/Paris", new Date("2026-10-25T22:59:00Z"))).toBe("2026-10-25");
    expect(todayIn("Europe/Paris", new Date("2026-10-25T23:00:00Z"))).toBe("2026-10-26");
  });

  it("fuseau inconnu : INVALID_TIMEZONE", () => {
    expect(() => todayIn("Mars/Olympus", new Date())).toThrow(/INVALID_TIMEZONE/);
  });
});

describe("piste du défilement continu", () => {
  const T = { first: "2026-01-01", last: "2026-12-31" }; // 365 jours

  it("piste ±12 mois autour d'aujourd'hui, coupée aux bornes", () => {
    expect(trackAround("2026-10-20")).toEqual({ first: "2025-10-20", last: "2027-10-20" });
    expect(trackAround("2026-10-20", 30, { first: "2026-10-01", last: "2026-12-31" })).toEqual({ first: "2026-10-01", last: "2026-11-19" });
    expect(trackAround("2026-12-20", 30, { first: "2026-10-01", last: "2026-12-31" }).last).toBe("2026-12-31");
    expect(trackDays(T)).toBe(365);
    expect(trackWidthPx(T, SCALE.week)).toBe(365 * 20);
  });

  it("pixel <-> date : scrollLeft 0 = début de piste, aller-retour exact", () => {
    const v = viewAtScroll(T, 0, "day", 700, SCALE.day);
    expect(visibleRange(v)).toEqual({ from: "2026-01-01", to: "2026-01-07" });
    expect(dateAtX(v, 0)).toBe("2026-01-01");
    for (const s of [0, 1234.5, 20_000]) expect(scrollLeftOf(T, viewAtScroll(T, s, "day", 700, SCALE.day))).toBeCloseTo(s, 6);
    const w = viewAtScroll(T, 100 * SCALE.day + 50, "day", 700, SCALE.day); // 100,5 jours plus loin
    expect(dateAtX(w, 0)).toBe("2026-04-11");
  });

  it("scrollLeft borné à la piste ; vue plus large que la piste : 0", () => {
    expect(scrollLeftOf(T, viewAt("2025-06-01", "day", 700, SCALE))).toBe(0);
    expect(scrollLeftOf(T, viewAt("2027-06-01", "day", 700, SCALE))).toBe(365 * 100 - 700);
    expect(scrollLeftOf({ first: "2026-01-01", last: "2026-01-03" }, viewAt("2026-01-02", "day", 700, SCALE))).toBe(0);
  });

  it("bord atteint : la piste s'allonge, le décalage à gauche garde la vue immobile", () => {
    const v = viewAt("2026-01-10", "day", 700, SCALE);
    const left = extendTrack(T, v, { marginDays: 28, stepDays: 90 });
    expect(left.track).toEqual({ first: "2025-10-03", last: "2026-12-31" });
    expect(left.shiftPx).toBe(90 * 100);
    expect(scrollLeftOf(left.track, v)).toBeCloseTo(scrollLeftOf(T, v) + left.shiftPx, 6);
    const right = extendTrack(T, viewAt("2026-12-20", "day", 700, SCALE), { marginDays: 28, stepDays: 90 });
    expect([right.track.last, right.shiftPx]).toEqual(["2027-03-31", 0]);
    const mid = viewAt("2026-06-01", "day", 700, SCALE);
    expect(extendTrack(T, mid, { marginDays: 28, stepDays: 90 }).track).toBe(T);
  });

  it("saut loin hors piste : l'extension couvre la cible ; bornes planifiables respectées", () => {
    const far = viewAt("2028-06-01", "day", 700, SCALE);
    const e = extendTrack(T, far, { marginDays: 28, stepDays: 90 });
    expect(e.track.last).toBe(addDays(visibleRange(far).to, 28));
    const b = { first: "2025-12-01", last: "2027-01-15" };
    const capped = extendTrack(T, viewAt("2026-01-05", "day", 700, SCALE), { marginDays: 28, stepDays: 90, bounds: b });
    expect(capped.track.first).toBe("2025-12-01");
    expect(extendTrack(T, far, { marginDays: 28, stepDays: 90, bounds: b }).track.last).toBe("2027-01-15");
    const before = viewAt("2024-01-01", "day", 700, SCALE);
    expect(extendTrack(T, before, { marginDays: 28, stepDays: 90 }).track.first).toBe(addDays(visibleRange(before).from, -28));
  });

  it("précédent / suivant d'une période : jour, semaine, mois calendaire", () => {
    const at = (d: string, z: "day" | "week" | "month") => setZoom(viewAt(d, "day", 700, SCALE), z, SCALE);
    const mid = (v: ReturnType<typeof viewAt>) => dateAtX(v, v.widthPx / 2);
    expect(mid(stepPeriod(at("2026-03-11", "day"), 1))).toBe("2026-03-12");
    expect(mid(stepPeriod(at("2026-03-11", "week"), -1))).toBe("2026-03-04");
    expect(mid(stepPeriod(at("2026-01-31", "month"), 1))).toBe("2026-02-28");
    expect(mid(stepPeriod(at("2026-03-31", "month"), -1))).toBe("2026-02-28");
    const s = scrollBy(at("2026-03-11", "day"), 30); // centre fractionnaire conservé
    expect(stepPeriod(s, 1).center - s.center).toBeCloseTo(1, 9);
    expect(visibleRange(stepPeriod(viewAt("2026-12-30", "day", 700, SCALE), 1, T)).to).toBe("2026-12-31");
  });

  it("voisinage et couverture par blocs : stable tant qu'on reste dans la tranche", () => {
    expect(neighborDays(viewAt("2026-03-11", "day", 700, SCALE))).toBe(CHUNK_DAYS);
    expect(neighborDays(viewAt("2026-03-11", "week", 2000, SCALE))).toBe(100); // une largeur de vue
    expect(neighborDays(viewAt("2026-03-11", "month", 1000, SCALE))).toBe(72); // 200 j visibles : plafonné
    expect(neighborDays(viewAt("2026-03-11", "month", 2000, SCALE))).toBe(0); // 400 j visibles
    for (const w of [500, 1000, 1500, 1800]) {
      const m = viewAt("2026-03-11", "month", w, SCALE);
      const c = chunkCover(m, 1, neighborDays(m));
      expect(dayNumber(c.to) - dayNumber(c.from)).toBeLessThanOrEqual(400);
    }
    const v = viewAt("2026-03-11", "day", 700, SCALE);
    const c = chunkCover(v, 1, 28);
    expect(coversRange(c, { from: addDays(visibleRange(v).from, -28), to: addDays(visibleRange(v).to, 28) })).toBe(true);
    expect(weekStartOf(c.from, 1)).toBe(c.from);
    expect(chunkCover(scrollBy(v, 1), 1, 28)).toEqual(c);
    expect(coversRange(c, { from: addDays(c.from, -1), to: c.to })).toBe(false);
  });

  it("vue plus large que 400 jours (écran 4K en zoom mois) : couverture bornée à 400 jours, centrée, stable", () => {
    const v = viewAt("2026-10-20", "month", 3840 - 140, { day: 96, week: 28, month: 8 }); // ~463 jours visibles
    const span = (r: { from: string; to: string }) => dayNumber(r.to) - dayNumber(r.from) + 1;
    expect(span(visibleRange(v))).toBeGreaterThan(400);
    const c = chunkCover(v, 1, neighborDays(v));
    expect(span(c)).toBeLessThanOrEqual(400);
    expect(weekStartOf(c.from, 1)).toBe(c.from);
    expect(coversRange(c, coreRange(v))).toBe(true);
    expect(c.from < "2026-10-20" && c.to > "2026-10-20").toBe(true);
    // Le cœur suit le centre ; la couverture ne change qu'après au moins un bloc de défilement.
    for (let d = 1; d < CHUNK_DAYS; d++) expect(coversRange(c, coreRange(scrollBy(v, d * 8)))).toBe(true);
    // Vue ordinaire : le cœur est le visible.
    const n = viewAt("2026-10-20", "day", 960, SCALE);
    expect(coreRange(n)).toEqual(visibleRange(n));
  });
});
