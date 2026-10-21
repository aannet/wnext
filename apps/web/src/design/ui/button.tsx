// Bouton shadcn/ui (style base-nova, socle Base UI, ADR-010), adapté aux tokens WNEXT : couleurs par les alias sémantiques
// de tokens.css, tailles sur --control-*, corps de texte --text-body. Variante « destructive » pleine (texte blanc, 5,9:1)
// plutôt que teintée, pour garder la lisibilité des confirmations BR-04 / BR-10 / BR-31.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-solid border-transparent font-[inherit] text-body font-medium whitespace-nowrap transition-colors duration-(--duration-fast) outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover",
        outline: "border-input bg-background text-foreground hover:bg-muted aria-expanded:bg-muted aria-pressed:border-foreground aria-pressed:bg-muted aria-pressed:font-semibold",
        ghost: "bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted",
        destructive: "border-destructive bg-destructive text-destructive-foreground hover:border-destructive-hover hover:bg-destructive-hover",
      },
      size: {
        default: "min-h-(--control-default) px-3",
        sm: "min-h-(--control-dense) px-2",
        icon: "size-(--control-default) p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type UiButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export function UiButton({ className, variant, size, ...props }: UiButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className as string)} {...props} />;
}
