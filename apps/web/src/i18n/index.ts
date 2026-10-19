// i18n de l'écran (ADR-002 §4, ADR-005 : Lingui). Catalogues TypeScript compilés au chargement
// (setMessagesCompiler) : pas d'extraction ni de plugin de build, les identifiants sont explicites.
// « pseudo » : catalogue FR transformé, pour repérer en test ou à l'écran une chaîne non traduite ou tronquée.
import { setupI18n, type I18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { en } from "./messages.en";
import { fr } from "./messages.fr";

export type UiLocale = "fr" | "en" | "pseudo";
export type { MessageKey } from "./messages.fr";

const ACCENTS: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", c: "ç", n: "ñ", y: "ý" };

/** Accentue le texte hors syntaxe ICU : profondeur d'accolades paire = texte, impaire = argument ({count, plural, ...}). */
export function pseudoLocalize(message: string): string {
  let depth = 0;
  let out = "";
  for (const ch of message) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    out += depth % 2 === 0 && ch !== "}" && ch !== "#" ? (ACCENTS[ch] ?? ch) : ch;
  }
  return `[${out}]`;
}

export function createI18n(locale: UiLocale): I18n {
  const i18n = setupI18n();
  i18n.setMessagesCompiler(compileMessage);
  const messages = locale === "en" ? en : locale === "fr" ? fr : Object.fromEntries(Object.entries(fr).map(([k, v]) => [k, pseudoLocalize(v)]));
  // La pseudo-locale suit les règles de pluriel du français.
  const tag = locale === "pseudo" ? "fr" : locale;
  i18n.load(tag, messages);
  i18n.activate(tag);
  return i18n;
}
