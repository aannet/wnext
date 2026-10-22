// Groupe de boutons radio shadcn/ui sur le RadioGroup et le Radio de Base UI (RT-037). Base UI gère les flèches (avec retour au
// début) et le focus itinérant, mais pas Début / Fin : le groupe les ajoute, le focus suit le choix comme pour les flèches.
// Trois présentations d'un choix : « dot » (rond avec libellé, formulaires), « segment » (bouton d'un groupe segmenté),
// « bare » (aucun style : la pastille de couleur du projet habille elle-même son bouton).
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "cn";
import type { KeyboardEvent } from "react";

export function RadioGroup({ className, onKeyDown, ...props }: RadioGroupPrimitive.Props) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    (onKeyDown as ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined)?.(e);
    if (e.defaultPrevented || (e.key !== "Home" && e.key !== "End")) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]:not([aria-disabled=true])")];
    const target = e.key === "Home" ? items[0] : items.at(-1);
    if (!target) return;
    e.preventDefault();
    target.click();
    target.focus();
  };
  return <RadioGroupPrimitive data-slot="radio-group" className={cn(className as string)} onKeyDown={onKey} {...props} />;
}

const VARIANT = {
  dot: "size-4 flex-none cursor-pointer rounded-full border border-solid border-input bg-background outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[checked]:border-primary data-[disabled]:cursor-default data-[disabled]:opacity-50",
  segment: "cursor-pointer border-0 border-l border-solid border-input bg-background px-3 py-1 font-[inherit] text-body text-foreground outline-none first:border-l-0 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring data-[checked]:bg-primary data-[checked]:font-medium data-[checked]:text-primary-foreground",
  bare: "outline-none",
} as const;

export interface RadioItemProps extends RadioPrimitive.Root.Props {
  variant?: keyof typeof VARIANT;
}

export function RadioItem({ variant = "dot", className, children, ...props }: RadioItemProps) {
  return (
    <RadioPrimitive.Root data-slot="radio-item" className={cn("inline-flex items-center justify-center", VARIANT[variant], className as string)} {...props}>
      {variant === "dot" ? <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" /> : children}
    </RadioPrimitive.Root>
  );
}
