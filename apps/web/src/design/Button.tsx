// Bouton des pieds de fenêtre et des barres : primaire, secondaire, danger. Repose sur le bouton shadcn/ui (design/ui/button,
// ADR-010) ; l'API reste celle des écrans existants (variant primary | secondary | danger).
import type { ButtonHTMLAttributes } from "react";
import { UiButton } from "./ui/button";

export type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANT = { primary: "default", secondary: "outline", danger: "destructive" } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: ButtonVariant }

export function Button({ variant = "secondary", type = "button", ...rest }: ButtonProps) {
  return <UiButton variant={VARIANT[variant]} type={type} {...rest} />;
}
