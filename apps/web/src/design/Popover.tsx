// Popover : fenêtre non modale ancrée à un élément ou à un rectangle (bloc de la grille), sur le Popover de Base UI (ADR-010,
// L-J) : portail, placement sous l'ancre aligné à son début, retourné et décalé par Base UI pour rester dans la fenêtre.
// Échap et clic extérieur ferment ; un clic sur l'ancre ne ferme pas. La cloche utilise PopoverRoot, PopoverTrigger et PopoverPanel
// (racine contrôlée par l'appelant, déclencheur de Base UI). Focus initial dans le popover et focus rendu au déclencheur, comme les autres fenêtres (overlay.ts) ; la page défile toujours.
import { Popover as Base } from "@base-ui/react/popover";
import { useState, type ReactNode } from "react";
import { useInitialFocus, useReturnFocus } from "./overlay";

export interface Rect { left: number; top: number; width: number; height: number }
export type PopoverAnchor = HTMLElement | Rect;

export interface PanelProps {
  /** Ancre du panneau ; absente : le PopoverTrigger du PopoverRoot qui le contient. */
  anchor?: PopoverAnchor;
  children: ReactNode;
  /** Nom accessible : un identifiant d'élément du contenu, ou un libellé. */
  labelledBy?: string;
  label?: string;
  describedBy?: string;
  id?: string;
  busy?: boolean;
  className?: string;
}

export interface PopoverProps extends PanelProps {
  anchor: PopoverAnchor;
  onClose(): void;
  /** Échap seul (ex. revenir d'une étape) ; absent : onClose. */
  onEscape?(): void;
}

/** Racine et déclencheur de Base UI, pour un popover ouvert par un bouton (la cloche) : la racine est contrôlée par l'appelant. */
export const PopoverRoot = Base.Root;
export const PopoverTrigger = Base.Trigger;

/** Ancre virtuelle d'un rectangle (repère de la fenêtre) : ce que Base UI attend d'un élément de référence. */
const virtual = (r: Rect) => ({
  getBoundingClientRect: () => ({ x: r.left, y: r.top, left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }),
});

/** Panneau seul (portail, positionnement, focus initial et rendu), à monter dans une racine ouverte. */
export function PopoverPanel({ anchor, children, labelledBy, label, describedBy, id, busy, className }: PanelProps) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  useReturnFocus();
  useInitialFocus(panel);
  const element = anchor instanceof HTMLElement ? anchor : null;
  const anchorProp = anchor ? { anchor: element ?? virtual(anchor as Rect) } : {};
  return (
    <Base.Portal>
      <Base.Positioner {...anchorProp} side="bottom" align="start" sideOffset={4} collisionPadding={8} positionMethod="fixed"
        className="z-(--z-popover)">
        <Base.Popup
          ref={setPanel} id={id} aria-modal="false" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy} tabIndex={-1}
          initialFocus={false} finalFocus={false}
          className={`wn-anim-pop box-border max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-solid border-border-strong bg-surface p-3 text-body text-text shadow-popover outline-none${className ? ` ${className}` : ""}`}
        >
          {children}
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

export function Popover({ anchor, onClose, onEscape, ...panel }: PopoverProps) {
  const element = anchor instanceof HTMLElement ? anchor : null;
  return (
    <Base.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (details.reason === "escape-key") { (onEscape ?? onClose)(); return; }
        const target = details.event?.target;
        if (details.reason === "outside-press" && element && target instanceof Node && element.contains(target)) return;
        onClose();
      }}
    >
      <PopoverPanel anchor={anchor} {...panel} />
    </Base.Root>
  );
}
