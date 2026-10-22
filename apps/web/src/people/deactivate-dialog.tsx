// Désactivation d'une personne avec récapitulatif (BR-31) : ses allocations futures sont comptées (nombre, projets, première et
// dernière date), l'utilisateur choisit de les réaffecter à une autre personne active ou de les supprimer, puis confirme ce
// qu'il a vu. Si la situation a changé entre-temps (409 PERSON_DEACTIVATION_STALE_CONFIRMATION), le récapitulatif à jour est
// affiché et il faut confirmer à nouveau. Rien n'est écrit avant la confirmation ; sans allocation future, un simple clic suffit.
import type { I18n } from "@lingui/core";
import type { PersonDeactivationSummary } from "@wnext/contracts";
import { useEffect, useMemo, useState } from "react";
import type { DirError, DirResult, PeopleSource, Person } from "../data/people-source";
import { Button, Modal, RadioGroup, RadioItem } from "../design";
import type { MessageKey } from "../i18n";
import { errorOf } from "./people-model";

type Disposition = "reassign" | "delete";

/** Récapitulatif porté par les params d'un refus de confirmation ; undefined s'il est incomplet. */
export function summaryFromParams(params: DirError["params"]): PersonDeactivationSummary | undefined {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const count = n(params.allocationCount), projects = n(params.projectCount);
  if (count === undefined || projects === undefined || typeof params.asOf !== "string") return undefined;
  const date = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    alreadyInactive: params.alreadyInactive === true, asOf: params.asOf, allocationCount: count, projectCount: projects,
    firstAllocation: date(params.firstAllocation), lastAllocation: date(params.lastAllocation),
  };
}

export interface DeactivateDialogProps {
  i18n: I18n;
  source: PeopleSource;
  person: Person;
  /** Personnes actives parmi lesquelles choisir un remplaçant (la personne elle-même exclue ici). */
  candidates: readonly Person[];
  onClose(): void;
  onDone(person: Person): void;
}

export function DeactivateDialog({ i18n, source, person, candidates, onClose, onDone }: DeactivateDialogProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [summary, setSummary] = useState<PersonDeactivationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disposition, setDisposition] = useState<Disposition | "">("");
  const [replacementId, setReplacementId] = useState("");
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), [i18n.locale]);
  const day = (iso: string | null) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : "");
  const others = candidates.filter((c) => c.id !== person.id && c.active);

  useEffect(() => {
    let live = true;
    void source.deactivationSummary(person.id).then((r: DirResult<PersonDeactivationSummary>) => {
      if (!live) return;
      if (r.ok) setSummary(r.value); else setError(t(errorOf(r.error).key));
    });
    return () => { live = false; };
  }, [person.id]);

  const needsChoice = (summary?.allocationCount ?? 0) > 0;
  const ready = summary !== null && (!needsChoice || disposition === "delete" || (disposition === "reassign" && replacementId !== ""));

  async function confirm() {
    if (!summary || !ready || busy) return;
    setBusy(true); setError(null); setStale(false);
    const r = await source.deactivate(person, needsChoice
      ? { disposition: disposition as Disposition, ...(disposition === "reassign" ? { replacementId } : {}), confirmation: { allocationCount: summary.allocationCount }, asOf: summary.asOf }
      : { asOf: summary.asOf });
    setBusy(false);
    if (r.ok) { onDone(r.value); return; }
    const fresh = r.error.code === "PERSON_DEACTIVATION_STALE_CONFIRMATION" || r.error.code === "PERSON_DEACTIVATION_CONFIRMATION_REQUIRED" ? summaryFromParams(r.error.params) : undefined;
    if (fresh) { setSummary(fresh); setStale(true); return; }
    setError(t(errorOf(r.error).key));
  }

  return (
    <Modal title={t("people.deactivate.title", { person: person.name })} closeLabel={t("dialog.close")} onClose={onClose} busy={busy} className="wn-removal-dialog"
      footer={(
        <>
          <Button onClick={onClose}>{t("people.deactivate.cancel")}</Button>
          {summary && <Button variant="danger" disabled={busy || !ready} onClick={() => void confirm()}>{t("people.deactivate.confirm")}</Button>}
        </>
      )}>
      {stale && <p role="alert">{t("people.deactivate.stale")}</p>}
      {error && <p role="alert" className="wn-dialog-error">{error}</p>}
      {!summary && !error && <p>{t("people.deactivate.loading")}</p>}
      {summary && (
        <>
          <p>{needsChoice
            ? t("people.deactivate.summary", { count: summary.allocationCount, projects: summary.projectCount, first: day(summary.firstAllocation), last: day(summary.lastAllocation) })
            : t("people.deactivate.none")}</p>
          {needsChoice && (
            <fieldset className="wn-choice">
              <legend id="wn-disposition-legend">{t("people.deactivate.disposition")}</legend>
              <RadioGroup aria-labelledby="wn-disposition-legend" value={disposition || null} onValueChange={(v) => setDisposition(v as typeof disposition)} className="flex flex-col gap-(--space-2)">
                <label className="inline-flex items-center gap-2"><RadioItem value="reassign" /> {t("people.deactivate.reassign")}</label>
                {disposition === "reassign" && (
                  <div className="wn-field">
                    <label htmlFor="wn-replacement">{t("people.deactivate.replacement")}</label>
                    <select id="wn-replacement" value={replacementId} onChange={(e) => setReplacementId(e.target.value)}>
                      <option value="">{t("people.deactivate.replacement.placeholder")}</option>
                      {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                )}
                <label className="inline-flex items-center gap-2"><RadioItem value="delete" /> {t("people.deactivate.delete")}</label>
              </RadioGroup>
            </fieldset>
          )}
          <p className="wn-muted">{t("people.deactivate.reversible")}</p>
        </>
      )}
    </Modal>
  );
}
