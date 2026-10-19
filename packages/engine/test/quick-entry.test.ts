// Saisie rapide (ADR-002 §5) : « Refonte 6h lun-mer », « 50 % jusqu'au 28 ».
import { describe, expect, it } from "vitest";
import { draftDays, parseQuickEntry, type QuickContext } from "../src/quick-entry";

const projects = [
  { id: "1", name: "Refonte site" }, { id: "2", name: "Pitch Éditions" }, { id: "3", name: "Audit sécurité" }, { id: "4", name: "Audit RGPD" },
];
const fr: QuickContext = { today: "2026-10-19", locale: "fr", projects }; // lundi
const en: QuickContext = { ...fr, locale: "en" };

describe("exemples de l'ADR-002", () => {
  it("« Refonte 6h lun-mer » : projet, 6 h/jour, lundi à mercredi de cette semaine", () => {
    expect(parseQuickEntry("Refonte 6h lun-mer", fr)).toMatchObject({
      projectId: "1", mode: "hours", hoursPerDay: 6, startDate: "2026-10-19", endDate: "2026-10-21", missing: [], invalid: [],
    });
  });

  it("« 50 % jusqu'au 28 » : pourcentage, d'aujourd'hui au 28, projet à demander", () => {
    expect(parseQuickEntry("50 % jusqu'au 28", fr)).toMatchObject({
      mode: "percentage", percent: 50, startDate: "2026-10-19", endDate: "2026-10-28", missing: ["project"],
    });
  });
});

describe("quantités", () => {
  it("6 h, 6,5h, 7.5 heures ; hors bornes signalé", () => {
    expect(parseQuickEntry("Refonte 6 h", fr).hoursPerDay).toBe(6);
    expect(parseQuickEntry("Refonte 6,5h", fr).hoursPerDay).toBe(6.5);
    expect(parseQuickEntry("Refonte 7.5 heures", fr).hoursPerDay).toBe(7.5);
    expect(parseQuickEntry("Refonte 30h", fr)).toMatchObject({ mode: null, invalid: ["AMOUNT_OUT_OF_RANGE"], missing: ["amount", "dates"] });
    expect(parseQuickEntry("Refonte 600%", fr).invalid).toEqual(["AMOUNT_OUT_OF_RANGE"]);
  });

  it("sans quantité : 8 h par jour par défaut, signalé ; quantité invalide : pas de défaut", () => {
    expect(parseQuickEntry("Refonte lun-mer", fr)).toMatchObject({ mode: "hours", hoursPerDay: 8, amountDefaulted: true, missing: [] });
    expect(parseQuickEntry("Refonte 6h lun-mer", fr).amountDefaulted).toBe(false);
    expect(parseQuickEntry("Refonte 30h", fr)).toMatchObject({ hoursPerDay: null, amountDefaulted: false });
  });
});

