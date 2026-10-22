// Bascule shadcn/ui sur le Switch de Base UI (RT-037) : un bouton `role="switch"` dont le nom est le texte placé dedans, avec la
// piste et le curseur à gauche du libellé. Piste teintée de l'accent quand elle est active, contour de focus au clavier.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

export function Switch({ className, children, ...props }: Omit<SwitchPrimitive.Root.Props, "nativeButton" | "render">) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch" nativeButton render={<button type="button" />}
      className={cn(
        "group/switch inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 font-[inherit] text-body text-foreground outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className as string,
      )}
      {...props}
    >
      <span aria-hidden="true" className="inline-flex h-4 w-7 flex-none items-center rounded-full bg-input p-0.5 transition-colors duration-(--duration-fast) group-data-[checked]/switch:bg-primary">
        <SwitchPrimitive.Thumb className="block size-3 rounded-full bg-background transition-transform duration-(--duration-fast) data-[checked]:translate-x-3" />
      </span>
      {children}
    </SwitchPrimitive.Root>
  );
}
