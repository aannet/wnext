// Lint « aucune chaîne visible en dur » de apps/web (ADR-002 §4) : le texte passe par le catalogue i18n.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { findUiStrings, lintUiStrings } from "../../scripts/lint-ui-strings.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const find = (src: string): { line: number; text: string }[] => findUiStrings("x.tsx", src);

describe("lint des chaînes de l'interface", () => {
  it("le dépôt réel passe", () => {
    expect(lintUiStrings({ root: repoRoot })).toEqual([]);
  });

  it("texte JSX en dur : refusé, avec sa ligne", () => {
    expect(find(`const A = () => <div>\n  <b>Aujourd'hui</b>\n</div>;`)).toEqual([{ line: 2, text: "Aujourd'hui" }]);
  });

  it("attributs lus par l'utilisateur ou un lecteur d'écran : refusés", () => {
    expect(find(`const A = () => <button title="Suivant" aria-label="Next" placeholder="Nom" alt="Logo" />;`).map((v) => v.text))
      .toEqual(["Suivant", "Next", "Nom", "Logo"]);
  });

  it("autorisé : texte traduit, ponctuation et espaces, attributs techniques, chaînes hors JSX", () => {
    expect(find(`const k = "schedule.today"; const A = () => <div className="row" data-id="x" role="grid">{i18n._(k)} · {" "} – 3</div>;`)).toEqual([]);
  });
});