describe("dates", () => {
  it("jour seul, demain, aujourd'hui", () => {
    expect(parseQuickEntry("Refonte 4h jeudi", fr)).toMatchObject({ startDate: "2026-10-22", endDate: "2026-10-22" });
    expect(parseQuickEntry("Refonte 4h demain", fr)).toMatchObject({ startDate: "2026-10-20", endDate: "2026-10-20" });
    expect(parseQuickEntry("Refonte 4h aujourd’hui", fr)).toMatchObject({ startDate: "2026-10-19" });
  });

  it("jour déjà passé cette semaine : la semaine suivante ; plage qui enjambe le week-end", () => {
    const wed: QuickContext = { ...fr, today: "2026-10-21" };
    expect(parseQuickEntry("Refonte 4h lun", wed)).toMatchObject({ startDate: "2026-10-26" });
    expect(parseQuickEntry("Refonte 4h ven-mar", wed)).toMatchObject({ startDate: "2026-10-23", endDate: "2026-10-27" });
  });

  it("« du 3 au 7 » : prochains jours du mois ; fin après le début", () => {
    expect(parseQuickEntry("Audit sécu 7h du 3 au 7", fr)).toMatchObject({ projectId: "3", startDate: "2026-11-03", endDate: "2026-11-07" });
    expect(parseQuickEntry("Audit sécu 7h du 28 au 2", fr)).toMatchObject({ startDate: "2026-10-28", endDate: "2026-11-02" });
  });

  it("dates numériques J/M en FR, M/D en EN ; ISO partout ; date passée sans année : l'an prochain", () => {
    expect(parseQuickEntry("Refonte 4h 28/10", fr).startDate).toBe("2026-10-28");
    expect(parseQuickEntry("Refonte 4h 10/28", en).startDate).toBe("2026-10-28");
    expect(parseQuickEntry("Refonte 4h 2026-12-01", fr).startDate).toBe("2026-12-01");
    expect(parseQuickEntry("Refonte 4h 03/01", fr).startDate).toBe("2027-01-03");
  });

  it("dates invalides et plage inversée signalées, jamais devinées", () => {
    expect(parseQuickEntry("Refonte 4h 31/02", fr)).toMatchObject({ startDate: null, invalid: ["DATE_INVALID"] });
    expect(parseQuickEntry("Refonte 4h 2026-13-01", fr).invalid).toEqual(["DATE_INVALID"]);
    expect(parseQuickEntry("Refonte 4h jeudi jusqu'au 2026-10-20", fr)).toMatchObject({ startDate: null, invalid: ["DATE_RANGE_INVERTED"] });
    expect(parseQuickEntry("Refonte 4h jusqu'au 32", fr).invalid).toEqual(["DATE_INVALID"]);
  });

  it("« jusqu'au vendredi » / « until friday » : prochain vendredi à partir du début", () => {
    expect(parseQuickEntry("Refonte 4h jusqu'au vendredi", fr)).toMatchObject({ projectId: "1", startDate: "2026-10-19", endDate: "2026-10-23" });
    expect(parseQuickEntry("Refonte 4h mer jusqu'au lundi", fr)).toMatchObject({ startDate: "2026-10-21", endDate: "2026-10-26" });
    expect(parseQuickEntry("Pitch 4h until friday", en)).toMatchObject({ projectId: "2", endDate: "2026-10-23" });
  });

  it("« lun au mer » / « mon to wed » : plage de jours, le mot de liaison n'entre pas dans le nom du projet", () => {
    expect(parseQuickEntry("Refonte 6h lun au mer", fr)).toMatchObject({ projectId: "1", projectQuery: "Refonte", startDate: "2026-10-19", endDate: "2026-10-21" });
    expect(parseQuickEntry("Pitch 6h mon to wed", en)).toMatchObject({ projectId: "2", projectQuery: "Pitch", startDate: "2026-10-19", endDate: "2026-10-21" });
  });

  it("année explicite sur 2 ou 4 chiffres ; « du … au … » avec une date invalide signalé", () => {
    expect(parseQuickEntry("Refonte 4h 28/10/27", fr).startDate).toBe("2027-10-28");
    expect(parseQuickEntry("Refonte 4h 28/10/2027", fr).startDate).toBe("2027-10-28");
    expect(parseQuickEntry("Refonte 4h 29/02/2027", fr).invalid).toEqual(["DATE_INVALID"]);
    expect(parseQuickEntry("Refonte 4h du 3 au 31/02", fr)).toMatchObject({ projectId: "1", startDate: null, invalid: ["DATE_INVALID"] });
    expect(parseQuickEntry("Refonte 4h du 32 au 5", fr)).toMatchObject({ projectId: "1", invalid: ["DATE_INVALID"] });
  });

  it("« jusqu'au 31 » en novembre : le prochain mois qui a un 31", () => {
    expect(parseQuickEntry("Refonte 4h jusqu'au 31", { ...fr, today: "2026-11-05" }).endDate).toBe("2026-12-31");
  });
});

describe("anglais", () => {
  it("« Pitch 4h mon-wed », « 50% until 28th », « from 3 to 7 »", () => {
    expect(parseQuickEntry("Pitch 4h mon-wed", en)).toMatchObject({ projectId: "2", startDate: "2026-10-19", endDate: "2026-10-21" });
    expect(parseQuickEntry("50% until 28th", en)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-28" });
    expect(parseQuickEntry("Pitch 4h from 3 to 7", en)).toMatchObject({ startDate: "2026-11-03", endDate: "2026-11-07" });
    expect(parseQuickEntry("Pitch 4h tomorrow", en).startDate).toBe("2026-10-20");
  });
});

describe("projet et tentatif", () => {
  it("rapprochement sans accents ni casse ; plusieurs candidats : rien n'est choisi", () => {
    expect(parseQuickEntry("pitch editions 2h", fr).projectId).toBe("2");
    expect(parseQuickEntry("éditions 2h", fr).projectId).toBe("2"); // préfixe d'un mot du nom
    const amb = parseQuickEntry("Audit 2h", fr);
    expect(amb.projectId).toBeNull();
    expect(amb.candidates.map((p) => p.id)).toEqual(["3", "4"]);
    expect(parseQuickEntry("Inconnu 2h", fr)).toMatchObject({ projectId: null, candidates: [], projectQuery: "Inconnu" });
  });

  it("« ? Pitch », « ?Pitch », « tentatif » : allocation tentative", () => {
    for (const t of ["? Pitch 4h", "?Pitch 4h", "Pitch 4h tentatif"]) {
      expect(parseQuickEntry(t, fr)).toMatchObject({ tentative: true, projectId: "2" });
    }
  });

  it("ordre libre et texte vide", () => {
    expect(parseQuickEntry("lun-mer 6h Refonte", fr)).toMatchObject({ projectId: "1", hoursPerDay: 6, startDate: "2026-10-19" });
    expect(parseQuickEntry("   ", fr).missing).toEqual(["project", "dates"]);
  });

  it("draftDays pour l'aperçu", () => {
    expect(draftDays(parseQuickEntry("Refonte 6h lun-mer", fr))).toBe(3);
    expect(draftDays(parseQuickEntry("Refonte 6h", fr))).toBeNull();
  });
});
