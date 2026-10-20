// Retirer une personne d'un projet depuis le Schedule (BR-10). Point d'entrée : menu contextuel d'un bloc (clic droit, touche
// Menu ou Maj+F10 sur un bloc focalisé), un seul élément « Retirer {personne} du projet {projet}… ». Puis :
//  1. récapitulatif (GET removal-summary) : allocations supprimées (nombre, première et dernière date), temps saisis supprimés
//     (nombre, heures), temps qui ne sont plus des brouillons (retrait impossible, pas de bouton) ;
//  2. « Retirer du projet » envoie la confirmation de ce qui a été vu (POST removal). État changé entre-temps : message et
//     nouveau récapitulatif, rien supprimé, il faut confirmer à nouveau. Succès : annonce (aria-live), focus rendu à la grille.
// Suppression définitive : elle n'entre pas dans l'historique d'annulation (BR-40 : Ctrl+Z ne rejoue pas les cascades BR-10).
// Les écouteurs sont posés sur le document : ils passent après ceux de la grille (block-editor bloque le menu du navigateur
// pendant un glisser au toucher, defaultPrevented est alors déjà posé et le menu ne s'ouvre pas).
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { EditError } from "../data/allocation-edits";
import { confirmationOf, type RemovalSummary, type TeamRemovalEditor } from "../data/team-removal";
import type { MessageKey } from "../i18n";
import type { EditHost } from "./block-editor";

interface Target { personId: string; projectId: string; key: string }
type Step =
  | { kind: "menu"; target: Target; x: number; y: number }
  | { kind: "dialog"; target: Target; summary: RemovalSummary | null; error: string | null; stale: boolean; busy: boolean };

const SHOWN = new Set<EditError>(["FORBIDDEN", "NETWORK", "NOT_FOUND"]);
const errorKey = (e: EditError): MessageKey => (SHOWN.has(e) ? `schedule.removal.error.${e as "NETWORK"}` : "schedule.removal.error.other");

export interface TeamRemovalDeps {
  i18n: I18n;
  editor: TeamRemovalEditor | undefined;
  data(): ScheduleResponse;
  gridRef: RefObject<HTMLElement | null>;
  blockAt: EditHost["blockAt"];
  announce(text: string): void;
  /** Allocations retirées par un retrait réussi (BR-10, non annulable) : l'historique en retire les actions (BR-40). */
  onRemoved?(allocationIds: string[]): void;
}

