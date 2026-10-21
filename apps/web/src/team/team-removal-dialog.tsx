// Dialogue de retrait d'une personne d'un projet (BR-10), partagé par le menu contextuel du planning (schedule/team-removal-ui)
// et par la fiche projet (projects/project-team) : récapitulatif de ce qui sera supprimé (allocations, temps saisis), confirmation
// explicite de ce qui a été vu, refus si des temps saisis sont verrouillés, récapitulatif à jour si la situation a changé.
// Le composant ne fait aucun appel : l'appelant porte l'état (récapitulatif, erreur, busy) et les actions.
import type { I18n } from "@lingui/core";
import { useMemo } from "react";
import type { RemovalSummary } from "../data/team-removal";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";

export interface TeamRemovalDialogProps {
  i18n: I18n;
  person: string;
  project: string;
  /** Null tant que le récapitulatif n'est pas arrivé. */
  summary: RemovalSummary | null;
  /** Erreur déjà traduite. */
  error: string | null;
  /** La situation a changé depuis l'ouverture : le récapitulatif affiché est le nouveau, il faut confirmer à nouveau. */
  stale: boolean;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function TeamRemovalDialog({ i18n, person, project, summary, error, stale, busy, onConfirm, onCancel }: TeamRemovalDialogProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [i18n.locale]);
  const day = (iso: string | null) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : "");
  return (
    <Modal title={t("schedule.removal.title", { person, project })} closeLabel={t("dialog.close")} onClose={onCancel} busy={busy} className="wn-removal-dialog"
      footer={
        <>
          <Button onClick={onCancel}>{t("schedule.removal.cancel")}</Button>
          {summary?.canRemove && <Button variant="danger" autoFocus disabled={busy} onClick={onConfirm}>{t("schedule.removal.confirm")}</Button>}
        </>
      }>
      {stale && <p role="alert">{t("schedule.removal.stale")}</p>}
      {error && <p role="alert" className="wn-dialog-error">{error}</p>}
      {!summary && !error && <p>{t("schedule.removal.loading")}</p>}
      {summary && (
        <>
          <ul>
            <li>{t("schedule.removal.allocations", { count: summary.allocationCount, first: day(summary.firstAllocation), last: day(summary.lastAllocation) })}</li>
            <li>{t("schedule.removal.logs", { count: summary.logCount, hours: summary.logHours })}</li>
          </ul>
          {summary.canRemove
            ? <p>{t("schedule.removal.irreversible")}</p>
            : <p role="alert" className="wn-dialog-error">{t("schedule.removal.locked", { count: summary.lockedLogCount })}</p>}
        </>
      )}
    </Modal>
  );
}
