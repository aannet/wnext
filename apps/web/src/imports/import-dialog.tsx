// Import CSV simple (US-1.2) : boîte de dialogue ouverte par le bouton « Importer » de la barre d'état.
//  1. Choix du type (personnes, projets, clients) et du fichier ; « Analyser » envoie un dryRun (rien n'est écrit).
//  2. Aperçu : compteurs (créations, mises à jour, inchangées, erreurs), références créées, colonnes ignorées, tableau des
//     erreurs par ligne (codes stables traduits ici). Sans erreur : « Importer ». Avec erreurs : « Importer les N lignes
//     valides » (skipInvalid, règle du contrat : jamais implicite) ; corriger puis réimporter est sans risque (idempotent).
//  3. Résultat (mêmes compteurs). Échap ou « Fermer » ferme et rend le focus au bouton d'ouverture (géré par l'appelant).
import type { I18n } from "@lingui/core";
import type { ImportKind, ImportReport, ImportRowError } from "@wnext/contracts";
import { IMPORT_FIELDS } from "@wnext/engine";
import { useState, type ReactNode } from "react";
import type { ImportFailure, ImportSource } from "../data/import-source";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";

const KINDS: readonly ImportKind[] = ["people", "projects", "clients"];
type Phase = { kind: "form" } | { kind: "preview"; report: ImportReport } | { kind: "done"; report: ImportReport };

export interface ImportDialogProps {
  i18n: I18n;
  source: ImportSource;
  onClose(): void;
  /** Lecture du fichier (tests) ; défaut : File.text(). */
  readFile?(file: File): Promise<string>;
}

export function ImportDialog({ i18n, source, onClose, readFile = (f) => f.text() }: ImportDialogProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [kind, setKind] = useState<ImportKind>("people");
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: ImportFailure, params: Record<string, unknown>) => setError(t(`import.error.${e}`, params));
  async function analyze() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    let text: string;
    try { text = await readFile(file); } catch { setBusy(false); setError(t("import.error.read")); return; }
    const r = await source.run(kind, text, { dryRun: true });
    setBusy(false);
    if (!r.ok) { fail(r.error, r.params); return; }
    setCsv(text);
    setPhase({ kind: "preview", report: r.report });
  }
  async function apply(report: ImportReport) {
    if (csv === null || busy) return;
    setBusy(true);
    setError(null);
    const r = await source.run(kind, csv, { dryRun: false, skipInvalid: report.invalid > 0 });
    setBusy(false);
    if (!r.ok) { fail(r.error, r.params); return; }
    setPhase({ kind: "done", report: r.report });
  }

  const columns = IMPORT_FIELDS[kind].map((f) => `${f.column}${f.required ? "*" : ""}`).join(", ");
  const errorText = (e: ImportRowError) => t(`import.code.${e.code}`, e.params);
  const counters = (r: ImportReport) => (
    <ul className="wn-import-counters">
      <li>{t("import.summary.rows", { count: r.rows })}</li>
      <li>{t("import.summary.created", { count: r.created })}</li>
      <li>{t("import.summary.updated", { count: r.updated })}</li>
      <li>{t("import.summary.unchanged", { count: r.unchanged })}</li>
      <li>{t("import.summary.invalid", { count: r.invalid })}</li>
    </ul>
  );
  const details = (r: ImportReport): ReactNode => (
    <>
      {(["departments", "roles", "clients"] as const).map((k) => r.references[k].length > 0 && (
        <p key={k}>{t(`import.references.${k}`, { names: r.references[k].join(", ") })}</p>
      ))}
      {r.ignoredColumns.length > 0 && <p>{t("import.ignored", { names: r.ignoredColumns.join(", ") })}</p>}
      {r.errors.length > 0 && (
        <table className="wn-import-errors">
          <caption>{t("import.errors.caption")}</caption>
          <thead><tr><th scope="col">{t("import.errors.line")}</th><th scope="col">{t("import.errors.column")}</th><th scope="col">{t("import.errors.problem")}</th><th scope="col">{t("import.errors.value")}</th></tr></thead>
          <tbody>
            {r.errors.map((e, i) => (
              <tr key={i}><td>{e.line}</td><td>{e.column ?? ""}</td><td>{errorText(e)}</td><td>{e.value ?? ""}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {r.errorsTruncated && <p>{t("import.errors.truncated", { count: r.errors.length })}</p>}
    </>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (phase.kind === "form") {
    body = (
      <form id="wn-import-form" onSubmit={(e) => { e.preventDefault(); void analyze(); }}>
        <label>{t("import.kind.label")}{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{t(`import.kind.${k}`)}</option>)}
          </select>
        </label>
        <label>{t("import.file.label")}{" "}
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <p className="wn-import-help">{t("import.columns", { columns })}</p>
      </form>
    );
    footer = (
      <>
        <Button onClick={onClose}>{t("import.cancel")}</Button>
        <Button type="submit" form="wn-import-form" variant="primary" disabled={!file || busy}>{busy ? t("import.analyzing") : t("import.analyze")}</Button>
      </>
    );
  } else if (phase.kind === "preview") {
    const r = phase.report;
    const writes = r.created + r.updated;
    body = (
      <>
        <h3>{t("import.preview")}</h3>
        {counters(r)}
        {details(r)}
        {writes === 0 && <p>{t("import.nothing")}</p>}
        {writes > 0 && r.invalid > 0 && <p>{t("import.skipNote")}</p>}
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>{t("import.cancel")}</Button>
        <Button onClick={() => { setPhase({ kind: "form" }); setError(null); }}>{t("import.back")}</Button>
        {writes > 0 && (
          <Button variant="primary" autoFocus disabled={busy} onClick={() => void apply(r)}>
            {r.invalid > 0 ? t("import.confirmValid", { count: r.rows - r.invalid }) : t("import.confirm")}
          </Button>
        )}
      </>
    );
  } else {
    body = (
      <>
        <h3>{t("import.done")}</h3>
        {counters(phase.report)}
        {details(phase.report)}
      </>
    );
    footer = <Button variant="primary" autoFocus onClick={onClose}>{t("import.close")}</Button>;
  }

  return (
    <Modal title={t("import.title")} closeLabel={t("dialog.close")} onClose={onClose} busy={busy} className="wn-import-dialog" footer={footer}>
      {error && <p role="alert" className="wn-dialog-error">{error}</p>}
      {body}
    </Modal>
  );
}
