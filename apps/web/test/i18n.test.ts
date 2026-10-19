// i18n (ADR-002 §4, ADR-005 : Lingui) : catalogues FR/EN complets, pluriels ICU, pseudo-localisation.
import { describe, expect, it } from "vitest";
import { createI18n, pseudoLocalize } from "../src/i18n";
import { en } from "../src/i18n/messages.en";
import { fr } from "../src/i18n/messages.fr";

describe("catalogues", () => {
  it("FR et EN ont exactement les mêmes clés, aucune vide", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const v of [...Object.values(fr), ...Object.values(en)]) expect(v.trim()).not.toBe("");
  });

  it("pluriels ICU : règles de chaque langue (0 est singulier en français)", () => {
    const f = createI18n("fr"), e = createI18n("en");
    expect(f._("schedule.people.count", { count: 0 })).toBe("0 personne");
    expect(f._("schedule.people.count", { count: 2 })).toBe("2 personnes");
    expect(e._("schedule.people.count", { count: 1 })).toBe("1 person");
    expect(e._("schedule.people.count", { count: 0 })).toBe("0 people");
  });

  it("clé inconnue : rendue telle quelle, jamais d'exception (le lint des chaînes empêche d'en arriver là)", () => {
    expect(createI18n("fr")._("cle.inconnue")).toBe("cle.inconnue");
  });
});

describe("pseudo-localisation", () => {
  it("transforme le texte, garde les variables et la syntaxe ICU intactes", () => {
    expect(pseudoLocalize("Aujourd'hui")).toMatch(/^\[.*\]$/);
    expect(pseudoLocalize("Aujourd'hui")).not.toContain("Aujourd'hui");
    expect(pseudoLocalize("{count, plural, one {# person} other {# people}}")).toMatch(/^\[\{count, plural, one \{# .+\} other \{# .+\}\}\]$/);
  });

  it("tout le catalogue se rend en pseudo-locale sans erreur ni texte d'origine", () => {
    const p = createI18n("pseudo");
    for (const [k, v] of Object.entries(fr)) {
      const out = p._(k, { count: 3, date: "2026-10-19" });
      expect(out, k).toMatch(/^\[.*\]$/);
      if (!v.includes("{")) expect(out, k).not.toContain(v);
    }
  });
});
