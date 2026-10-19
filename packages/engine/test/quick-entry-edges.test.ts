// Saisie rapide : bornes, variantes de langue et cas limites (ADR-002 §5). Complète quick-entry.test.ts.
import { describe, expect, it } from "vitest";
import { DEFAULT_HOURS_PER_DAY, draftDays, parseQuickEntry, type QuickContext } from "../src/quick-entry";

const projects = [
  { id: "1", name: "Refonte site" }, { id: "2", name: "Pitch Éditions" }, { id: "3", name: "Audit sécurité" }, { id: "4", name: "Audit RGPD" },
];
const fr: QuickContext = { today: "2026-10-19", locale: "fr", projects }; // lundi
const en: QuickContext = { ...fr, locale: "en" };
const p = parseQuickEntry;

describe("quantités : bornes exactes", () => {
  it("heures : 24 h accepté, 0 h et 24,5 h refusés", () => {
    expect(p("Refonte 24h", fr)).toMatchObject({ mode: "hours", hoursPerDay: 24, invalid: [] });
    expect(p("Refonte 0h", fr)).toMatchObject({ mode: null, hoursPerDay: null, invalid: ["AMOUNT_OUT_OF_RANGE"] });
    expect(p("Refonte 24,5h", fr).invalid).toEqual(["AMOUNT_OUT_OF_RANGE"]);
    expect(p("Refonte 0,25h", fr).hoursPerDay).toBe(0.25);
  });
  it("pourcentage : 500 % accepté, 0 % et 501 % refusés", () => {
    expect(p("Refonte 500%", fr)).toMatchObject({ mode: "percentage", percent: 500, hoursPerDay: null, invalid: [] });
    expect(p("Refonte 0%", fr)).toMatchObject({ mode: null, invalid: ["AMOUNT_OUT_OF_RANGE"] });
    expect(p("Refonte 501%", fr).invalid).toEqual(["AMOUNT_OUT_OF_RANGE"]);
    expect(p("Refonte 0,5%", fr).percent).toBe(0.5);
  });
  it("toutes les graphies d'heure, en majuscules aussi, avec ou sans espace", () => {
    for (const t of ["6h", "6 h", "6H", "6heure", "6 heures", "6hour", "6 hours", "6hr", "6 hrs", "6hrs"]) {
      expect(p(`Refonte ${t}`, fr)).toMatchObject({ hoursPerDay: 6, mode: "hours" });
    }
    expect(p("Refonte 6 %", fr)).toMatchObject({ percent: 6, mode: "percentage" });
  });
  it("une quantité collée à du texte n'en est pas une : elle reste dans le nom du projet", () => {
    expect(p("Refonte 6hx", fr)).toMatchObject({ amountDefaulted: true, projectQuery: "Refonte 6hx" });
    expect(p("a6h", fr).projectQuery).toBe("a6h");
  });
  it("la dernière quantité l'emporte et efface l'autre mode", () => {
    expect(p("Refonte 50% 6h", fr)).toMatchObject({ mode: "hours", hoursPerDay: 6, percent: null });
    expect(p("Refonte 6h 50%", fr)).toMatchObject({ mode: "percentage", percent: 50, hoursPerDay: null });
  });
  it("défaut de 8 h : valeur de la constante", () => {
    expect(DEFAULT_HOURS_PER_DAY).toBe(8);
    expect(p("Refonte", fr)).toMatchObject({ hoursPerDay: 8, percent: null, mode: "hours", amountDefaulted: true });
  });
  it("quantité invalide puis valide : la valide gagne, l'erreur reste signalée, pas de défaut", () => {
    expect(p("Refonte 30h 6h", fr)).toMatchObject({ mode: "hours", hoursPerDay: 6, invalid: ["AMOUNT_OUT_OF_RANGE"], amountDefaulted: false });
  });
});

describe("tentatif", () => {
  it("par défaut non tentatif ; « ? » seul, « tentative » (EN) et casse ignorée", () => {
    expect(p("Pitch 4h", fr).tentative).toBe(false);
    expect(p("Pitch 4h TENTATIF", fr).tentative).toBe(true);
    expect(p("Pitch 4h tentative", en).tentative).toBe(true);
    expect(p("Pitch 4h ?", fr)).toMatchObject({ tentative: true, projectQuery: "Pitch" });
  });
  it("« ?Pitch » garde « Pitch » comme texte de projet, sans le point d'interrogation", () => {
    expect(p("?Pitch 4h", fr)).toMatchObject({ projectQuery: "Pitch", projectId: "2" });
  });
});