export function useTeamRemoval({ i18n, editor, data, gridRef, blockAt, announce, onRemoved }: TeamRemovalDeps): { element: ReactNode } {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [step, setStep] = useState<Step | null>(null);
  const deps = useRef({ editor, data, blockAt, onRemoved });
  deps.current = { editor, data, blockAt, onRemoved };
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [i18n.locale]);
  const day = (iso: string | null) => (iso ? fmt.format(new Date(`${iso}T00:00:00Z`)) : "");

  useEffect(() => {
    if (!editor) return;
    const targetOf = (e: Event): { target: Target; el: HTMLElement } | null => {
      const grid = gridRef.current;
      if (e.defaultPrevented || !grid || !(e.target instanceof Node) || !grid.contains(e.target)) return null;
      const hit = deps.current.blockAt(e.target);
      const a = hit && deps.current.data().allocations.find((x) => x.id === hit.block.allocationId);
      return hit && a ? { target: { personId: a.personId, projectId: a.projectId, key: hit.block.key }, el: hit.el } : null;
    };
    const onMenu = (e: MouseEvent) => {
      const hit = targetOf(e);
      if (!hit) return;
      e.preventDefault();
      setStep({ kind: "menu", target: hit.target, x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      const hit = targetOf(e);
      if (!hit || e.target !== hit.el) return;
      e.preventDefault();
      const r = hit.el.getBoundingClientRect();
      setStep({ kind: "menu", target: hit.target, x: r.left, y: r.bottom });
    };
    document.addEventListener("contextmenu", onMenu);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("contextmenu", onMenu); document.removeEventListener("keydown", onKey); };
  }, [editor, gridRef]);

  // Menu ouvert : un appui ailleurs le ferme (sans voler le focus).
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpen = step?.kind === "menu";
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: PointerEvent) => { if (!(e.target instanceof Node && menuRef.current?.contains(e.target))) setStep(null); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [menuOpen]);

  /** Ferme et rend le focus au bloc (encore là) ou à la grille. */
  const close = (key?: string) => {
    setStep(null);
    const grid = gridRef.current;
    const el = key ? grid?.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`) : null;
    (el ?? grid)?.focus({ preventScroll: true });
  };

  async function openDialog(target: Target) {
    const ed = deps.current.editor;
    if (!ed) return;
    setStep({ kind: "dialog", target, summary: null, error: null, stale: false, busy: true });
    const r = await ed.teamRemovalSummary(target.projectId, target.personId);
    setStep(r.ok
      ? { kind: "dialog", target, summary: r.summary, error: null, stale: false, busy: false }
      : { kind: "dialog", target, summary: null, error: t(errorKey(r.error)), stale: false, busy: false });
  }

  async function confirm() {
    const ed = deps.current.editor;
    if (!ed || step?.kind !== "dialog" || !step.summary || step.busy) return;
    const { target, summary } = step;
    setStep({ ...step, busy: true });
    const gone = deps.current.data().allocations.filter((a) => a.projectId === target.projectId && a.personId === target.personId).map((a) => a.id);
    const r = await ed.removeFromTeam(target.projectId, target.personId, confirmationOf(summary));
    if (r.ok) {
      deps.current.onRemoved?.(gone);
      close();
      announce(t("schedule.removal.done", { ...names(target), allocations: r.removedAllocations, logs: r.removedLogs }));
      return;
    }
    const refused = r.error === "TEAM_REMOVAL_STALE_CONFIRMATION" || r.error === "TEAM_REMOVAL_LOCKED_LOGS" || r.error === "TEAM_REMOVAL_CONFIRMATION_REQUIRED";
    if (refused && r.summary) { setStep({ kind: "dialog", target, summary: r.summary, error: null, stale: r.error !== "TEAM_REMOVAL_LOCKED_LOGS", busy: false }); return; }
    if (refused) { await openDialog(target); return; }
    setStep({ kind: "dialog", target, summary, error: t(errorKey(r.error)), stale: false, busy: false });
  }

  const names = (target: Target) => {
    const d = deps.current.data();
    return { person: d.people.find((p) => p.id === target.personId)?.name ?? "", project: d.projects.find((p) => p.id === target.projectId)?.name ?? "" };
  };

  let element: ReactNode = null;
  if (step?.kind === "menu") {
    const { target } = step;
    element = (
      <div ref={menuRef} role="menu" aria-label={t("schedule.removal.menu.label")} className="wn-menu" style={{ position: "fixed", left: step.x, top: step.y }}
        onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(target.key); } }}>
        <button type="button" role="menuitem" autoFocus onClick={() => void openDialog(target)}>
          {t("schedule.removal.menu.item", names(target))}
        </button>
      </div>
    );
  } else if (step?.kind === "dialog") {
    const { target, summary } = step;
    element = (
      <div role="dialog" aria-modal="true" aria-labelledby="wn-removal-title" className="wn-dialog wn-removal-dialog" aria-busy={step.busy}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(target.key); } }}>
        <h2 id="wn-removal-title">{t("schedule.removal.title", names(target))}</h2>
        {step.stale && <p role="alert">{t("schedule.removal.stale")}</p>}
        {step.error && <p role="alert" className="wn-dialog-error">{step.error}</p>}
        {!summary && !step.error && <p>{t("schedule.removal.loading")}</p>}
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
        <div className="wn-dialog-actions">
          {summary?.canRemove && (
            <button type="button" autoFocus disabled={step.busy} onClick={() => void confirm()}>{t("schedule.removal.confirm")}</button>
          )}
          <button type="button" onClick={() => close(target.key)}>{t("schedule.removal.cancel")}</button>
        </div>
      </div>
    );
  }
  return { element };
}
