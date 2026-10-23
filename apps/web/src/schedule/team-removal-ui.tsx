// Menu contextuel d'un bloc (clic droit, touche Menu ou Maj+F10 sur un bloc focalisé) et retrait d'une personne d'un projet
// (BR-10). Le menu porte d'abord les commandes du bloc (RT-047 : Dupliquer, Scinder…, Supprimer, avec leur raccourci affiché
// et dans aria-keyshortcuts), puis « Retirer {personne} du projet {projet}… ». Bloc non modifiable (`writable`, BR-33) : pas
// de menu. Retrait :
//  1. récapitulatif (GET removal-summary) : allocations supprimées (nombre, première et dernière date), temps saisis supprimés
//     (nombre, heures), temps qui ne sont plus des brouillons (retrait impossible, pas de bouton) ;
//  2. « Retirer du projet » envoie la confirmation de ce qui a été vu (POST removal). État changé entre-temps : message et
//     nouveau récapitulatif, rien supprimé, il faut confirmer à nouveau. Succès : annonce (aria-live), focus rendu à la grille.
// Suppression définitive : elle n'entre pas dans l'historique d'annulation (BR-40 : Ctrl+Z ne rejoue pas les cascades BR-10).
// Congé (RT-051) : même menu, avec les commandes du congé (« Modifier… », « Supprimer ») et sans retrait.
// Les écouteurs sont posés sur le document : ils passent après ceux de la grille (block-editor bloque le menu du navigateur
// pendant un glisser au toucher, defaultPrevented est alors déjà posé et le menu ne s'ouvre pas).
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { EditError } from "../data/allocation-edits";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "../design";
import { confirmationOf, type RemovalSummary, type TeamRemovalEditor } from "../data/team-removal";
import type { MessageKey } from "../i18n";
import { TeamRemovalDialog } from "../team/team-removal-dialog";
import type { EditHost } from "./block-editor";

interface Target { personId: string; projectId: string; key: string; allocationId: string }

/** Commande du menu d'un bloc (RT-047) : libellé, raccourci affiché et ses touches (aria-keyshortcuts). */
export interface MenuCommand { id: string; label: string; shortcut: string; keys: string; onSelect(): void }
type Step =
  | { kind: "menu"; target: Target; x: number; y: number }
  | { kind: "offmenu"; timeoffId: string; commands: MenuCommand[]; x: number; y: number }
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
  /** Commandes du bloc, en tête du menu (RT-047) ; absent : le menu ne porte que le retrait. */
  commands?(target: { allocationId: string; key: string }): MenuCommand[];
  /** Le bloc accepte-t-il des écritures (BR-33) ? Faux : pas de menu. Absent : oui. */
  writable?(allocationId: string): boolean;
  /** Congé sous la cible (RT-051) ; absent : pas de menu sur un congé. */
  timeoffAt?: EditHost["timeoffAt"];
  /** Commandes d'un congé ; aucune : pas de menu. */
  timeoffCommands?(timeoffId: string): MenuCommand[];
}

