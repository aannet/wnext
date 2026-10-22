// Menu shadcn/ui sur le Menu de Base UI (RT-037) : menu de l'avatar (ancré à son bouton) et menu contextuel d'un bloc (ancré à
// un point). Base UI gère flèches, typeahead, Échap, clic extérieur et retour du focus au déclencheur ; le premier élément
// prend le focus à l'ouverture, comme les menus natifs qu'il remplace (Base UI ne le fait qu'à l'ouverture au clavier).
// Survol et focus : fond d'encre et texte blanc (jamais d'éclaircissement, axe).
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { useLayoutEffect, useState } from "react";

export type MenuPoint = { x: number; y: number };

/** Ancre virtuelle d'un point de la fenêtre : ce que Base UI attend d'un élément de référence. */
const virtual = ({ x, y }: MenuPoint) => ({
  getBoundingClientRect: () => ({ x, y, left: x, top: y, width: 0, height: 0, right: x, bottom: y, toJSON: () => ({ x, y }) }),
});

export function DropdownMenu({ modal = false, ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root modal={modal} {...props} />;
}

export function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

export interface DropdownMenuContentProps extends MenuPrimitive.Popup.Props {
  /** Point d'ancrage (menu contextuel) ; absent : le déclencheur du menu. */
  point?: MenuPoint;
  align?: "start" | "center" | "end";
}

export function DropdownMenuContent({ point, align = "end", className, children, ...props }: DropdownMenuContentProps) {
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { popup?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true }); }, [popup]);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner {...(point ? { anchor: virtual(point) } : {})} side="bottom" align={align} sideOffset={point ? 0 : 8} collisionPadding={8} positionMethod="fixed" className="z-(--z-menu)">
        <MenuPrimitive.Popup
          ref={setPopup} data-slot="dropdown-menu-content"
          className={cn("min-w-[200px] overflow-hidden rounded-lg border border-solid border-border-strong bg-popover py-1 text-body text-popover-foreground shadow-popover outline-none", className as string)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn("block w-full cursor-pointer px-3 py-1.5 text-left text-body outline-none data-[highlighted]:bg-focus data-[highlighted]:text-on-focus", className as string)}
      {...props}
    />
  );
}

export function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" className={cn("m-0 border-0 border-b border-solid border-border px-3 py-2 text-label text-muted-foreground", className as string)} {...props} />;
}
