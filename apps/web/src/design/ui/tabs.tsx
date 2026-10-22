// Onglets shadcn/ui sur le Tabs de Base UI (RT-037) : style souligné des tokens WNEXT (couleurs par les alias sémantiques),
// gestion du clavier par Base UI (flèches, Début, Fin, focus itinérant). `activateOnFocus` : une flèche sélectionne et
// déplace le focus, comme les onglets natifs qu'ils remplacent.
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "cn";

export function Tabs(props: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List data-slot="tabs-list" activateOnFocus className={cn("flex gap-1", className as string)} {...props} />;
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "cursor-pointer border-0 border-b-2 border-solid border-transparent bg-transparent px-3 py-2 font-[inherit] text-body text-muted-foreground outline-none transition-colors duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[active]:border-primary data-[active]:font-semibold data-[active]:text-foreground",
        className as string,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn("outline-none", className as string)} {...props} />;
}