export function useTeamRemoval({ i18n, editor, data, gridRef, blockAt, announce, onRemoved, commands, writable, timeoffAt, timeoffCommands }: TeamRemovalDeps): { element: ReactNode } {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [step, setStep] = useState<Step | null>(null);
  const deps = useRef({ editor, data, blockAt, onRemoved, commands, writable, timeoffAt, timeoffCommands });
  deps.current = { editor, data, blockAt, onRemoved, commands, writable, timeoffAt, timeoffCommands };
  const enabled = editor !== undefined || commands !== undefined || timeoffCommands !== undefined;

  useEffect(() => {
    if (!enabled) return;
    const targetOf = (e: Event): { target: Target; el: HTMLElement } | null => {
      const grid = gridRef.current;
      if (e.defaultPrevented || !grid || !(e.target instanceof Node) || !grid.contains(e.target)) return null;
      const hit = deps.current.blockAt(e.target);
      const a = hit && deps.current.data().allocations.find((x) => x.id === hit.block.allocationId);
      if (!hit || !a || deps.current.writable?.(a.id) === false) return null;
      const target = { personId: a.personId, projectId: a.projectId, key: hit.block.key, allocationId: a.id };
      return deps.current.editor || (deps.current.commands?.(target).length ?? 0) > 0 ? { target, el: hit.el } : null;
    };
    /** Congé sous la cible et ses commandes (au moins une), sinon null. */
    const offOf = (e: Event): { timeoffId: string; commands: MenuCommand[]; el: HTMLElement } | null => {
      const grid = gridRef.current;
      if (e.defaultPrevented || !grid || !(e.target instanceof Node) || !grid.contains(e.target) || deps.current.blockAt(e.target)) return null;
      const off = deps.current.timeoffAt?.(e.target);
      const list = off ? deps.current.timeoffCommands?.(off.timeoff.timeoffId) ?? [] : [];
      return off && list.length > 0 ? { timeoffId: off.timeoff.timeoffId, commands: list, el: off.el } : null;
    };
    const onMenu = (e: MouseEvent) => {
      const off = offOf(e);
      if (off) { e.preventDefault(); setStep({ kind: "offmenu", timeoffId: off.timeoffId, commands: off.commands, x: e.clientX, y: e.clientY }); return; }
      const hit = targetOf(e);
      if (!hit) return;
      e.preventDefault();
      setStep({ kind: "menu", target: hit.target, x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      const off = offOf(e);
      if (off && e.target === off.el) {
        e.preventDefault();
        const r = off.el.getBoundingClientRect();
        setStep({ kind: "offmenu", timeoffId: off.timeoffId, commands: off.commands, x: r.left, y: r.bottom });
        return;
      }
      const hit = targetOf(e);
      if (!hit || e.target !== hit.el) return;
      e.preventDefault();
      const r = hit.el.getBoundingClientRect();
      setStep({ kind: "menu", target: hit.target, x: r.left, y: r.bottom });
    };
    document.addEventListener("contextmenu", onMenu);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("contextmenu", onMenu); document.removeEventListener("keydown", onKey); };
  }, [enabled, gridRef]);

  /** Ferme et rend le focus au bloc (encore là) ou à la grille. */
  const close = (key?: string, timeoffId?: string) => {
    setStep(null);
    const grid = gridRef.current;
    const el = key ? grid?.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`) : timeoffId ? grid?.querySelector<HTMLElement>(`.wn-timeoff[data-timeoff="${timeoffId}"]`) : null;
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

  /** Éléments du menu : libellé, raccourci affiché (aria-keyshortcuts). */
  const items = (list: readonly MenuCommand[]) => list.map((c) => (
    <DropdownMenuItem key={c.id} aria-keyshortcuts={c.keys} className="flex items-center justify-between gap-4"
      onClick={() => { setStep(null); c.onSelect(); }}>
      <span data-label="">{c.label}</span>
      <kbd aria-hidden="true" className="font-[inherit] text-caption opacity-80">{c.shortcut}</kbd>
    </DropdownMenuItem>
  ));
  let element: ReactNode = null;
  if (step?.kind === "offmenu") {
    const { timeoffId } = step;
    element = (
      <DropdownMenu open onOpenChange={(open, details) => {
        if (open || details.reason === "item-press") return;
        if (details.reason === "outside-press") setStep(null);
        else close(undefined, timeoffId);
      }}>
        <DropdownMenuContent point={{ x: step.x, y: step.y }} align="start" aria-label={t("schedule.timeoff.menu.label")}
          onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); close(undefined, timeoffId); } }}>
          {items(step.commands)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else if (step?.kind === "menu") {
    const { target } = step;
    const list = deps.current.commands?.(target) ?? [];
    element = (
      <DropdownMenu open onOpenChange={(open, details) => {
        if (open || details.reason === "item-press") return;
        if (details.reason === "outside-press") setStep(null); // sans voler le focus
        else close(target.key);
      }}>
        <DropdownMenuContent point={{ x: step.x, y: step.y }} align="start" aria-label={t("schedule.removal.menu.label")}
          onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); close(target.key); } }}>
          {items(list)}
          {editor && <DropdownMenuItem onClick={() => void openDialog(target)}>{t("schedule.removal.menu.item", names(target))}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else if (step?.kind === "dialog") {
    const { target, summary } = step;
    element = (
      <TeamRemovalDialog i18n={i18n} {...names(target)} summary={summary} error={step.error} stale={step.stale} busy={step.busy}
        onConfirm={() => void confirm()} onCancel={() => close(target.key)} />
    );
  }
  return { element };
}
