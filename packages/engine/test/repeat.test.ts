// Occurrences d'une série (BR-25) : même sémantique que allocation_covers_day (schema.sql) et allocationCoversDay.
import { describe, expect, it } from "vitest";
import { addDays, toIso, toMs, DAY_MS } from "../src/dates";
import { allocationCoversDay } from "../src/load";
import { SeriesSplitError, expandOccurrences, seriesEnd, splitSeries, type RepeatInput } from "../src/repeat";

const a = (startDate: string, endDate: string, repeatState: RepeatInput["repeatState"], repeatEndDate: string | null = null): RepeatInput =>
  ({ startDate, endDate, repeatState, repeatEndDate });

// @BR-25
describe("expandOccurrences", () => {
  it("sans répétition : le bloc lui-même s'il touche la fenêtre", () => {
    expect(expandOccurrences(a("2026-03-02", "2026-03-04", "none"), "2026-03-01", "2026-03-31"))
      .toEqual([{ index: 0, startDate: "2026-03-02", endDate: "2026-03-04" }]);
    expect(expandOccurrences(a("2026-03-02", "2026-03-04", "none"), "2026-03-05", "2026-03-31")).toEqual([]);
  });

  it("hebdomadaire : une occurrence tous les 7 jours, dernière tronquée à la fin de série incluse", () => {
    const occ = expandOccurrences(a("2026-03-02", "2026-03-04", "weekly", "2026-03-17"), "2026-03-01", "2026-03-31");
    expect(occ).toEqual([
      { index: 0, startDate: "2026-03-02", endDate: "2026-03-04" },
      { index: 1, startDate: "2026-03-09", endDate: "2026-03-11" },
      { index: 2, startDate: "2026-03-16", endDate: "2026-03-17" },
    ]);
  });

  it("quotidien : une occurrence par jour", () => {
    expect(expandOccurrences(a("2026-03-02", "2026-03-02", "daily", "2026-03-04"), "2026-03-01", "2026-03-31").map((o) => o.startDate))
      .toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
  });

  it("mensuel : même jour du mois, ramené au dernier jour valide, calculé depuis l'origine", () => {
    const occ = expandOccurrences(a("2026-01-31", "2026-01-31", "monthly", "2026-05-31"), "2026-01-01", "2026-06-30");
    expect(occ.map((o) => o.startDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("fenêtre au milieu de la série : seules les occurrences qui la touchent, index conservé", () => {
    const occ = expandOccurrences(a("2026-03-02", "2026-03-06", "weekly", "2026-12-31"), "2026-06-03", "2026-06-10");
    expect(occ).toEqual([
      { index: 13, startDate: "2026-06-01", endDate: "2026-06-05" },
      { index: 14, startDate: "2026-06-08", endDate: "2026-06-12" },
    ]);
  });

  it("refuse une fenêtre invalide ou > 400 jours (mêmes bornes que les fonctions SQL)", () => {
    expect(() => expandOccurrences(a("2026-03-02", "2026-03-02", "daily", "2027-12-31"), "2026-01-01", "2027-06-01")).toThrow(/INVALID_RANGE/);
  });

  it("seriesEnd : fin de série si répétée, sinon fin du bloc", () => {
    expect(seriesEnd(a("2026-03-02", "2026-03-04", "none"))).toBe("2026-03-04");
    expect(seriesEnd(a("2026-03-02", "2026-03-04", "weekly", "2026-04-30"))).toBe("2026-04-30");
  });

  it("propriété : l'union des occurrences = les jours couverts par allocationCoversDay dans la série (graine fixe)", () => {
    let s = 42;
    const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let i = 0; i < 400; i++) {
      const start = addDays("2026-01-01", int(0, 90));
      const end = addDays(start, int(0, 9));
      const kind = (["none", "daily", "weekly", "monthly"] as const)[int(0, 3)]!;
      const al = a(start, end, kind, kind === "none" ? null : addDays(end, int(0, 200)));
      const from = addDays("2026-01-01", int(-10, 200));
      const to = addDays(from, int(0, 120));
      const days = new Set<string>();
      for (const o of expandOccurrences(al, from, to)) {
        for (let ms = toMs(o.startDate); ms <= toMs(o.endDate); ms += DAY_MS) {
          const d = toIso(ms);
          if (d >= from && d <= to) days.add(d);
        }
      }
      const want = new Set<string>();
      for (let ms = toMs(from); ms <= toMs(to); ms += DAY_MS) {
        const d = toIso(ms);
        if (d >= al.startDate && d <= seriesEnd(al) && allocationCoversDay(al, d)) want.add(d);
      }
      expect([...days].sort(), JSON.stringify({ al, from, to })).toEqual([...want].sort());
    }
  });
});

describe("allocationCoversDay : bords de série", () => {
  it("série répétée : aucun jour avant son début", () => {
    for (const repeatState of ["daily", "weekly", "monthly"] as const) {
      expect(allocationCoversDay({ startDate: "2026-03-02", endDate: "2026-03-03", repeatState }, "2026-03-01")).toBe(false);
    }
  });
});

// Modifier « cette occurrence » (US-3.3, décision 10 du registre) : la série est découpée, sans table d'exceptions.
describe("splitSeries", () => {
  it("occurrence du milieu : série d'avant bornée à la veille, occurrence seule, série d'après", () => {
    const s = { ...a("2026-03-02", "2026-03-04", "weekly", "2026-03-31"), id: "100" };
    expect(splitSeries(s, 2)).toEqual({
      before: { ...s, repeatEndDate: "2026-03-15" },
      occurrence: { ...s, startDate: "2026-03-16", endDate: "2026-03-18", repeatState: "none", repeatEndDate: null },
      after: { ...s, startDate: "2026-03-23", endDate: "2026-03-25" },
    });
  });

  it("première ou dernière occurrence : pas de série d'avant / d'après ; dernière tronquée comme à l'affichage", () => {
    const s = a("2026-03-02", "2026-03-04", "weekly", "2026-03-17");
    expect(splitSeries(s, 0).before).toBeNull();
    expect(splitSeries(s, 0).after).toEqual({ ...s, startDate: "2026-03-09", endDate: "2026-03-11" });
    expect(splitSeries(s, 2)).toMatchObject({ after: null, occurrence: { startDate: "2026-03-16", endDate: "2026-03-17" } });
  });

  it("avant-dernière occurrence d'une série qui finit au milieu d'un bloc : « après » est l'occurrence tronquée, non répétée", () => {
    // Lundi-mercredi hebdomadaire, fin de série un mardi : la dernière occurrence (16-17/03) est tronquée.
    const s = a("2026-03-02", "2026-03-04", "weekly", "2026-03-17");
    expect(splitSeries(s, 1).after).toEqual({ ...s, startDate: "2026-03-16", endDate: "2026-03-17", repeatState: "none", repeatEndDate: null });
    // Fin de série un mardi plus loin : « après » reste une série, sa dernière occurrence tronquée par repeatEndDate.
    const longer = a("2026-03-02", "2026-03-04", "weekly", "2026-03-24");
    expect(splitSeries(longer, 1).after).toEqual({ ...longer, startDate: "2026-03-16", endDate: "2026-03-18" });
  });

  it("refus typés : SeriesSplitError porte le code, le message garde le préfixe", () => {
    const codeOf = (f: () => unknown) => {
      try { f(); } catch (e) { expect(e).toBeInstanceOf(SeriesSplitError); expect(e).toBeInstanceOf(Error); return [(e as SeriesSplitError).code, (e as Error).message.split(":")[0]]; }
      return null;
    };
    expect(codeOf(() => splitSeries(a("2026-03-02", "2026-03-04", "none"), 0))).toEqual(["NOT_A_SERIES", "NOT_A_SERIES"]);
    expect(codeOf(() => splitSeries(a("2026-03-02", "2026-03-04", "weekly", "2026-03-17"), 3))).toEqual(["OCCURRENCE_NOT_FOUND", "OCCURRENCE_NOT_FOUND"]);
    expect(codeOf(() => splitSeries(a("2026-03-02", "2026-03-04", "daily", "2026-03-31"), 1))).toEqual(["SERIES_OVERLAPPING", "SERIES_OVERLAPPING"]);
    expect(codeOf(() => splitSeries(a("2026-01-31", "2026-01-31", "monthly", "2026-06-30"), 0))).toEqual(["SERIES_MONTHLY_CLAMPED", "SERIES_MONTHLY_CLAMPED"]);
  });

  it("refus : occurrence hors série, série non répétée, blocs qui se chevauchent, origine mensuelle ramenée", () => {
    expect(() => splitSeries(a("2026-03-02", "2026-03-04", "weekly", "2026-03-17"), 3)).toThrow(/OCCURRENCE_NOT_FOUND/);
    expect(() => splitSeries(a("2026-03-02", "2026-03-04", "none"), 0)).toThrow(/NOT_A_SERIES/);
    expect(() => splitSeries(a("2026-03-02", "2026-03-04", "daily", "2026-03-31"), 1)).toThrow(/SERIES_OVERLAPPING/);
    // 31 janvier mensuel : l'occurrence suivant février (28) ne peut pas servir d'origine sans perdre le 31.
    expect(() => splitSeries(a("2026-01-31", "2026-01-31", "monthly", "2026-06-30"), 0)).toThrow(/SERIES_MONTHLY_CLAMPED/);
  });

  it("propriété : jours couverts avant = avant + occurrence + après, morceaux disjoints (graine fixe)", () => {
    const cov = (x: RepeatInput | null, d: string) => !!x && d >= x.startDate && d <= seriesEnd(x) && allocationCoversDay(x, d);
    let s = 7;
    const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const start = addDays("2026-01-01", int(0, 60));
      const kind = (["daily", "weekly", "monthly"] as const)[int(0, 2)]!;
      const end = addDays(start, kind === "daily" ? 0 : int(0, 6));
      const al = a(start, end, kind, addDays(end, int(0, 300)));
      const occ = expandOccurrences(al, al.startDate, seriesEnd(al));
      let parts;
      try { parts = splitSeries(al, int(0, occ.length - 1)); } catch (e) { expect((e as SeriesSplitError).code).toBe("SERIES_MONTHLY_CLAMPED"); continue; }
      checked++;
      // Chaque morceau respecte chk_alloc_repeat (schema.sql) et ne dépasse pas la série d'origine.
      for (const x of [parts.before, parts.occurrence, parts.after]) {
        if (!x) continue;
        const ctx = JSON.stringify({ al, x });
        expect(x.endDate >= x.startDate, ctx).toBe(true);
        expect(x.endDate <= seriesEnd(al), ctx).toBe(true);
        if (x.repeatState === "none") expect(x.repeatEndDate, ctx).toBeNull();
        else expect(x.repeatEndDate !== null && x.repeatEndDate >= x.endDate, ctx).toBe(true);
      }
      for (let ms = toMs(al.startDate); ms <= toMs(seriesEnd(al)); ms += DAY_MS) {
        const d = toIso(ms);
        const hits = [parts.before, parts.occurrence, parts.after].filter((x) => cov(x, d)).length;
        // Message construit seulement en cas d'écart : un JSON.stringify par jour et par cas coûtait l'essentiel des 1,4 s du test
        // (timeout de 5 s dépassé sous charge de la VM).
        if (hits !== (cov(al, d) ? 1 : 0)) expect(hits, JSON.stringify({ al, d, parts })).toBe(cov(al, d) ? 1 : 0);
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});
