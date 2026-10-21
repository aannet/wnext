// Dialog, Sheet et AlertDialog shadcn/ui (style base-nova, socle Base UI, ADR-010), adaptés aux tokens WNEXT : voile
// --color-scrim, rayons et ombres des tokens, z-index --z-modal, animations de overlay.css (neutralisées sous
// prefers-reduced-motion par les durées des tokens). Les règles de fermeture et de focus sont dans design/Dialog.tsx.
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import type { ComponentProps } from "react";

export const DialogRoot = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogTitle = DialogPrimitive.Title;
export const AlertDialogRoot = AlertDialogPrimitive.Root;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogBackdrop = AlertDialogPrimitive.Backdrop;
export const AlertDialogPopup = AlertDialogPrimitive.Popup;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return <DialogPrimitive.Backdrop data-slot="dialog-overlay" className={cn("wn-anim-fade fixed inset-0 z-(--z-modal) bg-scrim", className as string)} {...props} />;
}

/** Panneau : centré (modal) ou latéral droit de 420 px (sheet). */
export const POPUP_CLASS = {
  modal: "wn-anim-pop fixed top-1/2 left-1/2 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-lg shadow-popover",
  sheet: "wn-anim-slide fixed inset-y-0 right-0 h-full w-[420px] max-w-full shadow-drawer",
} as const;

export function DialogPopup({ className, ...props }: ComponentProps<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Popup
      data-slot="dialog-content"
      className={cn("z-(--z-modal) flex flex-col overflow-hidden border border-solid border-input bg-popover text-body text-popover-foreground outline-none", className as string)}
      {...props}
    />
  );
}
