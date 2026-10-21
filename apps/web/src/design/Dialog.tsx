// Coque commune de Modal et de Drawer, sur le Dialog shadcn/ui (Base UI, ADR-010) : portail, voile, rôle dialog modal, titre
// relié, piège du focus, focus initial, Échap, bouton Fermer (×) toujours visible, focus rendu au déclencheur, défilement de
// la page bloqué.
// Fermeture (docs/design/design.md, RT-023) :
//  * Drawer : un clic sur le voile ferme ; Modal : il ne ferme pas (formulaire ou confirmation en cours) ;
//  * `unsaved.dirty` : ×, Échap et clic extérieur demandent d'abord « Abandonner les modifications ? » (Q7).
// Modale ancrée (`anchor`) : même voile et mêmes règles, mais le panneau se place contre l'ancre (bloc de la grille), comme un
// Popover (placePopover : dessous, retourné au-dessus, borné à la fenêtre), pour garder le contexte visible.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CLOSE_ATTR, tabbables, useFocusTrap, useReturnFocus, useScrollLock } from "./overlay";
import { placePopover, type PopoverAnchor, type Rect } from "./Popover";
import { UiButton } from "./ui/button";
import {
  AlertDialogBackdrop, AlertDialogPopup, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle, DialogOverlay, DialogPopup, DialogPortal, DialogRoot,
  DialogTitle, POPUP_CLASS,
} from "./ui/dialog";

export interface UnsavedChanges {
  /** Le formulaire a des modifications non enregistrées. */
  dirty: boolean;
  /** Libellés de la confirmation (catalogue i18n). */
  title: string;
  keep: string;
  discard: string;
}

export interface DialogProps {
  /** Titre visible (h2), qui nomme la fenêtre. */
  title: string;
  /** Fermeture par le bouton ×. Échap fait de même, sauf si `onEscape` est donné. */
  onClose(): void;
  /** Échap seul (ex. revenir d'une étape plutôt que tout fermer). */
  onEscape?(): void;
  /** Libellé accessible du bouton × (catalogue i18n). */
  closeLabel: string;
  children: ReactNode;
  /** Pied de fenêtre : actions (composants Button). */
  footer?: ReactNode;
  /** Identifiant d'un élément du contenu qui décrit la fenêtre. */
  describedBy?: string;
  busy?: boolean;
  /** Classes du panneau (ex. wn-timeoff-dialog) pour le contenu propre à la fenêtre. */
  className?: string;
  /** Modale seulement : panneau placé contre cet élément ou ce rectangle (repère de la fenêtre) au lieu d'être centré. */
  anchor?: PopoverAnchor;
  /** Confirmation avant de fermer un formulaire modifié (RT-023, Q7). */
  unsaved?: UnsavedChanges;
}

const rectOf = (a: PopoverAnchor): Rect => {
  if (!(a instanceof HTMLElement)) return a;
  const r = a.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/** Focus initial : l'élément déjà focalisé dans la fenêtre (autoFocus), sinon [data-autofocus], le premier champ ou la première action, sinon ×, sinon la fenêtre. */
function initialTarget(el: HTMLElement | null): HTMLElement | boolean {
  if (!el) return true;
  if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) return document.activeElement;
  return el.querySelector<HTMLElement>("[data-autofocus]") ?? tabbables(el).find((x) => !x.hasAttribute(CLOSE_ATTR)) ?? el.querySelector<HTMLElement>(`[${CLOSE_ATTR}]`) ?? el;
}

type CloseKind = "close" | "escape" | "outside";

export function Dialog({ variant, title, onClose, onEscape, closeLabel, children, footer, describedBy, busy, className, anchor, unsaved }: DialogProps & { variant: "modal" | "drawer" }) {
  const root = useRef<HTMLDivElement | null>(null);
  // Le portail de Base UI monte le panneau au rendu suivant : l'élément arrive par une ref-callback, les effets en dépendent.
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const attach = (el: HTMLDivElement | null) => { root.current = el; setPanel(el); };
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [confirming, setConfirming] = useState<CloseKind | null>(null);
  useLayoutEffect(() => {
    const el = panel;
    if (!anchor || !el) return;
    const place = () => setPos(placePopover(rectOf(anchor), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, panel]);
  // Focus initial synchrone (Base UI le place après une image) : mêmes règles que les fenêtres d'avant la migration.
  useLayoutEffect(() => {
    if (!panel) return;
    const target = initialTarget(panel);
    if (target instanceof HTMLElement && document.activeElement !== target) target.focus({ preventScroll: true });
  }, [panel]);
  useReturnFocus();
  useScrollLock();
  const trap = useFocusTrap(root);

  const finish = (kind: CloseKind) => (kind === "escape" && onEscape ? onEscape() : onClose());
  const request = (kind: CloseKind) => {
    if (unsaved?.dirty) setConfirming(kind);
    else finish(kind);
  };
  const box = anchor ? POPUP_CLASS.anchored : variant === "drawer" ? POPUP_CLASS.sheet : POPUP_CLASS.modal;

  return (
    <DialogRoot
      open
      // Modal : un clic hors du panneau ne ferme pas ; Drawer : il ferme (RT-023), sauf pendant la confirmation.
      disablePointerDismissal={variant === "modal" || confirming !== null}
      onOpenChange={(open, details) => {
        if (open || confirming) return;
        const reason = details.reason;
        if (reason === "escape-key") request("escape");
        else if (reason === "outside-press") request("outside");
        else request("close");
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPopup
          ref={attach} aria-modal="true" aria-describedby={describedBy} aria-busy={busy}
          initialFocus={false} finalFocus={false}
          // Panneau ancré en position fixed : placePopover rend des coordonnées de la fenêtre.
          style={anchor ? { position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, maxHeight: "calc(100vh - 16px)" } : undefined}
          className={`${box}${className ? ` ${className}` : ""}`}
          onKeyDown={(e) => trap.onKeyDown(e)}
        >
          <div className="flex items-start justify-between gap-3 border-b border-solid border-border px-4 py-3">
            <DialogTitle render={<h2 />} className="m-0 text-heading font-semibold">{title}</DialogTitle>
            <UiButton
              variant="ghost" size="icon" {...{ [CLOSE_ATTR]: "" }} aria-label={closeLabel} title={closeLabel} onClick={() => request("close")}
              className="-mr-1 text-muted-foreground"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
            </UiButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3 [&_p]:mt-0 [&_p]:mb-2">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-solid border-border px-4 py-3">{footer}</div>}
          {confirming && unsaved && (
            <AlertDialogRoot open onOpenChange={(open) => { if (!open) setConfirming(null); }}>
              <AlertDialogPortal>
                <AlertDialogBackdrop className="fixed inset-0 z-(--z-modal) bg-scrim" />
                <AlertDialogPopup className={`${POPUP_CLASS.modal} z-(--z-modal) max-w-sm border border-solid border-input bg-popover p-4 text-body text-popover-foreground`}>
                  <AlertDialogTitle render={<h2 />} className="m-0 mb-4 text-heading font-semibold">{unsaved.title}</AlertDialogTitle>
                  <div className="flex flex-wrap justify-end gap-2">
                    <UiButton variant="outline" autoFocus onClick={() => setConfirming(null)}>{unsaved.keep}</UiButton>
                    <UiButton variant="destructive" onClick={() => { const kind = confirming; setConfirming(null); finish(kind); }}>{unsaved.discard}</UiButton>
                  </div>
                </AlertDialogPopup>
              </AlertDialogPortal>
            </AlertDialogRoot>
          )}
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}