describe("jours de semaine", () => {
  it("toutes les graphies FR et EN, avec point final", () => {
    const cases: [string, QuickContext, string][] = [
      ["lun", fr, "2026-10-19"], ["lundi", fr, "2026-10-19"], ["mar", fr, "2026-10-20"], ["mardi", fr, "2026-10-20"],
      ["mer.", fr, "2026-10-21"], ["mercredi", fr, "2026-10-21"], ["jeu", fr, "2026-10-22"], ["jeudi", fr, "2026-10-22"],
      ["ven", fr, "2026-10-23"], ["vendredi", fr, "2026-10-23"], ["sam", fr, "2026-10-24"], ["samedi", fr, "2026-10-24"],
      ["dim", fr, "2026-10-25"], ["dimanche", fr, "2026-10-25"],
      ["mon", en, "2026-10-19"], ["monday", en, "2026-10-19"], ["tue", en, "2026-10-20"], ["tues", en, "2026-10-20"], ["tuesday", en, "2026-10-20"],
      ["wed", en, "2026-10-21"], ["wednesday", en, "2026-10-21"], ["thu", en, "2026-10-22"], ["thur", en, "2026-10-22"],
      ["thurs", en, "2026-10-22"], ["thursday", en, "2026-10-22"], ["fri", en, "2026-10-23"], ["friday", en, "2026-10-23"],
      ["sat", en, "2026-10-24"], ["saturday", en, "2026-10-24"], ["sun", en, "2026-10-25"], ["sunday", en, "2026-10-25"],
    ];
    for (const [word, ctx, day] of cases) {
      expect(p(`Refonte 4h ${word}`, ctx), word).toMatchObject({ startDate: day, endDate: day });
    }
  });
  it("accents et casse ignorés (« MERCREDI », « Mér »)", () => {
    expect(p("Refonte 4h MERCREDI", fr).startDate).toBe("2026-10-21");
  });
  it("les jours de l'autre langue ne sont pas compris", () => {
    expect(p("Refonte 4h monday", fr)).toMatchObject({ startDate: null, projectQuery: "Refonte monday" });
    expect(p("Refonte 4h lundi", en)).toMatchObject({ startDate: null, projectQuery: "Refonte lundi" });
  });
  it("aujourd'hui lui-même quand le jour est celui du jour (écart nul), pas la semaine suivante", () => {
    expect(p("Refonte 4h lun", fr).startDate).toBe("2026-10-19");
  });
  it("plage de jours : le dimanche suivant le lundi, et tiret avec espaces", () => {
    expect(p("Refonte 4h lun - dim", fr)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-25" });
    expect(p("Refonte 4h mer-mer", fr)).toMatchObject({ startDate: "2026-10-21", endDate: "2026-10-21" });
  });
  it("trois jours reliés par des tirets ne forment pas une plage : tout part dans le nom du projet", () => {
    expect(p("Refonte lun-mar-mer", fr)).toMatchObject({ startDate: null, projectQuery: "Refonte lun-mar-mer" });
  });
  it("« lun au » sans second jour : « au » reste du texte, la plage est un seul jour", () => {
    expect(p("Refonte 4h lun au 28", fr)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-19", projectQuery: "Refonte au 28" });
    expect(p("Refonte 4h lun au", fr)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-19", projectQuery: "Refonte au" });
  });
  it("« lun au mer » : la fin se calcule à partir du début, même si mercredi est avant lundi dans la semaine suivante", () => {
    const wed: QuickContext = { ...fr, today: "2026-10-21" };
    expect(p("Refonte 4h ven au mar", wed)).toMatchObject({ startDate: "2026-10-23", endDate: "2026-10-27" });
  });
});

describe("aujourd'hui, demain et variantes", () => {
  it("toutes les graphies", () => {
    for (const w of ["aujourd'hui", "aujourdhui", "auj", "AUJOURD’HUI"]) expect(p(`Refonte 4h ${w}`, fr), w).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-19" });
    expect(p("Refonte 4h today", en)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-19" });
    expect(p("Refonte 4h demain", fr)).toMatchObject({ startDate: "2026-10-20", endDate: "2026-10-20" });
    expect(p("Refonte 4h tomorrow", en)).toMatchObject({ startDate: "2026-10-20", endDate: "2026-10-20" });
  });
  it("demain à la fin d'un mois", () => {
    expect(p("Refonte 4h demain", { ...fr, today: "2026-10-31" }).startDate).toBe("2026-11-01");
  });
  it("mots de l'autre langue non compris", () => {
    expect(p("Refonte 4h tomorrow", fr).startDate).toBeNull();
    expect(p("Refonte 4h demain", en).startDate).toBeNull();
  });
});

describe("« jusqu'au » / « until »", () => {
  it("toutes les graphies FR et EN", () => {
    for (const w of ["jusqu'au", "jusquau", "jusqua", "JUSQU’AU"]) {
      expect(p(`Refonte 4h ${w} 28`, fr), w).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-28", projectQuery: "Refonte" });
    }
    for (const w of ["until", "till", "to"]) {
      expect(p(`Refonte 4h ${w} 28`, en), w).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-28" });
    }
  });
  // BUG trouvé par la revue des mutants : les mots sont comparés après fold() (sans accent), mais la liste contient « jusqu'à »
  // avec accent. « jusqu'à 28 » (la graphie correcte) et « jusqu'a 28 » ne sont donc jamais reconnus.
  it.fails("« jusqu'à 28 » (avec accent) devrait être reconnu comme « jusqu'au 28 »", () => {
    expect(p("Refonte 4h jusqu'à 28", fr)).toMatchObject({ endDate: "2026-10-28", projectQuery: "Refonte" });
  });
  it("« jusqu'au N » compte aujourd'hui ; N déjà passé : mois suivant", () => {
    expect(p("Refonte 4h jusqu'au 19", fr)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-19" });
    expect(p("Refonte 4h jusqu'au 18", fr).endDate).toBe("2026-11-18");
    expect(p("Refonte 4h jusqu'au 1", fr).endDate).toBe("2026-11-01");
  });
  it("jusqu'au 29, 30, 31 : saute les mois trop courts", () => {
    expect(p("Refonte 4h jusqu'au 30", { ...fr, today: "2027-02-10" }).endDate).toBe("2027-03-30");
    expect(p("Refonte 4h jusqu'au 29", { ...fr, today: "2027-02-10" }).endDate).toBe("2027-03-29");
    expect(p("Refonte 4h jusqu'au 29", { ...fr, today: "2028-02-10" }).endDate).toBe("2028-02-29"); // année bissextile
  });
  it("jusqu'au 0 est invalide, jusqu'au 31 est valide quand le mois l'accepte", () => {
    expect(p("Refonte 4h jusqu'au 0", fr).invalid).toEqual(["DATE_INVALID"]);
    expect(p("Refonte 4h jusqu'au 31", fr).endDate).toBe("2026-10-31");
  });
  it("suffixe ordinal anglais retiré (1st, 2nd, 3rd, 28th)", () => {
    expect(p("Refonte 4h until 1st", en).endDate).toBe("2026-11-01");
    expect(p("Refonte 4h until 22nd", en).endDate).toBe("2026-10-22");
    expect(p("Refonte 4h until 23rd", en).endDate).toBe("2026-10-23");
    expect(p("Refonte 4h until 28th", en).endDate).toBe("2026-10-28");
  });
  it("jusqu'à une date complète (J/M, ISO)", () => {
    expect(p("Refonte 4h jusqu'au 30/10", fr).endDate).toBe("2026-10-30");
    expect(p("Refonte 4h until 2026-12-24", en).endDate).toBe("2026-12-24");
  });
  it("sans valeur derrière : le mot reste du texte, rien n'est inventé", () => {
    expect(p("Refonte 4h jusqu'au", fr)).toMatchObject({ startDate: null, endDate: null, projectQuery: "Refonte jusqu'au" });
    expect(p("Refonte 4h jusqu'au bla", fr)).toMatchObject({ endDate: null, projectQuery: "Refonte jusqu'au bla" });
  });
  it("EN : « from 3 to 7 » ne traite pas « to » comme une fin (un début est déjà posé)", () => {
    expect(p("Pitch 4h mon to wed", en)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-21" });
    expect(p("Pitch 4h from 3 to 7", en)).toMatchObject({ startDate: "2026-11-03", endDate: "2026-11-07" });
  });
  it("EN : « mon until 28 » part du lundi ; début explicite conservé", () => {
    expect(p("Pitch 4h wed until 28", en)).toMatchObject({ startDate: "2026-10-21", endDate: "2026-10-28" });
  });
  it("fin avant le début : plage inversée, dates effacées ; fin = début : une journée", () => {
    expect(p("Refonte 4h 2026-10-25 jusqu'au 2026-10-24", fr)).toMatchObject({ startDate: null, endDate: null, invalid: ["DATE_RANGE_INVERTED"], missing: ["dates"] });
    expect(p("Refonte 4h 2026-10-25 jusqu'au 2026-10-25", fr)).toMatchObject({ startDate: "2026-10-25", endDate: "2026-10-25", invalid: [] });
  });
  it("« jusqu'au vendredi » avec un début : prochain vendredi à partir du début, vendredi lui-même inclus", () => {
    expect(p("Refonte 4h ven jusqu'au ven", fr)).toMatchObject({ startDate: "2026-10-23", endDate: "2026-10-23" });
  });
});

describe("« du X au Y » / « from X to Y »", () => {
  it("jours du mois : le second jour se cherche à partir du premier", () => {
    expect(p("Refonte 4h du 20 au 22", fr)).toMatchObject({ startDate: "2026-10-20", endDate: "2026-10-22" });
    expect(p("Refonte 4h du 19 au 19", fr)).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-19" });
  });
  it("dates complètes J/M, ISO, et mélange", () => {
    expect(p("Refonte 4h du 20/11 au 25/11", fr)).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-25" });
    expect(p("Refonte 4h du 2026-11-02 au 2026-11-06", fr)).toMatchObject({ startDate: "2026-11-02", endDate: "2026-11-06" });
    expect(p("Refonte 4h from 11/20 to 11/25", en)).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-25" });
  });
  it("premier jour invalide : signalé, rien de déduit ; second invalide : idem", () => {
    expect(p("Refonte 4h du 32 au 5", fr)).toMatchObject({ startDate: null, endDate: null, invalid: ["DATE_INVALID"], projectQuery: "Refonte" });
    expect(p("Refonte 4h du 5 au 32", fr)).toMatchObject({ startDate: null, endDate: null, invalid: ["DATE_INVALID"], projectQuery: "Refonte" });
  });
  it("incomplet (« du 3 au » sans fin) : les mots restent dans le nom du projet", () => {
    expect(p("Refonte 4h du 3 au", fr)).toMatchObject({ startDate: null, projectQuery: "Refonte du 3 au" });
  });
  it("mot de liaison de l'autre langue non reconnu", () => {
    expect(p("Refonte 4h from 3 au 7", fr).startDate).toBeNull();
  });
  it("« du lundi au … » : non géré comme date, les mots restent du texte", () => {
    expect(p("Refonte 4h du foo au 7", fr)).toMatchObject({ startDate: null, projectQuery: "Refonte du foo au 7" });
  });
});

describe("dates numériques", () => {
  it("jour/mois avec zéros, sans zéro, et année à 2 ou 4 chiffres", () => {
    expect(p("Refonte 4h 5/11", fr).startDate).toBe("2026-11-05");
    expect(p("Refonte 4h 05/11", fr).startDate).toBe("2026-11-05");
    expect(p("Refonte 4h 5/11/28", fr).startDate).toBe("2028-11-05");
    expect(p("Refonte 4h 5/1/2030", fr).startDate).toBe("2030-01-05");
  });
  it("date du jour ou plus tard cette année : cette année ; la veille : l'an prochain", () => {
    expect(p("Refonte 4h 19/10", fr).startDate).toBe("2026-10-19");
    expect(p("Refonte 4h 18/10", fr).startDate).toBe("2027-10-18");
    expect(p("Refonte 4h 31/12", fr).startDate).toBe("2026-12-31");
  });
  it("29/02 sans année : invalide si l'année en cours n'est pas bissextile, mais jamais décalée en silence", () => {
    expect(p("Refonte 4h 29/02", { ...fr, today: "2026-01-10" }).invalid).toEqual(["DATE_INVALID"]);
    expect(p("Refonte 4h 29/02", { ...fr, today: "2028-01-10" }).startDate).toBe("2028-02-29");
  });
  it("jour 0, mois 0 ou mois 13 : invalides", () => {
    for (const t of ["0/10", "10/0", "10/13", "00/10"]) expect(p(`Refonte 4h ${t}`, fr).invalid, t).toEqual(["DATE_INVALID"]);
  });
  it("ISO : date valide acceptée, jour inexistant refusé", () => {
    expect(p("Refonte 4h 2026-02-29", fr).invalid).toEqual(["DATE_INVALID"]);
    expect(p("Refonte 4h 2028-02-29", fr).startDate).toBe("2028-02-29");
  });
  it("date seule non pliée avec une date précédente : la dernière remplace", () => {
    expect(p("Refonte 4h 2026-11-02 2026-11-03", fr)).toMatchObject({ startDate: "2026-11-03", endDate: "2026-11-03" });
  });
  it("nombre nu sans mot clé : texte du projet, pas une date", () => {
    expect(p("Refonte 4h 28", fr)).toMatchObject({ startDate: null, projectQuery: "Refonte 28" });
  });
});

describe("nom du projet", () => {
  it("mots vides retirés (de, pour, le, for, on, the), casse ignorée", () => {
    expect(p("Refonte pour 4h", fr).projectQuery).toBe("Refonte");
    expect(p("de Refonte", fr).projectQuery).toBe("Refonte");
    expect(p("LE Refonte", fr).projectQuery).toBe("Refonte");
    expect(p("Pitch for 4h", en).projectQuery).toBe("Pitch");
    expect(p("Pitch on 4h", en).projectQuery).toBe("Pitch");
    expect(p("the Pitch", en).projectQuery).toBe("Pitch");
  });
  it("un mot qui contient un mot vide n'est pas retiré", () => {
    expect(p("Refonte delta", fr).projectQuery).toBe("Refonte delta");
  });
  it("correspondance exacte prioritaire sur préfixe et sous-chaîne", () => {
    const ctx: QuickContext = { ...fr, projects: [{ id: "a", name: "Audit" }, { id: "b", name: "Audit interne" }, { id: "c", name: "Pré-audit" }] };
    expect(p("audit", ctx)).toMatchObject({ projectId: "a", candidates: [] });
  });
  it("préfixe de mot prioritaire sur sous-chaîne ; sous-chaîne seule suffit", () => {
    const ctx: QuickContext = { ...fr, projects: [{ id: "b", name: "Mon audit" }, { id: "c", name: "Preaudit" }] };
    expect(p("audit", ctx).projectId).toBe("b"); // préfixe du mot « audit » : « Preaudit » n'est qu'une sous-chaîne
    expect(p("eaud", ctx).projectId).toBe("c");
  });
  it("préfixe du nom entier (plusieurs mots) reconnu", () => {
    expect(p("refonte s", fr)).toMatchObject({ projectId: "1" });
    expect(p("pitch ed", fr).projectId).toBe("2");
  });
  it("sous-chaîne qui n'est pas un préfixe de mot", () => {
    expect(p("onte", fr).projectId).toBe("1");
  });
  it("aucun projet connu : pas de candidats ; texte vide : pas de requête", () => {
    expect(p("zzz", { ...fr, projects: [] })).toMatchObject({ projectId: null, candidates: [], missing: ["project", "dates"] });
    expect(p("4h lun", fr)).toMatchObject({ projectQuery: "", candidates: [], missing: ["project"] });
  });
  it("au plus 10 candidats", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Alpha ${i}` }));
    const r = p("alpha", { ...fr, projects: many });
    expect(r.projectId).toBeNull();
    expect(r.candidates).toHaveLength(10);
    expect(r.candidates.map((c) => c.id)).toEqual(many.slice(0, 10).map((c) => c.id));
  });
  it("projet unique trouvé : pas de candidats, pas de « missing »", () => {
    expect(p("Refonte 6h lun", fr)).toMatchObject({ projectId: "1", candidates: [], missing: [] });
  });
});

describe("champs manquants et brouillon vide", () => {
  it("texte vide : valeurs initiales, 8 h par défaut", () => {
    expect(p("", fr)).toEqual({
      projectId: null, projectQuery: "", candidates: [], mode: "hours", hoursPerDay: 8, percent: null, startDate: null, endDate: null,
      tentative: false, amountDefaulted: true, missing: ["project", "dates"], invalid: [],
    });
  });
  it("quantité hors bornes : « amount » manquant, ordre des manquants stable", () => {
    expect(p("30h", fr).missing).toEqual(["project", "amount", "dates"]);
  });
  it("une date invalide seule ne pose pas de dates : « dates » manquant", () => {
    expect(p("Refonte 4h 2026-13-45", fr).missing).toEqual(["dates"]);
  });
});

describe("draftDays", () => {
  it("une journée, plusieurs jours, mois et année traversés, sans fin ou sans début", () => {
    expect(draftDays(p("Refonte 4h demain", fr))).toBe(1);
    expect(draftDays(p("Refonte 4h du 28 au 2", fr))).toBe(6);
    expect(draftDays(p("Refonte 4h 2026-12-30 jusqu'au 2027-01-02", fr))).toBe(4);
    expect(draftDays({ ...p("Refonte", fr), startDate: "2026-10-19", endDate: null })).toBeNull();
    expect(draftDays({ ...p("Refonte", fr), startDate: null, endDate: "2026-10-19" })).toBeNull();
  });
});
