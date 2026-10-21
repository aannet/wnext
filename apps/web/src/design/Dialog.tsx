// Coque commune de Modal et de Drawer : portail dans document.body, voile, rôle dialog modal, titre relié, piège du focus,
// focus initial, Échap, bouton Fermer (×) toujours visible, focus rendu au déclencheur, défilement de la page bloqué.
// Modale ancrée (`anchor`) : même voile et mêmes règles, mais le panneau se place contre l'ancre (bloc de la grille), comme un
// Popover (placePopover : dessous, retourné au-dessus, borné à la fenêtre), pour garder le contexte visible.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CLOSE_ATTR, useEscapeOutside, useFocusTrap, useInitialFocus, useReturnFocus, useScrollLock } from "./overlay";
import { placePopover, type PopoverAnchor, type Rect } from "./Popover";

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
}

const PANEL = {
  modal: { scrim: "items-center justify-center p-4", panel: "max-h-full w-full max-w-xl rounded-lg shadow-popover wn-anim-pop" },
  drawer: { scrim: "justify-end", panel: "h-full w-[420px] max-w-full shadow-drawer wn-anim-slide" },
} as const;

const rectOf = (a: PopoverAnchor): Rect => {
  if (!(a instanceof HTMLElement)) return a;
  const r = a.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

export function Dialog({ variant, title, onClose, onEscape, closeLabel, children, footer, describedBy, busy, className, anchor }: DialogProps & { variant: "modal" | "drawer" }) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!anchor || !el) return;
    const place = () => setPos(placePopover(rectOf(anchor), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useReturnFocus();
  useScrollLock();
  useInitialFocus(root);
  const trap = useFocusTrap(root);
  const escape = () => (onEscape ?? onClose)();
  useEscapeOutside(root, escape);
  const v = PANEL[variant];
  return createPortal(
    <div
      className={`wn-anim-fade fixed inset-0 z-(--z-modal) flex bg-scrim ${v.scrim}`}
      // Un clic sur le voile ne ferme pas (formulaire en cours) et ne vole pas le focus à la fenêtre.
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
    >
      <div
        ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} aria-busy={busy} tabIndex={-1}
        // Le voile couvre la fenêtre depuis (0, 0) : coordonnées de la fenêtre = coordonnées dans le voile.
        style={anchor ? { position: "absolute", left: pos?.left ?? 0, top: pos?.top ?? 0, maxHeight: "calc(100vh - 16px)" } : undefined}
        className={`flex flex-col overflow-hidden border border-solid border-border-strong bg-surface text-body text-text ${v.panel}${className ? ` ${className}` : ""}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); escape(); return; }
          trap.onKeyDown(e);
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-solid border-border px-4 py-3">
          <h2 id={titleId} className="m-0 text-heading font-semibold">{title}</h2>
          <button
            type="button" {...{ [CLOSE_ATTR]: "" }} aria-label={closeLabel} title={closeLabel} onClick={onClose}
            className="-mr-1 inline-flex size-(--control-default) shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-text-muted hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 [&_p]:mt-0 [&_p]:mb-2">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-solid border-border px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
