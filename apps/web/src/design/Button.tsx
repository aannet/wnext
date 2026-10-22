// Bouton des pieds de fenêtre et des barres : primaire, secondaire, danger, lien de tableau. Repose sur le bouton shadcn/ui (design/ui/button,
// ADR-010) ; l'API reste celle des écrans existants (variant primary | secondary | danger | link).
import type { ButtonHTMLAttributes, Ref } from "react";
import { UiButton } from "./ui/button";

export type ButtonVariant = "primary" | "secondary" | "danger" | "link";

const VARIANT = { primary: "default", secondary: "outline", danger: "destructive", link: "link" } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** « sm » : actions de ligne et « Réessayer » dans un message (28 px). */
  size?: "default" | "sm";
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", size = "default", type = "button", ...rest }: ButtonProps) {
  return <UiButton variant={VARIANT[variant]} size={size} type={type} {...rest} />;
}
