// Libellé accessible d'un bloc : projet, dates, heures ou %, tentatif, répétition ; FR et EN depuis le catalogue.
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n";
import { blockLabeler } from "../src/schedule/block-label";
import type { GridBlock } from "../src/schedule/grid-model";

const b = (over: Partial<GridBlock> = {}): GridBlock => ({
  key: "1:0", allocationId: "1", x: 0, y: 0, w: 10, h: 10, color: "#3B82F6", label: "Refonte", tentative: false, clippedStart: false, clippedEnd: false,
  startDate: "2026-10-19", endDate: "2026-10-20", hoursPerDay: 4, percent: null, repeat: "none", ...over,
});

describe("blockLabeler", () => {
  it("FR : plage en heures, jour seul, pourcentage, tentatif, série", () => {
    const l = blockLabeler(createI18n("fr"));
    expect(l(b())).toBe("Refonte, du lun. 19 oct. au mar. 20 oct., 4 h par jour");
    expect(l(b({ endDate: "2026-10-19", hoursPerDay: 2, repeat: "weekly" }))).toBe("Refonte, le lun. 19 oct., 2 h, chaque semaine");
    expect(l(b({ hoursPerDay: null, percent: 50, tentative: true }))).toBe("Refonte, du lun. 19 oct. au mar. 20 oct., 50 %, tentatif");
  });

  it("EN", () => {
    const l = blockLabeler(createI18n("en"));
    expect(l(b({ hoursPerDay: 7.5, repeat: "monthly" }))).toBe("Refonte, Mon, Oct 19 to Tue, Oct 20, 7.5 h per day, every month");
  });
});
