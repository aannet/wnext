// Popover : fenêtre non modale ancrée à un élément ou à un rectangle (bloc de la grille), repositionnée pour rester dans la
// fenêtre du navigateur (retournement haut / bas, gauche / droite). Échap et clic extérieur ferment ; le focus est rendu.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeOutside, useInitialFocus, useReturnFocus } from "./overlay";

export interface Rect { left: number; top: number; width: number; height: number }
export type PopoverAnchor = HTMLElement | Rect;

const GAP = 4;
const MARGIN = 8;

/**
 * Position (px, repère de la fenêtre) d'un popover de taille `size` autour de `anchor` : sous l'ancre, aligné à sa gauche ;
 * retourné au-dessus s'il déborde en bas et que le haut a plus de place ; décalé à gauche s'il déborde à droite ; toujours
 * borné par une marge à l'intérieur de la fenêtre.
 */
export function placePopover(anchor: Rect, size: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number; side: "bottom" | "top" } {
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - size.height;
  const fitsBelow = below + size.height <= view.height - MARGIN;
  const side = fitsBelow || above < MARGIN ? "bottom" : "top";
  const clamp = (v: number, size_: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN - size_));
  let left = anchor.left;
  if (left + size.width > view.width - MARGIN) left = anchor.left + anchor.width - size.width; // aligné à droite de l'ancre
  return { left: clamp(left, size.width, view.width), top: clamp(side === "bottom" ? below : above, size.height, view.height), side };
}

const rectOf = (a: PopoverAnchor): Rect => {
  if (!(a instanceof HTMLElement)) return a;
  const r = a.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

export interface PopoverProps {
  anchor: PopoverAnchor;
  onClose(): void;
  /** Échap seul (ex. revenir d'une étape) ; absent : onClose. */
  onEscape?(): void;
  children: ReactNode;
  /** Nom accessible : un identifiant d'élément du contenu, ou un libellé. */
  labelledBy?: string;
  label?: string;
  describedBy?: string;
  id?: string;
  busy?: boolean;
  className?: string;
}

export function Popover({ anchor, onClose, onEscape, children, labelledBy, label, describedBy, id, busy, className }: PopoverProps) {
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: "bottom" | "top" } | null>(null);
  useReturnFocus();
  useInitialFocus(root);
  useEscapeOutside(root, onEscape ?? onClose);

  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    const place = () => {
      const el = root.current;
      if (!el) return;
      setPos(placePopover(rectOf(anchorRef.current), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);

  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || root.current?.contains(t)) return;
      const a = anchorRef.current;
      if (a instanceof HTMLElement && a.contains(t)) return; // l'ancre (cloche) gère elle-même son bouton
      close.current();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, []);

  return createPortal(
    <div
      ref={root} id={id} role="dialog" aria-modal="false" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy} tabIndex={-1}
      data-side={pos?.side}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
      className={`wn-anim-pop fixed z-(--z-popover) box-border max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-solid border-border-strong bg-surface p-3 text-body text-text shadow-popover${className ? ` ${className}` : ""}`}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); (onEscape ?? onClose)(); } }}
    >
      {children}
    </div>,
    document.body,
  );
}
