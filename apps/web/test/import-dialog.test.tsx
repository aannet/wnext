// @vitest-environment jsdom
// Import CSV (US-1.2), boîte de dialogue : type + fichier -> « Analyser » (dryRun) -> aperçu (compteurs, erreurs par ligne
// traduites) -> import des lignes valides (skipInvalid explicite) -> résultat. Sans erreur : « Importer ». Erreur de la source
// traduite. Échap ferme.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoImportSource, demoImportSnapshot, type ImportSource } from "../src/data/import-source";
import { demoSchedule } from "../src/demo";
import { createI18n } from "../src/i18n";
import { ImportDialog } from "../src/imports/import-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
const button = (name: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? "")));
const click = async (name: string | RegExp) => { const b = button(name); if (!b) throw new Error(`bouton absent : ${name}`); act(() => b.click()); await flush(); };
async function chooseFile(text: string) {
  const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([text], "import.csv", { type: "text/csv" })] });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  await flush();
}
const demoImports = () => createDemoImportSource(demoImportSnapshot(demoSchedule(TODAY), TODAY));
const readFile = (f: File) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(f); });

describe("ImportDialog", () => {
  it("3 lignes dont 1 en erreur : aperçu et tableau d'erreurs, puis import des 2 lignes valides et résultat", async () => {
    let closed = 0;
    mount(<ImportDialog i18n={createI18n("fr")} source={demoImports()} onClose={() => closed++} readFile={readFile} />);
    expect(button("Analyser")!.disabled).toBe(true);
    expect(host.textContent).toContain("name*, email*");
    await chooseFile("Nom;E-mail;Département\nAlice;alice@x.fr;Nouveau\nBruno;pas-un-mail;\nChloé;chloe@x.fr;\n");
    await click("Analyser");
    expect(host.querySelector("h3")!.textContent).toBe("Aperçu : rien n’est encore importé");
    expect([...host.querySelectorAll(".wn-import-counters li")].map((li) => li.textContent)).toEqual([
      "3 lignes lues", "2 créations", "0 mise à jour", "0 ligne inchangée", "1 ligne en erreur",
    ]);
    expect(host.textContent).toContain("Départements créés : Nouveau");
    expect([...host.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["3", "email", "E-mail invalide", "pas-un-mail"],
    ]);
    expect(button("Importer")).toBeUndefined();
    await click("Importer les 2 lignes valides");
    expect(host.querySelector("h3")!.textContent).toBe("Import terminé");
    expect(host.textContent).toContain("2 créations");
    await click("Fermer");
    expect(closed).toBe(1);
  });

  it("sans erreur : « Importer » ; ré-import du même fichier : rien à importer (anglais)", async () => {
    const source = demoImports();
    mount(<ImportDialog i18n={createI18n("en")} source={source} onClose={() => {}} readFile={readFile} />);
    act(() => { const s = host.querySelector("select")!; s.value = "clients"; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await chooseFile("name\nAcme\n");
    await click("Analyse");
    await click("Import");
    expect(host.textContent).toContain("Import complete");
    await source.run("clients", "name\nAcme\n", { dryRun: true }).then((r) => expect(r.ok && r.report.unchanged).toBe(1));
  });

  it("refus de la source traduit (FORBIDDEN) ; Échap ferme", async () => {
    const forbidden: ImportSource = { run: async () => ({ ok: false, error: "FORBIDDEN", params: {} }) };
    let closed = 0;
    mount(<ImportDialog i18n={createI18n("fr")} source={forbidden} onClose={() => closed++} readFile={async () => "x"} />);
    await chooseFile("x");
    await click("Analyser");
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Seuls les propriétaires et les administrateurs du compte peuvent importer.");
    act(() => host.querySelector("[role=dialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(closed).toBe(1);
  });

  it("fichier illisible : message", async () => {
    mount(<ImportDialog i18n={createI18n("fr")} source={demoImports()} onClose={() => {}} readFile={async () => { throw new Error("x"); }} />);
    await chooseFile("x");
    await click("Analyser");
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Impossible de lire ce fichier.");
  });
});
