// Briques communes des fenêtres superposées (Modal, Drawer, Popover) : focus rendu à l'élément déclencheur, piège du focus,
// focus initial, Échap hors de la fenêtre, blocage du défilement de la page.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';
export const CLOSE_ATTR = "data-wn-close";

/** Éléments atteignables au Tab dans `root`, dans l'ordre du document. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if (el.hasAttribute("disabled") || el.hidden || el.closest("[hidden],[inert]")) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const tab = el.getAttribute("tabindex");
    return tab === null || Number(tab) >= 0;
  });
}

/**
 * Mémorise l'élément focalisé au premier rendu (le déclencheur : l'autoFocus de la fenêtre n'a pas encore eu lieu) et le
 * refocalise au démontage, sauf si l'appelant a déjà placé le focus ailleurs (grille, bloc) ou si le déclencheur a disparu.
 */
export function useReturnFocus(): void {
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  useEffect(() => () => {
    const el = opener.current;
    const now = document.activeElement;
    if ((now === null || now === document.body) && el?.isConnected) el.focus({ preventScroll: true });
  }, []);
}

/**
 * Focus initial : l'élément déjà focalisé dans la fenêtre (autoFocus), sinon [data-autofocus], le premier champ ou la première
 * action, sinon la fenêtre. Reçoit l'élément et non une ref : un portail de Base UI le monte au rendu suivant.
 */
export function useInitialFocus(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!el || el.contains(document.activeElement)) return;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? tabbables(el).find((x) => !x.hasAttribute(CLOSE_ATTR)) ?? el.querySelector<HTMLElement>(`[${CLOSE_ATTR}]`) ?? el;
    first.focus({ preventScroll: true });
  }, [el]);
}

/** Piège du focus : Tab / Maj+Tab bouclent dans la fenêtre (le voile couvre la page, le pointeur n'en sort pas). */
export function useFocusTrap(root: RefObject<HTMLElement | null>): { onKeyDown(e: { key: string; shiftKey: boolean; preventDefault(): void }): void } {
  return {
    onKeyDown(e) {
      const el = root.current;
      if (e.key !== "Tab" || !el) return;
      const list = tabbables(el);
      if (list.length === 0) { e.preventDefault(); el.focus({ preventScroll: true }); return; }
      const first = list[0]!, last = list[list.length - 1]!, active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
    },
  };
}

let locks = 0;
let saved = "";
/** Bloque le défilement de la page tant qu'une fenêtre modale est ouverte (compteur : plusieurs fenêtres empilées). */
export function useScrollLock(): void {
  useEffect(() => {
    if (locks++ === 0) { saved = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    return () => { if (--locks === 0) document.body.style.overflow = saved; };
  }, []);
}
